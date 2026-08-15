import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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

test("C-2: retry count, permanent classification, exponential waits, and Retry-After are enforced", async () => {
  let clock = 0;
  let calls = 0;
  const result = await dispatchGeneration(request({ max_retries: 5 }), {
    env: environment(), now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; },
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
    { attempt: 2, waitedMs: 3000, outcome: "failure" },
    { attempt: 3, waitedMs: 4000, outcome: "success" },
  ]);

  for (const fixture of [
    async () => { throw new GenerationDispatchError("bad", { statusCode: 400, retryable: true, failureClass: "bad-invocation", failureActor: "caller", remedy: "fix" }); },
    async () => { throw new GenerationDispatchError("malformed", { code: "invalid_response", failureClass: "invalid-response", failureActor: "vendor", remedy: "inspect" }); },
    async () => ({ ...successfulResult(), usage: null }),
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
  const generationSource = readFileSync(new URL("./generation-dispatch.mjs", import.meta.url), "utf8");
  assert.match(generationSource, /CONNECT_TIMEOUT_MS = 30_000/);
  assert.match(generationSource, /READ_TIMEOUT_MS = 120_000/);
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
    () => dispatchGeneration(request(), { env: environment(), openAiAdapter: async () => ({ ...successfulResult(), usage: null }) }),
    () => dispatchGeneration(request(), { env: environment(), openAiAdapter: async () => { throw new Error("opaque"); } }),
  ];
  for (const action of cases) {
    const error = await rejected(action);
    assert.equal(typeof error.failureClass, "string");
    assert.equal(typeof error.failureActor, "string");
    assert.equal(typeof error.remedy, "string");
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

test("GLOBAL-1/C-7 subprocess CLI entrypoints preserve 0.9.6 receipts, config sinks, and lens identity", () => {
  const root = temporaryRoot("second-opinion-cli-entrypoints");
  const home = join(root, "home");
  const configPath = join(home, ".second-opinion", "config.json");
  const brief = join(root, "brief.md");
  const installed = join(homedir(), ".claude", "plugins", "cache", "second-opinion", "second-opinion", "0.9.6", "scripts", "dispatch.mjs");
  const current = fileURLToPath(new URL("./dispatch.mjs", import.meta.url));
  const lensId = "r033-h10-subprocess-lens";
  const fixtures = [
    { vendor: "codex", extra: ["--model", "fixture-codex-model", "--effort", "high"], useConfig: true },
    { vendor: "agy", extra: ["--model", "Gemini 3.5 Flash (High)"], useConfig: false },
    { vendor: "claude", extra: ["--model", "opus", "--effort", "high", "--out", join(root, "claude-out.json"), "--err", join(root, "claude-err.txt")], useConfig: false },
  ];
  assert.equal(existsSync(installed), true, "installed second-opinion 0.9.6 baseline build is required");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(brief, "fixture", "utf8");

  const baseEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(baseEnv)) if (/^SECOND_OPINION_(?:PORTABLE_)?RECEIPT$/i.test(key)) delete baseEnv[key];
  for (const fixture of fixtures) {
    const raw = join(root, `${fixture.vendor}-raw.jsonl`);
    const portable = join(root, `${fixture.vendor}-portable.jsonl`);
    const baselineRaw = join(root, `${fixture.vendor}-0.9.6-raw.jsonl`);
    if (fixture.useConfig) writeFileSync(configPath, JSON.stringify({ receipt: raw, portableReceipt: portable }), "utf8");
    const args = ["--vendor", fixture.vendor, "--operation", "text", "--brief", brief, ...fixture.extra, "--lens-id", lensId, "--dry-run"];
    const baselineArgs = args.filter((value, index) => value !== "--lens-id" && args[index - 1] !== "--lens-id");
    const baseline = spawnSync(process.execPath, [installed, ...baselineArgs], {
      cwd: root, env: { ...baseEnv, SECOND_OPINION_RECEIPT: baselineRaw }, encoding: "utf8", timeout: 10_000, shell: false, windowsHide: true,
    });
    const currentEnv = fixture.useConfig
      ? baseEnv
      : { ...baseEnv, SECOND_OPINION_RECEIPT: raw, SECOND_OPINION_PORTABLE_RECEIPT: portable };
    const actual = spawnSync(process.execPath, [current, ...args], {
      cwd: root, env: currentEnv, encoding: "utf8", timeout: 10_000, shell: false, windowsHide: true,
    });
    assert.equal(baseline.status, 0, `${fixture.vendor} 0.9.6: ${baseline.stderr}`);
    assert.equal(actual.status, 0, `${fixture.vendor} current: ${actual.stderr}`);
    const baselineRows = rows(baselineRaw), rawRows = rows(raw), portableRows = rows(portable);
    assert.equal(baselineRows.length, 1, `${fixture.vendor} 0.9.6 raw rows`);
    assert.equal(rawRows.length, 1, `${fixture.vendor} raw rows`);
    assert.equal(portableRows.length, 1, `${fixture.vendor} portable rows`);
    const baselineRow = baselineRows[0], rawRow = rawRows[0], portableRow = portableRows[0];
    for (const key of Object.keys(baselineRow)) {
      assert.equal(Object.hasOwn(rawRow, key), true, `${fixture.vendor} missing 0.9.6 field ${key}`);
      if (!["ts", "durationSec", "pid"].includes(key)) assert.deepEqual(rawRow[key], baselineRow[key], `${fixture.vendor}.${key}`);
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

test("GLOBAL-1/C-12: seven frozen CLI behaviors remain protected by named regression tests", () => {
  const source = readFileSync(new URL("./dispatch.test.mjs", import.meta.url), "utf8");
  for (const title of [
    "seven hand-written argv fixtures match policy exactly",
    "timeout escalates to a forced tree-kill",
    "run injection strips every receipt env spelling",
    "run sends the AGY native-readonly profile plus the unmodified original brief",
    "P0: hardlink aliases of --brief and --input cannot be opened as output",
    "seven CLI dry-runs match literal fixtures",
    "Claude result binds the observed model and usage",
  ]) assert.ok(source.includes(title), `missing frozen-behavior regression: ${title}`);
  assert.equal(existsSync(new URL("./dispatch.test.mjs", import.meta.url)), true);
});
