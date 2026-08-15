import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GenerationDispatchError,
  MAX_ACCEPTED_RESPONSE_BYTES,
  createSubscriptionAdapter,
  dispatchGeneration,
  executeGenerationCli,
  loadProviderEnvironment,
} from "./generation-dispatch.mjs";
import { executeCli, resolveReceiptSinks, run, writeApiDispatchReceipts } from "./dispatch.mjs";
import { VENDORS } from "./vendor-policy.mjs";
import { formatProbeTable, runProviderProbe, validateProbeConfig } from "./provider-probe.mjs";

const roots = [];
function temporaryRoot(label) {
  const root = join(tmpdir(), `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function memoryWriter() {
  let data = "";
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { data += String(chunk); callback(); } }),
    value: () => data,
  };
}

function rows(path) {
  return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function request(overrides = {}) {
  return {
    schema_version: 1,
    operation: "generate",
    provider: "nvidia_nim",
    model: "fixture/model",
    user: "Return the fixture word.",
    max_completion_tokens: 73,
    max_retries: 0,
    timeout_seconds: 120,
    ...overrides,
  };
}

function environment(overrides = {}) {
  return { NVIDIA_NIM_API_KEY: "fixture-credential", ...overrides };
}

function successfulResult(model = "fixture/model") {
  return {
    text: "fixture",
    model,
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    finishReason: "stop",
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

async function rejected(action) {
  try { await action(); }
  catch (error) { return error; }
  assert.fail("expected rejection");
}

function fakeChild(handler) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.kill = () => true;
  queueMicrotask(() => { child.emit("spawn"); handler(child); });
  return child;
}

function sseResponse(events) {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n`).join("")}data: [DONE]\n`);
}

async function observedOutcome(action) {
  try {
    const result = await action();
    return { kind: "content", attempts: result.attempts, text: result.text };
  } catch (error) {
    return {
      kind: error.failureClass === "vendor-error" ? "empty" : "nontext",
      attempts: error.attempts,
      failureClass: error.failureClass,
    };
  }
}

test("C-1: only the requested provider is touched, endpoint egress is pinned, and model mismatch fails closed", async () => {
  let calls = 0;
  const result = await dispatchGeneration(request(), {
    env: environment({ OPENROUTER_API_KEY: "must-not-be-used", GEMINI_API_KEY: "must-not-be-used" }),
    openAiAdapter: async (config) => {
      calls += 1;
      assert.equal(config.provider, "nvidia_nim");
      return successfulResult();
    },
    subscriptionAdapter: async () => assert.fail("another provider must not spawn"),
  });
  assert.equal(calls, 1);
  assert.equal(result.provider, "nvidia_nim");

  let observed;
  await dispatchGeneration(request(), {
    env: environment(),
    fetch: async (url, init) => {
      observed = { url, init };
      return jsonResponse({ model: "fixture/model", choices: [{ message: { content: "fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    },
  });
  assert.match(observed.url, /^https:\/\/integrate\.api\.nvidia\.com\/v1\/chat\/completions$/);
  assert.equal(observed.init.redirect, "error");
  assert.equal(JSON.parse(observed.init.body).model, "fixture/model");

  let untrustedFetches = 0;
  const badBase = await rejected(() => dispatchGeneration(request(), {
    env: environment({ NVIDIA_NIM_BASE_URL: "https://attacker.invalid/v1" }),
    fetch: async () => { untrustedFetches += 1; },
  }));
  assert.equal(badBase.failureClass, "bad-invocation");
  assert.equal(untrustedFetches, 0);

  const mismatch = await rejected(() => dispatchGeneration(request(), {
    env: environment(), openAiAdapter: async () => successfulResult("substituted/model"),
  }));
  assert.equal(mismatch.code, "model_mismatch");
  assert.equal(mismatch.attempts, 1);
});

test("H-5 C-1/C-4 observes separate connect/read deadlines and Gemini redirect refusal at runtime", async () => {
  const delays = [];
  const immediateTimer = (callback, milliseconds) => {
    delays.push(milliseconds);
    queueMicrotask(callback);
    return { unref() {} };
  };
  const abortingFetch = async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  const connectError = await rejected(() => dispatchGeneration(request({ timeout_seconds: 3600 }), {
    env: environment(), fetch: abortingFetch, setTimeout: immediateTimer,
  }));
  assert.equal(connectError.code, "connect_timeout");
  assert.equal(delays[0], 30_000);

  const stalledResponse = {
    ok: true,
    body: { getReader: () => ({ read: async () => await new Promise(() => {}), cancel: async () => {} }) },
  };
  const readError = await rejected(() => dispatchGeneration(request({ timeout_seconds: 3600 }), {
    env: environment(), fetch: async () => stalledResponse, setTimeout: immediateTimer,
  }));
  assert.equal(readError.code, "read_timeout");
  assert.equal(delays.includes(120_000), true);
  assert.notEqual(30_000, 120_000);

  let geminiInit;
  const gemini = await dispatchGeneration(request({ provider: "gemini" }), {
    env: { GEMINI_API_KEY: "fixture-credential" },
    fetch: async (_url, init) => {
      geminiInit = init;
      return jsonResponse({
        modelVersion: "fixture/model",
        candidates: [{ content: { parts: [{ text: "fixture" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      });
    },
  });
  assert.equal(gemini.text, "fixture");
  assert.equal(geminiInit.redirect, "error");
});

test("C-2: retry count, permanent classification, exponential waits, and Retry-After are enforced", async () => {
  let clock = 0;
  let calls = 0;
  const result = await dispatchGeneration(request({ max_retries: 5 }), {
    env: environment(), now: () => clock, sleep: async (milliseconds) => { clock += milliseconds + 7; },
    openAiAdapter: async () => {
      calls += 1;
      if (calls === 1) throw new GenerationDispatchError("rate", { statusCode: 429, retryable: true, retryAfterMs: 3_000, failureClass: "rate-limited", failureActor: "vendor", remedy: "wait" });
      if (calls === 2) throw new GenerationDispatchError("server", { statusCode: 503, retryable: true, failureClass: "vendor-error", failureActor: "vendor", remedy: "wait" });
      return successfulResult();
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.receiptMeta.attemptLog.map(({ attempt, waitedMs, outcome }) => ({ attempt, waitedMs, outcome })), [
    { attempt: 1, waitedMs: 0, outcome: "failure" },
    { attempt: 2, waitedMs: 3007, outcome: "failure" },
    { attempt: 3, waitedMs: 4007, outcome: "success" },
  ]);

  for (const fixture of [
    async () => { throw new GenerationDispatchError("bad", { statusCode: 400, retryable: true, failureClass: "bad-invocation", failureActor: "caller", remedy: "fix" }); },
    async () => { throw new GenerationDispatchError("malformed", { code: "invalid_response", failureClass: "invalid-response", failureActor: "vendor", remedy: "inspect" }); },
  ]) {
    let permanentCalls = 0;
    const error = await rejected(() => dispatchGeneration(request({ max_retries: 16 }), {
      env: environment(), sleep: async () => {}, openAiAdapter: async (...args) => { permanentCalls += 1; return fixture(...args); },
    }));
    assert.equal(permanentCalls, 1);
    assert.equal(error.attempts, 1);
  }

  let cappedCalls = 0;
  const capped = await rejected(() => dispatchGeneration(request({ max_retries: 2 }), {
    env: environment(), sleep: async () => {},
    openAiAdapter: async () => { cappedCalls += 1; throw new GenerationDispatchError("server", { statusCode: 500, failureClass: "vendor-error", failureActor: "vendor", remedy: "wait" }); },
  }));
  assert.equal(cappedCalls, 3);
  assert.equal(capped.attempts, 3);

  let capClock = 0;
  let capCalls = 0;
  const cappedBackoff = await dispatchGeneration(request({ max_retries: 6, timeout_seconds: 3600 }), {
    env: environment(), now: () => capClock, sleep: async (milliseconds) => { capClock += milliseconds; },
    openAiAdapter: async () => {
      capCalls += 1;
      if (capCalls <= 6) throw new GenerationDispatchError("server", { statusCode: 500, failureClass: "vendor-error", failureActor: "vendor", remedy: "wait" });
      return successfulResult();
    },
  });
  assert.deepEqual(cappedBackoff.receiptMeta.attemptLog.map((row) => row.waitedMs), [0, 2000, 4000, 8000, 16000, 32000, 60000]);
});

test("C-3: preflight warns and the absolute deadline prevents an impossible retry", async () => {
  let clock = 0;
  let calls = 0;
  let slept = 0;
  const stderr = memoryWriter();
  const error = await rejected(() => dispatchGeneration(request({ timeout_seconds: 1, max_retries: 5 }), {
    env: environment(), stderr: stderr.stream, now: () => clock,
    sleep: async (milliseconds) => { slept += milliseconds; clock += milliseconds; },
    openAiAdapter: async () => {
      calls += 1;
      clock += 800;
      throw new GenerationDispatchError("network", { code: "network_error", retryable: true, failureClass: "vendor-error", failureActor: "vendor", remedy: "retry" });
    },
  }));
  assert.match(stderr.value(), /retry plan worst-case .* exceeds timeout_seconds=1s/);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
  assert.ok(clock <= 1000);
  assert.equal(error.attempts, 1);

  const wallStarted = Date.now();
  const wallError = await rejected(() => dispatchGeneration(request({ timeout_seconds: 1 }), {
    env: environment(), stderr: memoryWriter().stream,
    openAiAdapter: async () => await new Promise(() => {}),
  }));
  const elapsed = Date.now() - wallStarted;
  assert.equal(wallError.failureClass, "no-output-timeout");
  assert.ok(elapsed >= 900 && elapsed < 1600, `wall-clock deadline elapsed=${elapsed}ms`);
});

test("C-4: every exercised failure has the triple and 401/403 bind auth-failed to user", async () => {
  const validationStderr = memoryWriter();
  assert.equal(await executeGenerationCli([], { stderr: validationStderr.stream }), 2);
  assert.match(validationStderr.value(), /class=bad-invocation actor=caller remedy=/);
  for (const status of [401, 403]) {
    const error = await rejected(() => dispatchGeneration(request(), {
      env: environment(), fetch: async () => new Response("secret body", { status }),
    }));
    assert.equal(error.failureClass, "auth-failed");
    assert.equal(error.failureActor, "user");
    assert.equal(typeof error.remedy, "string");
  }
  const cases = [
    () => dispatchGeneration(request({ provider: "not_a_provider" }), { env: environment() }),
    () => dispatchGeneration(request(), { env: environment(), openAiAdapter: async () => { throw new Error("opaque"); } }),
  ];
  for (const action of cases) {
    const error = await rejected(action);
    assert.equal(typeof error.failureClass, "string");
    assert.equal(typeof error.failureActor, "string");
    assert.equal(typeof error.remedy, "string");
  }
});

test("H-6 distinguishes payload incompatibility and does not blame callers for 404/410", async () => {
  for (const status of [404, 410]) {
    const error = await rejected(() => dispatchGeneration(request({ max_retries: 16 }), {
      env: environment(), fetch: async () => new Response("unavailable", { status }), sleep: async () => {},
    }));
    assert.equal(error.failureClass, "model-unavailable");
    assert.equal(error.failureActor, "vendor");
    assert.notEqual(error.failureActor, "caller");
    assert.equal(error.attempts, 1);
  }
  for (const status of [400, 422]) {
    let calls = 0;
    const error = await rejected(() => dispatchGeneration(request({ max_retries: 16 }), {
      env: environment(),
      sleep: async () => {},
      fetch: async () => { calls += 1; return new Response("payload rejected", { status }); },
    }));
    assert.equal(error.failureClass, "payload-incompatible");
    assert.equal(error.failureActor, "dispatcher");
    assert.equal(error.retryable, false);
    assert.equal(error.attempts, 1);
    assert.equal(calls, 1, "an unchanged incompatible payload must not consume retries");
  }

  const root = temporaryRoot("second-opinion-h11-status-code");
  const requestPath = join(root, "request.json");
  const responsePath = join(root, "response.json");
  writeFileSync(requestPath, JSON.stringify(request()), "utf8");
  assert.equal(await executeGenerationCli(["--request-json", requestPath, "--response-json", responsePath], {
    env: environment(), stderr: memoryWriter().stream, fetch: async () => new Response("gone", { status: 410 }),
  }), 4);
  const payload = JSON.parse(readFileSync(responsePath, "utf8"));
  assert.equal(payload.statusCode, 410);
  assert.equal(payload.failureClass, "model-unavailable");
});

test("H-6 contamination map permanently covers six boundaries by three shapes plus two Gemini specials", async (t) => {
  const usageOpenAi = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
  const usageGemini = { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 };
  const clocked = () => {
    let clock = 0;
    return { now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; } };
  };
  const invoke = {
    "1-sse": async (shape) => dispatchGeneration(request({ stream: true, max_retries: 2, timeout_seconds: 3600 }), {
      env: environment(), ...clocked(),
      fetch: async () => sseResponse([{
        model: "fixture/model",
        choices: [{ delta: shape === "content" ? { content: "fixture" } : shape === "empty" ? { content: "" } : {}, finish_reason: "stop" }],
        usage: usageOpenAi,
      }]),
    }),
    "2-openai-nonstream": async (shape) => dispatchGeneration(request({ max_retries: 2, timeout_seconds: 3600 }), {
      env: environment(), ...clocked(),
      fetch: async () => jsonResponse({
        model: "fixture/model",
        choices: [{ message: shape === "content" ? { content: "fixture" } : shape === "empty" ? { content: "" } : { content: null }, finish_reason: "stop" }],
        usage: usageOpenAi,
      }),
    }),
    "3-gemini-extraction": async (shape) => dispatchGeneration(request({ provider: "gemini", stream: true, max_retries: 2, timeout_seconds: 3600 }), {
      env: { GEMINI_API_KEY: "fixture" }, ...clocked(),
      fetch: async () => sseResponse([{
        modelVersion: "fixture/model",
        candidates: [{
          content: shape === "content" ? { parts: [{ text: "fixture" }] } : shape === "empty" ? { parts: [{ text: "" }] } : null,
          finishReason: "STOP",
        }],
        usageMetadata: usageGemini,
      }]),
    }),
    "4-gemini-verdict": async (shape) => dispatchGeneration(request({ provider: "gemini", max_retries: 2, timeout_seconds: 3600 }), {
      env: { GEMINI_API_KEY: "fixture" }, ...clocked(),
      fetch: async () => jsonResponse({
        modelVersion: "fixture/model",
        candidates: [{
          content: shape === "content" ? { parts: [{ text: "fixture" }] } : shape === "empty" ? { parts: [{ text: "" }] } : null,
          finishReason: "STOP",
        }],
        usageMetadata: usageGemini,
      }),
    }),
    "5-coordinator": async (shape) => dispatchGeneration(request({ max_retries: 2, timeout_seconds: 3600 }), {
      env: environment(), ...clocked(),
      openAiAdapter: async () => ({
        ...successfulResult(),
        text: shape === "content" ? "fixture" : shape === "empty" ? "" : undefined,
      }),
    }),
    "6-subscription": async (shape) => {
      const adapter = createSubscriptionAdapter(async (options, deps) => {
        if (shape !== "nontext") writeFileSync(options.out, shape === "content" ? "fixture" : "", "utf8");
        writeFileSync(deps.internalReceiptPath, `${JSON.stringify({
          vendorUsage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        })}\n`, "utf8");
        return 0;
      });
      return await dispatchGeneration(request({ provider: "codex", max_retries: 2, timeout_seconds: 3600 }), {
        env: {}, ...clocked(), subscriptionAdapter: adapter,
      });
    },
  };
  const cells = [];
  for (const [point, action] of Object.entries(invoke)) {
    for (const shape of ["content", "empty", "nontext"]) {
      cells.push({ point, shape, action: () => action(shape) });
    }
  }
  cells.push({
    point: "special-gemini-mixed-parts",
    shape: "content",
    action: async () => dispatchGeneration(request({ provider: "gemini", max_retries: 2, timeout_seconds: 3600 }), {
      env: { GEMINI_API_KEY: "fixture" }, ...clocked(),
      fetch: async () => jsonResponse({
        modelVersion: "fixture/model",
        candidates: [{ content: { parts: [{ text: "Paris" }, { inlineData: { mimeType: "text/plain" } }] }, finishReason: "STOP" }],
        usageMetadata: usageGemini,
      }),
    }),
  });
  cells.push({
    point: "special-gemini-empty-parts",
    shape: "empty",
    action: async () => dispatchGeneration(request({ provider: "gemini", max_retries: 2, timeout_seconds: 3600 }), {
      env: { GEMINI_API_KEY: "fixture" }, ...clocked(),
      fetch: async () => jsonResponse({
        modelVersion: "fixture/model",
        candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
        usageMetadata: usageGemini,
      }),
    }),
  });
  assert.equal(cells.length, 20);
  for (const cell of cells) {
    await t.test(`${cell.point}/${cell.shape}`, async () => {
      const observed = await observedOutcome(cell.action);
      assert.equal(observed.kind, cell.shape);
      assert.equal(observed.attempts, cell.shape === "empty" ? 3 : 1);
      if (cell.point === "special-gemini-mixed-parts") assert.equal(observed.text, "Paris");
      if (cell.shape === "nontext") assert.notEqual(observed.failureClass, "vendor-error");
    });
  }
});

test("C-5: API completion limits remain byte-for-byte constant and CLI receipts declare non-application", async () => {
  const observed = [];
  let calls = 0;
  await dispatchGeneration(request({ max_completion_tokens: 987, max_retries: 2 }), {
    env: environment(), sleep: async () => {},
    openAiAdapter: async (_config, value) => {
      observed.push(value.maxCompletionTokens);
      calls += 1;
      if (calls < 3) throw new GenerationDispatchError("server", { statusCode: 500, failureClass: "vendor-error", failureActor: "vendor", remedy: "retry" });
      return successfulResult();
    },
  });
  assert.deepEqual(observed, [987, 987, 987]);

  let subscriptionOptions;
  const adapter = createSubscriptionAdapter(async (options) => {
    subscriptionOptions = options;
    writeFileSync(options.out, "fixture", "utf8");
    writeFileSync(options.receipt ?? join(dirname(options.out), "receipt.jsonl"), `${JSON.stringify({ vendorUsage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } })}\n`, "utf8");
    return 0;
  });
  await adapter({ provider: "codex", model: "fixture/model" }, { system: "", user: "x", maxCompletionTokens: 987, timeoutSeconds: 10, lensId: null }, { env: {} });
  assert.deepEqual(subscriptionOptions.completionTokenLimit, { requested: 987, status: "not-applicable-cli" });
});

test("C-6/C-7/C-8: HTTP raw and portable receipts carry attempts, transport identity, and lens identity", async () => {
  const root = temporaryRoot("second-opinion-http-receipts");
  const requestPath = join(root, "request.json");
  const responsePath = join(root, "response.json");
  const raw = join(root, "raw.jsonl");
  const portable = join(root, "portable.jsonl");
  writeFileSync(requestPath, JSON.stringify(request({ lens_id: "lens-fixture", max_retries: 1 })), "utf8");
  const stderr = memoryWriter();
  let clock = 0;
  let fetches = 0;
  const status = await executeGenerationCli(["--request-json", requestPath, "--response-json", responsePath], {
    env: environment({ SECOND_OPINION_RECEIPT: raw, SECOND_OPINION_PORTABLE_RECEIPT: portable }),
    stderr: stderr.stream,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    fetch: async () => {
      fetches += 1;
      return fetches === 1 ? new Response("temporary", { status: 500 })
        : jsonResponse({ model: "fixture/model", choices: [{ message: { content: "fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    },
  });
  assert.equal(status, 0, stderr.value());
  const [rawRow] = rows(raw);
  const [portableRow] = rows(portable);
  for (const row of [rawRow, portableRow]) {
    assert.equal(row.transport, "api");
    assert.equal(row.vendor, null);
    assert.equal(row.provider, "nvidia_nim");
    assert.equal(row.lensId, "lens-fixture");
    assert.equal(row.attempts, 2);
    assert.deepEqual(row.attemptWaitsMs, [0, 2000]);
    assert.equal(row.successfulAttempt, 2);
  }
  assert.equal(rawRow.pid, null);
  assert.equal(rawRow.argv, null);
  assert.equal(rawRow.executable, null);
  assert.deepEqual(VENDORS, ["codex", "agy", "claude"]);

  const brief = join(root, "brief.md");
  const cliRaw = join(root, "cli-raw.jsonl");
  const cliPortable = join(root, "cli-portable.jsonl");
  writeFileSync(brief, "fixture", "utf8");
  assert.equal(await executeCli(["--vendor", "codex", "--operation", "text", "--brief", brief, "--lens-id", "cli-lens", "--dry-run"], {
    cwd: root, stderr: memoryWriter().stream, env: { SECOND_OPINION_RECEIPT: cliRaw, SECOND_OPINION_PORTABLE_RECEIPT: cliPortable },
  }), 0);
  for (const row of [rows(cliRaw)[0], rows(cliPortable)[0]]) {
    assert.equal(row.transport, "cli");
    assert.equal(row.vendor, "codex");
    assert.equal(row.provider, null);
    assert.equal(row.lensId, "cli-lens");
  }

  const nullRaw = join(root, "null-raw.jsonl");
  const nullPortable = join(root, "null-portable.jsonl");
  writeApiDispatchReceipts(memoryWriter().stream, {
    provider: "nvidia_nim", model: "fixture/model", attempts: 1,
    attemptLog: [{ attempt: 1, waitedMs: 0, outcome: "success", failureClass: null }],
    successfulAttempt: 1, maxCompletionTokens: 73, usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }, 0, Date.now(), { SECOND_OPINION_RECEIPT: nullRaw, SECOND_OPINION_PORTABLE_RECEIPT: nullPortable });
  assert.equal(rows(nullRaw)[0].lensId, null);
  assert.equal(rows(nullPortable)[0].lensId, null);
});

test("H-1/H-2 receipts place requested and executed evidence side by side", async () => {
  const root = temporaryRoot("second-opinion-h11-evidence");
  const requestPath = join(root, "request.json");
  const responsePath = join(root, "response.json");
  const apiRaw = join(root, "api-raw.jsonl");
  const apiPortable = join(root, "api-portable.jsonl");
  const system = "system-한글";
  const user = "user-🙂";
  writeFileSync(requestPath, JSON.stringify(request({
    system,
    user,
    prompt_source: "lens-body/contract-v4",
  })), "utf8");
  assert.equal(await executeGenerationCli(["--request-json", requestPath, "--response-json", responsePath], {
    env: environment({ SECOND_OPINION_RECEIPT: apiRaw, SECOND_OPINION_PORTABLE_RECEIPT: apiPortable }),
    stderr: memoryWriter().stream,
    fetch: async () => jsonResponse({
      model: "fixture/model",
      choices: [{ message: { content: "fixture" }, finish_reason: "length" }],
      incomplete_details: { reason: "max_output_tokens" },
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
  }), 0);
  const response = JSON.parse(readFileSync(responsePath, "utf8"));
  assert.equal(response.finish_reason, "length");
  assert.equal(response.finishReason, null);
  assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(response.truncated_suspected, true);

  const expectedPromptBytes = Buffer.byteLength(`${system}${user}`, "utf8");
  for (const row of [rows(apiRaw)[0], rows(apiPortable)[0]]) {
    assert.equal(row.modelReported, "observed");
    assert.equal(row.effortRequested, null);
    assert.equal(row.truncatedSuspected, true);
    assert.equal(row.promptSource, "lens-body/contract-v4");
    assert.equal(row.promptBytes, expectedPromptBytes);
    assert.equal(row.finish_reason, "length");
    assert.equal(row.finishReason, null);
    assert.deepEqual(row.incomplete_details, { reason: "max_output_tokens" });
    assert.equal(row.attempts, response.attempts);
  }

  const noUsageRequest = join(root, "no-usage-request.json");
  const noUsageResponse = join(root, "no-usage-response.json");
  const noUsageRaw = join(root, "no-usage-raw.jsonl");
  const noUsagePortable = join(root, "no-usage-portable.jsonl");
  writeFileSync(noUsageRequest, JSON.stringify(request()), "utf8");
  assert.equal(await executeGenerationCli(["--request-json", noUsageRequest, "--response-json", noUsageResponse], {
    env: environment({ SECOND_OPINION_RECEIPT: noUsageRaw, SECOND_OPINION_PORTABLE_RECEIPT: noUsagePortable }),
    stderr: memoryWriter().stream,
    fetch: async () => jsonResponse({
      model: "fixture/model",
      choices: [{ message: { content: "attributed without usage" }, finish_reason: "stop" }],
    }),
  }), 0);
  assert.equal(JSON.parse(readFileSync(noUsageResponse, "utf8")).usage, null);
  for (const row of [rows(noUsageRaw)[0], rows(noUsagePortable)[0]]) {
    assert.equal(row.modelReported, "observed");
    assert.equal(row.vendorUsage, null);
    assert.equal(row.vendorUsageStatus, "not-reported");
  }

  const brief = join(root, "brief.md");
  const cliRaw = join(root, "cli-raw.jsonl");
  const cliPortable = join(root, "cli-portable.jsonl");
  writeFileSync(brief, "fixture", "utf8");
  const stdout = memoryWriter();
  assert.equal(await executeCli([
    "--vendor", "codex", "--operation", "text", "--brief", brief,
    "--model", "fixture-model", "--effort", "light", "--dry-run",
  ], {
    cwd: root,
    stdout: stdout.stream,
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: cliRaw, SECOND_OPINION_PORTABLE_RECEIPT: cliPortable },
  }), 0);
  const cliRow = rows(cliRaw)[0];
  assert.equal(cliRow.effortRequested, "light");
  assert.equal(cliRow.effort, "low");
  assert.equal(cliRow.modelReported, "none");
  assert.equal(cliRow.executable, "codex");
  assert.deepEqual(cliRow.argv, JSON.parse(stdout.value()).argv);
  assert.equal(cliRow.promptBytes, 0, "dry-run transmits no prompt bytes");
  const apiRow = rows(apiRaw)[0];
  assert.deepEqual(Object.keys(cliRow).sort(), Object.keys(apiRow).sort(), "raw cli/api key sets");
  assert.equal(apiRow.executable, null);
  assert.equal(apiRow.argv, null);
  for (const row of [cliRow, apiRow]) assert.equal(row.executable === null, row.transport === "api");
  for (const locator of ["argv", "executable"]) assert.equal(Object.hasOwn(rows(cliPortable)[0], locator), false);
});

test("H-2 argv evidence is measured and credential-redacted in every observable sink", async () => {
  const root = temporaryRoot("second-opinion-h11-argv-redaction");
  const brief = join(root, "brief.md");
  const raw = join(root, "raw.jsonl");
  const portable = join(root, "portable.jsonl");
  const sentinel = "R033_H11_ARGV_SECRET_8f5d6c4b";
  writeFileSync(brief, "fixture", "utf8");
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  assert.equal(await executeCli([
    "--vendor", "codex", "--operation", "text", "--brief", brief,
    "--model", sentinel, "--effort", "high", "--dry-run",
  ], {
    cwd: root,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      H11_TEST_API_KEY: sentinel,
      SECOND_OPINION_RECEIPT: raw,
      SECOND_OPINION_PORTABLE_RECEIPT: portable,
    },
  }), 0);
  for (const sink of [stdout.value(), stderr.value(), readFileSync(raw, "utf8"), readFileSync(portable, "utf8")]) {
    assert.equal(sink.includes(sentinel), false);
  }
  assert.equal(rows(raw)[0].argv.includes("[REDACTED]"), true);
});

test("H-1 budget rejection keeps response and receipt attempts equal", async () => {
  const root = temporaryRoot("second-opinion-h11-attempts");
  const requestPath = join(root, "request.json");
  const responsePath = join(root, "response.json");
  const raw = join(root, "raw.jsonl");
  writeFileSync(requestPath, JSON.stringify(request({ budget: { max_attempts: 1 } })), "utf8");
  assert.equal(await executeGenerationCli(["--request-json", requestPath, "--response-json", responsePath], {
    env: environment({ SECOND_OPINION_RECEIPT: raw }), stderr: memoryWriter().stream,
  }), 2);
  assert.equal(JSON.parse(readFileSync(responsePath, "utf8")).attempts, 1);
  assert.equal(rows(raw)[0].attempts, 1);
});

test("H-5 C-2 persisted attempt waits are measured rather than copied from the backoff plan", async () => {
  const root = temporaryRoot("second-opinion-h11-measured-waits");
  const requestPath = join(root, "request.json");
  const responsePath = join(root, "response.json");
  const raw = join(root, "raw.jsonl");
  writeFileSync(requestPath, JSON.stringify(request({ max_retries: 1, timeout_seconds: 3600 })), "utf8");
  let clock = 0;
  let calls = 0;
  assert.equal(await executeGenerationCli(["--request-json", requestPath, "--response-json", responsePath], {
    env: environment({ SECOND_OPINION_RECEIPT: raw }),
    stderr: memoryWriter().stream,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds + 11; },
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("temporary", { status: 500 })
        : jsonResponse({
          model: "fixture/model",
          choices: [{ message: { content: "fixture" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
    },
  }), 0);
  const [row] = rows(raw);
  assert.deepEqual(row.attemptWaitsMs, [0, 2011]);
  assert.notDeepEqual(row.attemptWaitsMs, [0, 2000], "planned waits must not masquerade as observed waits");
});

test("C-9: budget is rejected, fallback_chain is absent, and attempts is always present", async () => {
  const root = temporaryRoot("second-opinion-schema");
  const requestPath = join(root, "request.json");
  const responsePath = join(root, "response.json");
  writeFileSync(requestPath, JSON.stringify(request({ budget: { max_attempts: 2 } })), "utf8");
  const status = await executeGenerationCli(["--request-json", requestPath, "--response-json", responsePath], {
    env: environment(), stderr: memoryWriter().stream,
  });
  assert.equal(status, 2);
  const failure = JSON.parse(readFileSync(responsePath, "utf8"));
  assert.equal(failure.error, "invalid_request");
  assert.equal(failure.attempts, 1);
  assert.equal(Object.hasOwn(failure, "fallback_chain"), false);

  const success = await dispatchGeneration(request(), { env: environment(), openAiAdapter: async () => successfulResult() });
  assert.equal(success.attempts, 1);
  assert.equal(Object.hasOwn(success, "fallback_chain"), false);
  for (const invalid of [request({ max_retries: 17 }), request({ lens_id: "x".repeat(65) })]) {
    const error = await rejected(() => dispatchGeneration(invalid, { env: environment() }));
    assert.equal(error.code, "invalid_request");
  }
});

test("C-10: the 16 MiB accepted buffer fails permanently and publishes no losing chunk", async () => {
  let calls = 0;
  const published = [];
  const oversized = "x".repeat(MAX_ACCEPTED_RESPONSE_BYTES + 1);
  const error = await rejected(() => dispatchGeneration(request({ stream: true, max_retries: 16 }), {
    env: environment(), onChunk: (chunk) => published.push(chunk), sleep: async () => {},
    openAiAdapter: async (_config, _request, deps) => {
      calls += 1;
      deps.onChunk(oversized);
      return successfulResult();
    },
  }));
  assert.equal(MAX_ACCEPTED_RESPONSE_BYTES, 16 * 1024 * 1024);
  assert.equal(error.failureClass, "oversized-response");
  assert.equal(calls, 1);
  assert.deepEqual(published, []);
});

test("C-11: receipt resolution is env over config over none and malformed config is fail-open", () => {
  const root = temporaryRoot("second-opinion-config");
  const config = join(root, "config.json");
  const configRaw = join(root, "config-raw.jsonl");
  const configPortable = join(root, "config-portable.jsonl");
  writeFileSync(config, JSON.stringify({ receipt: configRaw, portableReceipt: configPortable }), "utf8");
  assert.deepEqual(resolveReceiptSinks({}, config), { receipt: configRaw, portableReceipt: configPortable });
  const envRaw = join(root, "env-raw.jsonl");
  assert.deepEqual(resolveReceiptSinks({ SECOND_OPINION_RECEIPT: envRaw }, config), { receipt: envRaw, portableReceipt: configPortable });
  writeFileSync(config, "{broken", "utf8");
  assert.deepEqual(resolveReceiptSinks({}, config), { receipt: undefined, portableReceipt: undefined });
  assert.deepEqual(resolveReceiptSinks({}, join(root, "missing.json")), { receipt: undefined, portableReceipt: undefined });

  const home = join(root, "home");
  const homeConfig = join(home, ".second-opinion", "config.json");
  const brief = join(root, "brief.md");
  const configuredReceipt = join(root, "configured.jsonl");
  mkdirSync(dirname(homeConfig), { recursive: true });
  writeFileSync(brief, "fixture", "utf8");
  writeFileSync(configuredReceipt, "preserve", "utf8");
  writeFileSync(homeConfig, JSON.stringify({ receipt: configuredReceipt }), "utf8");
  const cleanEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(cleanEnv)) if (/^SECOND_OPINION_(?:PORTABLE_)?RECEIPT$/i.test(key)) delete cleanEnv[key];
  const dispatchPath = fileURLToPath(new URL("./dispatch.mjs", import.meta.url));
  const collision = spawnSync(process.execPath, [dispatchPath, "--vendor", "codex", "--operation", "text", "--brief", brief, "--out", configuredReceipt, "--dry-run"], { cwd: root, env: cleanEnv, encoding: "utf8" });
  assert.equal(collision.status, 2, collision.stderr);
  assert.equal(readFileSync(configuredReceipt, "utf8"), "preserve");
  writeFileSync(homeConfig, "{broken", "utf8");
  const failOpen = spawnSync(process.execPath, [dispatchPath, "--vendor", "codex", "--operation", "text", "--brief", brief, "--dry-run"], { cwd: root, env: cleanEnv, encoding: "utf8" });
  assert.equal(failOpen.status, 0, failOpen.stderr);
});

test("H-4/H-5 C-6 receipt config is resolved once across present and absent branches", async () => {
  const root = temporaryRoot("second-opinion-h11-config-guard");
  const configPath = join(root, "config.json");
  const safeReceipt = join(root, "safe.jsonl");
  const changedReceipt = join(root, "changed.jsonl");
  const brief = join(root, "brief.md");
  const out = join(root, "out.txt");
  writeFileSync(brief, "fixture", "utf8");
  writeFileSync(configPath, JSON.stringify({ receipt: safeReceipt }), "utf8");
  const mutatePresent = () => fakeChild((child) => {
    writeFileSync(configPath, JSON.stringify({ receipt: changedReceipt }), "utf8");
    child.stdin.on("end", () => queueMicrotask(() => child.emit("close", 0, null)));
    child.stdin.resume();
  });
  assert.equal(await run({
    vendor: "codex", operation: "text", mode: "default", brief, cwd: root,
    model: "fixture", effort: "high", inputs: [], timeout: 2, out, dryRun: false,
  }, {
    spawn: mutatePresent,
    stderr: memoryWriter().stream,
    env: {},
    receiptConfigPath: configPath,
  }), 0);
  assert.equal(rows(safeReceipt).length, 1);
  assert.equal(existsSync(changedReceipt), false, "post-guard config change must not redirect the write");

  rmSync(configPath, { force: true });
  const createdAfterGuard = join(root, "created-after-guard.jsonl");
  const mutateAbsent = () => fakeChild((child) => {
    writeFileSync(configPath, JSON.stringify({ receipt: createdAfterGuard }), "utf8");
    child.stdin.on("end", () => queueMicrotask(() => child.emit("close", 0, null)));
    child.stdin.resume();
  });
  assert.equal(await run({
    vendor: "codex", operation: "text", mode: "default", brief, cwd: root,
    model: "fixture", effort: "high", inputs: [], timeout: 2, dryRun: false,
  }, {
    spawn: mutateAbsent,
    stderr: memoryWriter().stream,
    env: {},
    receiptConfigPath: configPath,
  }), 0);
  assert.equal(existsSync(createdAfterGuard), false, "an absent guarded sink must remain absent for this dispatch");

  const subscriptionSafeReceipt = join(root, "subscription-safe.jsonl");
  const subscriptionChangedReceipt = join(root, "subscription-changed.jsonl");
  const requestPath = join(root, "subscription-request.json");
  const responsePath = join(root, "subscription-response.json");
  const codexHome = join(root, "codex-home");
  const sessionId = "00000000-0000-0000-0000-000000000042";
  const sessionRoot = join(codexHome, "sessions", "2026", "08", "15");
  mkdirSync(sessionRoot, { recursive: true });
  writeFileSync(join(sessionRoot, `rollout-fixture-${sessionId}.jsonl`), `${JSON.stringify({
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 4 } } },
  })}\n`, "utf8");
  writeFileSync(configPath, JSON.stringify({ receipt: subscriptionSafeReceipt }), "utf8");
  writeFileSync(requestPath, JSON.stringify(request({ provider: "codex", model: "gpt-5.6-luna", timeout_seconds: 30 })), "utf8");
  assert.equal(await executeGenerationCli(["--request-json", requestPath, "--response-json", responsePath], {
    env: { CODEX_HOME: codexHome },
    stderr: memoryWriter().stream,
    receiptConfigPath: configPath,
    runSubscription: async (options, runDeps) => {
      writeFileSync(configPath, JSON.stringify({ receipt: subscriptionChangedReceipt }), "utf8");
      return await run(options, {
        ...runDeps,
        receiptConfigPath: configPath,
        spawn: () => fakeChild((child) => {
          child.stdin.on("end", () => {
            child.stdout.end("fixture");
            child.stderr.end(`session id: ${sessionId}\n`);
            queueMicrotask(() => child.emit("close", 0, null));
          });
          child.stdin.resume();
        }),
      });
    },
  }), 0);
  assert.equal(rows(subscriptionSafeReceipt).length, 1, "subscription writes only the generation-approved sink snapshot");
  assert.equal(existsSync(subscriptionChangedReceipt), false, "a post-generation-guard config change must not redirect subscription writes");
});

test("H-7 D-2 contract defaults do not emit the conditional retry-plan warning", async () => {
  const stderr = memoryWriter();
  const result = await dispatchGeneration({
    schema_version: 1,
    operation: "generate",
    provider: "nvidia_nim",
    model: "fixture/model",
    user: "fixture",
  }, {
    env: environment(),
    stderr: stderr.stream,
    openAiAdapter: async () => successfulResult(),
  });
  assert.equal(result.text, "fixture");
  assert.doesNotMatch(stderr.value(), /retry plan worst-case/);
});

test("H-4/H-5 C-5 a real child process keeps the timeout chain alive and returns 124", async () => {
  const root = temporaryRoot("second-opinion-h11-real-timeout");
  const brief = join(root, "brief.md");
  const raw = join(root, "raw.jsonl");
  writeFileSync(brief, "fixture", "utf8");
  let dispatched;
  const spawnActual = (executable, argv, options) => {
    dispatched = { executable, argv };
    return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
  };
  const started = Date.now();
  const exit = await run({
    vendor: "codex", operation: "text", mode: "default", brief, cwd: root,
    model: "fixture", effort: "high", inputs: [], timeout: 1, killGraceMs: 0, reapMs: 500, dryRun: false,
  }, {
    spawn: spawnActual,
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: raw },
  });
  assert.equal(exit, 124);
  assert.ok(Date.now() - started >= 900);
  const timeoutReceipt = rows(raw)[0];
  assert.equal(timeoutReceipt.exit, "timeout");
  assert.equal(timeoutReceipt.executable, dispatched.executable);
  assert.deepEqual(timeoutReceipt.argv, dispatched.argv);
  assert.equal(timeoutReceipt.promptBytes, Buffer.byteLength("fixture", "utf8"));
  assert.ok(timeoutReceipt.argv.length > 0, "the actual CLI axis must be recorded in the receipt");
});

test("H-5 C-8 exit-code assertions distinguish 0, 2, 3, 4, and 124", async () => {
  const root = temporaryRoot("second-opinion-h11-exit-axis");
  const brief = join(root, "brief.md");
  writeFileSync(brief, "fixture", "utf8");
  const base = {
    vendor: "codex", operation: "text", mode: "default", brief, cwd: root,
    model: "fixture", effort: "high", inputs: [], timeout: 1, dryRun: false,
  };
  const exits = [];
  exits.push(await run({ ...base, dryRun: true }, { stderr: memoryWriter().stream, env: {} }));
  exits.push(await executeCli(["--unknown"], { cwd: root, stderr: memoryWriter().stream, env: {} }));
  exits.push(await run(base, {
    spawn: () => { throw Object.assign(new Error("spawn"), { code: "EFAIL" }); },
    stderr: memoryWriter().stream,
    env: {},
  }));
  exits.push(await run({ ...base, mode: "review" }, {
    spawn: () => fakeChild((child) => {
      child.stdin.on("end", () => queueMicrotask(() => child.emit("close", 0, null)));
      child.stdin.resume();
    }),
    stderr: memoryWriter().stream,
    env: {},
  }));
  exits.push(await run({ ...base, killGraceMs: 0, reapMs: 0 }, {
    spawn: () => fakeChild(() => {}),
    stderr: memoryWriter().stream,
    env: {},
  }));
  assert.deepEqual(exits, [0, 2, 3, 4, 124]);
});

test("P0 subprocess generation entrypoint returns invalid_request instead of deadlocking", () => {
  const root = temporaryRoot("second-opinion-generation-entrypoint");
  const home = join(root, "home");
  const requestPath = join(root, "request.json");
  const responsePath = join(root, "response.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(requestPath, JSON.stringify(request({ budget: { max_provider_attempts: 1 } })), "utf8");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (/^SECOND_OPINION_(?:PORTABLE_)?RECEIPT$/i.test(key)) delete env[key];
  const dispatchPath = fileURLToPath(new URL("./dispatch.mjs", import.meta.url));
  const dispatchSource = readFileSync(dispatchPath, "utf8");
  assert.doesNotMatch(dispatchSource, /^\s*await\s+main\s*\(/m, "dispatch entrypoint must not use top-level await");
  assert.match(dispatchSource, /^if \(invokedAsMain\(\)\) main\(\)\.catch\(\(error\) => \{ process\.exitCode = 1; console\.error\(error\); \}\);$/m);
  const result = spawnSync(process.execPath, [dispatchPath, "--request-json", requestPath, "--response-json", responsePath], {
    cwd: root, env, encoding: "utf8", timeout: 10_000, shell: false, windowsHide: true,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  const response = JSON.parse(readFileSync(responsePath, "utf8"));
  assert.equal(response.error, "invalid_request");
  assert.equal(response.failureClass, "bad-invocation");
});

test("GLOBAL-1/H-5 C-7 subprocess CLI receipts preserve the repository-owned 0.9.6 baseline", () => {
  const root = temporaryRoot("second-opinion-cli-entrypoints");
  const home = join(root, "home");
  const configPath = join(home, ".second-opinion", "config.json");
  const brief = join(root, "brief.md");
  const current = fileURLToPath(new URL("./dispatch.mjs", import.meta.url));
  const lensId = "r033-h10-subprocess-lens";
  const fixtures = [
    { vendor: "codex", extra: ["--model", "fixture-codex-model", "--effort", "high"], useConfig: true },
    { vendor: "agy", extra: ["--model", "Gemini 3.5 Flash (High)"], useConfig: false },
    { vendor: "claude", extra: ["--model", "opus", "--effort", "high", "--out", join(root, "claude-out.json"), "--err", join(root, "claude-err.txt")], useConfig: false },
  ];
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(brief, "fixture", "utf8");

  const baseEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(baseEnv)) if (/^SECOND_OPINION_(?:PORTABLE_)?RECEIPT$/i.test(key)) delete baseEnv[key];
  for (const fixture of fixtures) {
    const raw = join(root, `${fixture.vendor}-raw.jsonl`);
    const portable = join(root, `${fixture.vendor}-portable.jsonl`);
    if (fixture.useConfig) writeFileSync(configPath, JSON.stringify({ receipt: raw, portableReceipt: portable }), "utf8");
    const args = ["--vendor", fixture.vendor, "--operation", "text", "--brief", brief, ...fixture.extra, "--lens-id", lensId, "--dry-run"];
    const currentEnv = fixture.useConfig
      ? baseEnv
      : { ...baseEnv, SECOND_OPINION_RECEIPT: raw, SECOND_OPINION_PORTABLE_RECEIPT: portable };
    const actual = spawnSync(process.execPath, [current, ...args], {
      cwd: root, env: currentEnv, encoding: "utf8", timeout: 10_000, shell: false, windowsHide: true,
    });
    assert.equal(actual.status, 0, `${fixture.vendor} current: ${actual.stderr}`);
    const rawRows = rows(raw), portableRows = rows(portable);
    assert.equal(rawRows.length, 1, `${fixture.vendor} raw rows`);
    assert.equal(portableRows.length, 1, `${fixture.vendor} portable rows`);
    const rawRow = rawRows[0], portableRow = portableRows[0];
    const modelIndex = args.indexOf("--model");
    const effortIndex = args.indexOf("--effort");
    const outIndex = args.indexOf("--out");
    const errIndex = args.indexOf("--err");
    const repositoryBaseline = {
      schemaVersion: 1,
      vendor: fixture.vendor,
      operation: "text",
      requestedMode: "default",
      effectiveMode: "default",
      inputProfile: "none",
      modelRequested: modelIndex >= 0 ? args[modelIndex + 1] : null,
      model: modelIndex >= 0 ? args[modelIndex + 1] : null,
      effort: effortIndex >= 0 ? args[effortIndex + 1] : null,
      exit: 0,
      invoked: false,
      cwd: root,
      outPath: outIndex >= 0 ? args[outIndex + 1] : null,
      errPath: errIndex >= 0 ? args[errIndex + 1] : null,
      vendorUsage: null,
      vendorUsageStatus: "not-invoked",
      outputCheckStatus: "not-requested",
    };
    for (const [key, value] of Object.entries(repositoryBaseline)) {
      assert.equal(Object.hasOwn(rawRow, key), true, `${fixture.vendor} missing repository baseline field ${key}`);
      assert.deepEqual(rawRow[key], value, `${fixture.vendor}.${key}`);
    }
    assert.deepEqual(
      { transport: rawRow.transport, vendor: rawRow.vendor, provider: rawRow.provider, lensId: rawRow.lensId },
      { transport: "cli", vendor: fixture.vendor, provider: null, lensId },
    );
    assert.deepEqual(
      { transport: portableRow.transport, vendor: portableRow.vendor, provider: portableRow.provider, lensId: portableRow.lensId },
      { transport: "cli", vendor: fixture.vendor, provider: null, lensId },
    );
    for (const locator of ["cwd", "outPath", "errPath", "pid", "argv", "executable"]) {
      assert.equal(Object.hasOwn(portableRow, locator), false, `${fixture.vendor} portable leaked ${locator}`);
    }
  }
});

test("C-13: a UTF-8 BOM does not hide the first provider environment key", () => {
  const root = temporaryRoot("second-opinion-bom");
  const envFile = join(root, "provider.env");
  writeFileSync(envFile, "\uFEFFNVIDIA_NIM_API_KEY=first-value\nNVIDIA_NIM_MODEL=fixture/model\n", "utf8");
  const loaded = loadProviderEnvironment(envFile, {});
  assert.equal(loaded.NVIDIA_NIM_API_KEY, "first-value");
  assert.equal(Object.hasOwn(loaded, "\uFEFFNVIDIA_NIM_API_KEY"), false);
});

test("H-9 probe reports each configured provider through request-json without cache or replacement selection", async () => {
  const root = temporaryRoot("second-opinion-h11-probe");
  const raw = join(root, "raw.jsonl");
  const portable = join(root, "portable.jsonl");
  const config = validateProbeConfig({
    schema_version: 1,
    providers: [
      { provider: "nvidia_nim", model: "fixture/model" },
      { provider: "gemini", model: "fixture/model" },
    ],
  }, root);
  let clock = 100;
  const stderr = memoryWriter();
  const probeRootsBefore = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("second-opinion-provider-probe-")));
  const probeRows = await runProviderProbe(config, {
    now: () => { clock += 5; return clock; },
    env: {
      NVIDIA_NIM_API_KEY: "fixture",
      GEMINI_API_KEY: "fixture",
      SECOND_OPINION_RECEIPT: raw,
      SECOND_OPINION_PORTABLE_RECEIPT: portable,
    },
    stderr: stderr.stream,
    generationDeps: {
      fetch: async (url) => url.includes("generativelanguage.googleapis.com")
        ? jsonResponse({
          modelVersion: "fixture/model",
          candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        })
        : new Response("gone", { status: 410 }),
    },
  });
  assert.deepEqual(probeRows, [
    { provider: "nvidia_nim", model: "fixture/model", status: "http-410", durationMs: 5, failureClass: "model-unavailable" },
    { provider: "gemini", model: "fixture/model", status: "ok", durationMs: 5, failureClass: null },
  ]);
  assert.equal(rows(raw).length, 2, "one ordinary raw receipt per request-json probe");
  assert.equal(rows(portable).length, 2, "one ordinary portable receipt per request-json probe");
  assert.deepEqual(readdirSync(root).sort(), ["portable.jsonl", "raw.jsonl"]);
  assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith("second-opinion-provider-probe-")).every((name) => probeRootsBefore.has(name)), true, "probe work directories must not remain after execution");
  for (const row of probeRows) {
    assert.deepEqual(Object.keys(row), ["provider", "model", "status", "durationMs", "failureClass"]);
    assert.equal(Object.hasOwn(row, "replacement"), false);
    assert.equal(Object.hasOwn(row, "fallback"), false);
  }
  assert.doesNotMatch(formatProbeTable(probeRows), /replacement|fallback|instead|대체/i);

  const generationSource = readFileSync(fileURLToPath(new URL("./generation-dispatch.mjs", import.meta.url)), "utf8");
  assert.equal(generationSource.includes("provider-probe.mjs"), false, "generation must not import or read provider probe results");
  const generation = await dispatchGeneration(request(), {
    env: environment(),
    openAiAdapter: async () => successfulResult(),
  });
  assert.equal(generation.text, "fixture", "generation must not consult probe results");
});

test("GLOBAL-2 env_file credentials are redacted from API receipt sinks", async () => {
  const root = temporaryRoot("second-opinion-env-file-secret");
  const sentinel = "R033_SENTINEL_ENV_FILE_SECRET_4b1a763e";
  const envFile = join(root, "provider.env");
  const requestPath = join(root, "request.json");
  const responsePath = join(root, "response.json");
  const raw = join(root, "raw.jsonl");
  const portable = join(root, "portable.jsonl");
  const stderr = memoryWriter();
  writeFileSync(envFile, `NVIDIA_NIM_API_KEY=${sentinel}\n`, "utf8");
  writeFileSync(requestPath, JSON.stringify(request({
    model: sentinel,
    prompt_source: sentinel,
    env_file: envFile,
  })), "utf8");

  assert.equal(await executeGenerationCli(["--request-json", requestPath, "--response-json", responsePath], {
    env: { SECOND_OPINION_RECEIPT: raw, SECOND_OPINION_PORTABLE_RECEIPT: portable },
    stderr: stderr.stream,
    fetch: async () => jsonResponse({
      model: sentinel,
      choices: [{ message: { content: "fixture" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
  }), 0);

  for (const sink of [stderr.value(), readFileSync(raw, "utf8"), readFileSync(portable, "utf8")]) {
    assert.equal(sink.includes(sentinel), false);
  }
  assert.equal(readFileSync(raw, "utf8").includes("[REDACTED]"), true);
  assert.equal(readFileSync(portable, "utf8").includes("[REDACTED]"), true);
});

test("GLOBAL-2: runtime sentinel is absent from stderr, raw, portable, response, out, and err", async () => {
  const root = temporaryRoot("second-opinion-secret");
  const sentinel = "R033_SENTINEL_API_SECRET_71f0b69c";
  const requestPath = join(root, "request.json");
  const responsePath = join(root, "response.json");
  const raw = join(root, "raw.jsonl");
  const portable = join(root, "portable.jsonl");
  const stderr = memoryWriter();
  writeFileSync(requestPath, JSON.stringify(request()), "utf8");
  assert.equal(await executeGenerationCli(["--request-json", requestPath, "--response-json", responsePath], {
    env: environment({ NVIDIA_NIM_API_KEY: sentinel, SECOND_OPINION_RECEIPT: raw, SECOND_OPINION_PORTABLE_RECEIPT: portable }),
    stderr: stderr.stream,
    fetch: async () => new Response("provider rejected credential", { status: 401 }),
  }), 4);

  const brief = join(root, "brief.md");
  const out = join(root, "out.txt");
  const err = join(root, "err.txt");
  writeFileSync(brief, "fixture", "utf8");
  const child = () => fakeChild((value) => {
    value.stdout.write("safe output");
    value.stderr.write("safe error");
    value.stdout.end();
    value.stderr.end();
    value.stdin.on("end", () => queueMicrotask(() => value.emit("close", 0, null)));
    value.stdin.resume();
  });
  await run({ vendor: "codex", operation: "text", mode: "default", brief, cwd: root, model: "fixture", effort: "high", inputs: [], timeout: 2, out, err, dryRun: false }, {
    spawn: child, stderr: memoryWriter().stream, env: { NVIDIA_NIM_API_KEY: sentinel },
  });
  for (const sink of [stderr.value(), readFileSync(raw, "utf8"), readFileSync(portable, "utf8"), readFileSync(responsePath, "utf8"), readFileSync(out, "utf8"), readFileSync(err, "utf8")]) {
    assert.equal(sink.includes(sentinel), false);
  }
});
