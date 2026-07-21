import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { PolicyError, buildVendorArgv, detectDirectInference, resolveExecutable } from "./vendor-policy.mjs";
import { executeCli, parseCli, run } from "./dispatch.mjs";

const tempDirs = [];
function makeTempDir(prefix, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, prefix));
  tempDirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const root = makeTempDir("second-opinion-r030-");
const brief = join(root, "brief.txt");
const input1 = join(root, "images", "one.png");
const input2 = join(root, "images", "two.png");
const input3 = join(root, "other", "three.png");
mkdirSync(dirname(input1), { recursive: true });
mkdirSync(dirname(input3), { recursive: true });
writeFileSync(brief, "brief with spaces and quotes: \"complete\"\n");
for (const input of [input1, input2, input3]) writeFileSync(input, "image");

const LINK_SKIP_CODES = new Set(["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
function createDirectoryLink(t, target, link) {
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (LINK_SKIP_CODES.has(error?.code)) {
      t.skip("directory links unavailable: " + error.code);
      return false;
    }
    throw error;
  }
}

test("dispatch runs its main module guard through a junction or symlink", (t) => {
  const scripts = resolve("plugins/second-opinion/scripts");
  const link = join(root, "scripts-link");
  if (!createDirectoryLink(t, scripts, link)) return;
  const result = spawnSync("node", [join(link, "dispatch.mjs"), "--vendor", "codex", "--operation", "text", "--brief", brief, "--dry-run"], {
    encoding: "utf8", shell: false, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"vendor":"codex"/);
});

// Hand-written literal fixtures copied from contract section 4. Never generate these from the builder.
const FIXTURES = [
  { vendor: "codex", operation: "text", model: "gpt model \"quoted\"", effort: "high", inputs: [], isGitRepo: false,
    argv: ["exec", "--skip-git-repo-check", "-m", "gpt model \"quoted\"", "-c", "model_reasoning_effort=\"high\"", "-"] },
  { vendor: "codex", operation: "image-analyze", model: "gpt model \"quoted\"", effort: "high", inputs: [input1, input2], isGitRepo: false,
    argv: ["exec", "--skip-git-repo-check", "-m", "gpt model \"quoted\"", "-c", "model_reasoning_effort=\"high\"", "-i", input1, "-i", input2, "-"] },
  { vendor: "codex", operation: "image-generate", model: "gpt model \"quoted\"", effort: "high", inputs: [], isGitRepo: false,
    argv: ["exec", "-s", "workspace-write", "--skip-git-repo-check", "-m", "gpt model \"quoted\"", "-c", "model_reasoning_effort=\"high\"", "-"] },
  { vendor: "agy", operation: "text", model: "Gemini 3.5 Flash (High)", inputs: [], isGitRepo: false,
    argv: ["--dangerously-skip-permissions", "--model", "Gemini 3.5 Flash (High)"] },
  { vendor: "agy", operation: "image-analyze", model: "Gemini 3.5 Flash (High)", inputs: [input1, input2, input3], isGitRepo: false,
    argv: ["--dangerously-skip-permissions", "--model", "Gemini 3.5 Flash (High)", "--add-dir", dirname(input1), "--add-dir", dirname(input3)] },
  { vendor: "agy", operation: "image-generate", model: "Gemini 3.5 Flash (High)", inputs: [], isGitRepo: false,
    argv: ["--dangerously-skip-permissions", "--model", "Gemini 3.5 Flash (High)"] },
];

test("six hand-written argv fixtures match policy exactly", () => {
  for (const fixture of FIXTURES) assert.deepEqual(buildVendorArgv(fixture), fixture.argv, `${fixture.vendor}/${fixture.operation}`);
  assert.deepEqual(FIXTURES.filter((fixture) => fixture.argv.includes("-s")).map((fixture) => `${fixture.vendor}/${fixture.operation}`), ["codex/image-generate"]);
  for (const fixture of FIXTURES.filter((fixture) => fixture.operation !== "image-generate")) assert.equal(fixture.argv.includes("-s"), false);
});

test("codex omits --skip-git-repo-check inside a git work tree", () => {
  const inTree = buildVendorArgv({ vendor: "codex", operation: "text", model: "m", effort: "high", inputs: [], isGitRepo: true });
  assert.equal(inTree.includes("--skip-git-repo-check"), false);
  assert.deepEqual(inTree, ["exec", "-m", "m", "-c", "model_reasoning_effort=\"high\"", "-"]);
});

test("six CLI dry-runs match literal fixtures and use bare executable names", async () => {
  for (const fixture of FIXTURES) {
    const args = ["--vendor", fixture.vendor, "--operation", fixture.operation, "--brief", brief, "--cwd", root, "--model", fixture.model, "--dry-run"];
    if (fixture.effort) args.push("--effort", fixture.effort);
    for (const input of fixture.inputs) args.push("--input", input);
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const status = await executeCli(args, { cwd: root, stdout: stdout.stream, stderr: stderr.stream });
    assert.equal(status, 0, stderr.value());
    const value = JSON.parse(stdout.value());
    assert.equal(value.executable, fixture.vendor);
    assert.deepEqual(value.argv, fixture.argv);
  }
});

test("unsupported and ambiguous CLI inputs exit 2", async () => {
  const cases = [
    ["--vendor", "agy", "--operation", "text", "--brief", brief, "--effort", "high"],
    ["--vendor", "codex", "--operation", "text", "--brief", brief, "--input", input1],
    ["--vendor", "codex", "--operation", "image-analyze", "--brief", brief],
    ["--vendor", "codex", "--operation", "text", "--brief", brief, "--unknown", "x"],
    ["--vendor", "codex", "--vendor", "agy", "--operation", "text", "--brief", brief],
    ["--vendor", "codex", "--operation", "text", "--brief", join(root, "missing.txt")],
    ["--vendor", "codex", "--operation", "text", "--brief", brief, "--model", "-unsafe"],
    ["--vendor", "codex", "--operation", "text", "--brief", brief, "--model", "bad\nmodel"],
    ["--vendor", "codex", "--operation", "text", "--brief", brief, "--out", brief],
  ];
  for (const args of cases) {
    const stderr = memoryWriter();
    const status = await executeCli(args, { cwd: root, stderr: stderr.stream });
    assert.equal(status, 2, `${JSON.stringify(args)}\n${stderr.value()}`);
  }
});

function memoryWriter() {
  let value = "";
  return { stream: new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } }), value: () => value };
}
function caseInsensitiveEnv(values) {
  return new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string") {
        const key = Object.keys(target).find((candidate) => candidate.toUpperCase() === property.toUpperCase());
        if (key !== undefined) return target[key];
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
function fakeChild(onStart, { emitsSpawn = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  onStart(child);
  if (emitsSpawn) queueMicrotask(() => child.emit("spawn"));
  return child;
}

async function withReceipt(path, action) {
  const previous = process.env.SECOND_OPINION_RECEIPT;
  process.env.SECOND_OPINION_RECEIPT = path;
  try { return await action(); }
  finally {
    if (previous === undefined) delete process.env.SECOND_OPINION_RECEIPT;
    else process.env.SECOND_OPINION_RECEIPT = previous;
  }
}

function receiptLines(path) { return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)); }

test("run injection strips every receipt env spelling and respects trimmed receipt opt-in", async () => {
  const fixture = FIXTURES[0];
  const receipt = join(root, "child-env-receipt.jsonl");
  const preservedKey = "SECOND_OPINION_TEST_PRESERVED";
  let captured;
  let stdin = "";
  const spawnFake = (executable, argv, options) => {
    captured = { executable, argv, options };
    return fakeChild((child) => {
      child.stdin.on("data", (chunk) => { stdin += chunk; });
      child.stdin.on("end", () => queueMicrotask(() => child.emit("close", 0, null)));
    });
  };
  const stderr = memoryWriter();
  const env = caseInsensitiveEnv({ second_opinion_receipt: receipt, [preservedKey]: "preserved" });
  const code = await run({ ...fixture, brief, cwd: root, timeout: 2, dryRun: false }, { spawn: spawnFake, stderr: stderr.stream, env });
  assert.equal(code, 0);
  assert.equal(captured.executable, "codex");
  assert.deepEqual(captured.argv, fixture.argv);
  assert.equal(captured.options.shell, false);
  assert.deepEqual(Object.keys(captured.options.env).filter((key) => key.toUpperCase() === "SECOND_OPINION_RECEIPT"), []);
  assert.equal(captured.options.env[preservedKey], "preserved");
  assert.equal(stdin, "brief with spaces and quotes: \"complete\"\n");

  let blankReceiptOptions;
  const blankReceiptSpawn = (_executable, _argv, options) => {
    blankReceiptOptions = options;
    return fakeChild((child) => {
      child.stdin.on("end", () => queueMicrotask(() => child.emit("close", 0, null)));
      child.stdin.resume();
    });
  };
  assert.equal(await run({ ...fixture, brief, cwd: root, timeout: 2, dryRun: false }, {
    spawn: blankReceiptSpawn, stderr: stderr.stream, env: { SECOND_OPINION_RECEIPT: "   " },
  }), 0);
  assert.equal(blankReceiptOptions.env, undefined);
});

test("opt-in receipt appends typed JSONL for dry-run and invoked children", async () => {
  const receipt = join(root, "receipts", "dispatch.jsonl");
  await withReceipt(`  ${receipt}  `, async () => {
    const stderr = memoryWriter();
    assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, dryRun: true }, { stderr: stderr.stream }), 0);
    const spawnFake = () => fakeChild((child) => {
      child.stdin.on("end", () => queueMicrotask(() => child.emit("close", 0, null)));
      child.stdin.resume();
    });
    assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, dryRun: false }, { spawn: spawnFake, stderr: stderr.stream }), 0);
  });
  assert.equal(receiptLines(receipt).length, 2);
  const [dryRun, completed] = receiptLines(receipt);
  assert.equal(dryRun.invoked, false);
  assert.equal(completed.invoked, true);
  for (const row of [dryRun, completed]) {
    assert.deepEqual(Object.keys(row).sort(), ["cwd", "durationSec", "effort", "errPath", "exit", "invoked", "model", "operation", "outPath", "pid", "schemaVersion", "ts", "vendor", "vendorUsage", "vendorUsageStatus"].sort());
    assert.equal(row.schemaVersion, 1);
    assert.equal(row.vendor, "codex");
    assert.equal(row.operation, "text");
    assert.equal(row.model, FIXTURES[0].model);
    assert.equal(typeof row.model, "string");
    assert.equal(row.effort, FIXTURES[0].effort);
    assert.equal(typeof row.effort, "string");
    assert.equal(row.exit, 0);
    assert.equal(typeof row.exit, "number");
    assert.equal(typeof row.ts, "string");
    assert.equal(typeof row.durationSec, "number");
    assert.equal(row.cwd, root);
    assert.equal(row.outPath, null);
    assert.equal(row.errPath, null);
    assert.equal(row.pid, process.pid);
    assert.equal(row.vendorUsage, null);
    assert.equal(row.vendorUsageStatus, row.invoked ? "no-err-file" : "not-invoked");
  }
  assert.match(readFileSync(receipt, "utf8"), /\n$/);
});

test("receipt appends a new line after an existing file without a trailing newline", async () => {
  const receipt = join(root, "existing-without-newline.jsonl");
  writeFileSync(receipt, "existing content");
  await withReceipt(receipt, async () => {
    assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, dryRun: true }, { stderr: memoryWriter().stream }), 0);
  });
  const [existing, record] = readFileSync(receipt, "utf8").split("\n");
  assert.equal(existing, "existing content");
  assert.equal(JSON.parse(record).schemaVersion, 1);
});

test("receipt records null model for a normal invocation without --model", async () => {
  const receipt = join(root, "no-model.jsonl");
  await withReceipt(receipt, async () => {
    assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, model: undefined, timeout: 2, dryRun: true }, { stderr: memoryWriter().stream }), 0);
  });
  const [row] = receiptLines(receipt);
  assert.equal(row.model, null);
});

test("receipt conflict with a missing output parent is rejected before output opens", async () => {
  const out = join(root, "missing-output-parent", "out.txt");
  let spawned = false;
  await withReceipt(out, async () => {
    const code = await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, out, dryRun: false }, { spawn: () => { spawned = true; throw new Error("unexpected spawn"); }, stderr: memoryWriter().stream });
    assert.equal(code, 2);
  });
  assert.equal(spawned, false);
  assert.equal(existsSync(dirname(out)), false);
  assert.equal(existsSync(out), false);
});

test("output open failure writes one uninvoked receipt", async () => {
  const out = join(root, "missing-output-parent-with-receipt", "out.txt");
  const receipt = join(root, "receipts", "output-open-failure.jsonl");
  let spawned = false;
  await withReceipt(receipt, async () => {
    assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, out, dryRun: false }, { spawn: () => { spawned = true; throw new Error("unexpected spawn"); }, stderr: memoryWriter().stream }), 3);
  });
  assert.equal(spawned, false);
  const rows = receiptLines(receipt);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows.map((row) => ({ exit: row.exit, invoked: row.invoked })), [{ exit: 3, invoked: false }]);
});

test("relative receipt paths resolve from process.cwd(), not --cwd", async () => {
  const cwd = join(root, "different-dispatch-cwd");
  const receiptDir = makeTempDir(".dispatch-receipt-", process.cwd());
  const receipt = join(receiptDir, "dispatch.jsonl");
  const receiptEnv = relative(process.cwd(), receipt);
  mkdirSync(cwd, { recursive: true });
  assert.notEqual(resolve(cwd, receiptEnv), receipt);
  assert.equal(resolve(process.cwd(), receiptEnv), receipt);
  try {
    await withReceipt(receiptEnv, async () => {
      assert.equal(await run({ ...FIXTURES[0], brief, cwd, timeout: 2, dryRun: true }, { stderr: memoryWriter().stream }), 0);
    });
    assert.equal(existsSync(receipt), true);
    assert.equal(receiptLines(receipt).length, 1);
  } finally {
    rmSync(receiptDir, { recursive: true, force: true });
  }
});

test("unwritable receipt path fails open without changing dispatch", async () => {
  const stderr = memoryWriter();
  await withReceipt(root, async () => {
    const spawnFake = () => fakeChild((child) => {
      child.stdin.on("end", () => queueMicrotask(() => child.emit("close", 0, null)));
      child.stdin.resume();
    });
    assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, dryRun: false }, { spawn: spawnFake, stderr: stderr.stream }), 0);
  });
  assert.match(stderr.value(), /exit=0/);
});

test("pre-spawn failures write one uninvoked receipt despite duplicate events", async () => {
  const receipt = join(root, "pre-spawn.jsonl");
  await withReceipt(receipt, async () => {
    const spawnFake = () => fakeChild((child) => queueMicrotask(() => {
      child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
      child.emit("close", 3, null);
    }), { emitsSpawn: false });
    assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, dryRun: false }, { spawn: spawnFake, stderr: memoryWriter().stream }), 3);
  });
  const rows = receiptLines(receipt);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoked, false);
  assert.equal(rows[0].exit, 3);
});

test("brief and synchronous spawn failures write uninvoked receipts", async () => {
  const receipt = join(root, "other-pre-spawn.jsonl");
  await withReceipt(receipt, async () => {
    assert.equal(await run({ ...FIXTURES[0], brief: join(root, "not-found.txt"), cwd: root, timeout: 2, dryRun: false }, { spawn: () => { throw new Error("unexpected spawn"); }, stderr: memoryWriter().stream }), 3);
    assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, dryRun: false }, { spawn: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, stderr: memoryWriter().stream }), 3);
  });
  const rows = receiptLines(receipt);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.exit, row.invoked]), [[3, false], [3, false]]);
});

test("executable resolution failure writes an uninvoked receipt", () => {
  const receipt = join(root, "executable-resolution.jsonl");
  const result = spawnSync(process.execPath, [resolve("plugins/second-opinion/scripts/dispatch.mjs"), "--vendor", "codex", "--operation", "text", "--brief", brief], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: "", SECOND_OPINION_RECEIPT: receipt },
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(receiptLines(receipt).map((row) => [row.exit, row.invoked]), [[2, false]]);
});

// detectDirectInference is the caller-scoped enforcement API (second-opinion itself never calls it).
const BLOCK = [
  ["timeout 280 codex exec - < brief.txt > out.txt 2>err.txt", "codex"],
  ["codex.exe exec -", "codex"],
  ["\"C:\\tools\\codex.exe\" exec --skip-git-repo-check -", "codex"],
  ["Get-Content brief.txt | codex exec -", "codex"],
  ["bash -lc 'codex exec -'", "codex"],
  ["cmd /c codex exec -", "codex"],
  ["node dispatch.mjs --vendor codex --operation text --brief b.txt ; codex exec - < b.txt", "codex"],
  ["echo hi | agy --model \"Gemini 3.5 Flash (High)\"", "agy"],
  ["agy < brief.txt", "agy"],
  ["Get-Content b | agy", "agy"],
  ["\"$AGY\" --model \"Gemini 3.5 Flash (High)\" < brief.txt", "agy"],
  ["& $agy --model Gemini", "agy"],
  ["agy --add-dir . -p \"analyze this\"", "agy"],
  ["$CODEX exec -", "codex"],
  ["${CODEX} exec -", "codex"],
  // default-deny coverage: these entry points run inference but are NOT "exec" —
  // an exec-only deny-list (this file's own earlier version) missed every one.
  ["codex", "codex"],
  ["codex \"fix the bug\"", "codex"],
  ["codex review", "codex"],
  ["codex resume --last", "codex"],
  ["codex fork", "codex"],
  ["codex -m gpt-5-codex \"do something\"", "codex"],
  ["agy", "agy"],
  ["npx codex exec -", "codex"],
  ["pnpm exec agy --print hi", "agy"],
];
const PASS = [
  "node ./dispatch.mjs --vendor codex --operation text --brief b.txt",
  "codex --version", "codex login", "codex logout",
  "agy --version", "agy models", "agy --help",
  "irm https://chatgpt.com/codex/install.ps1 | iex",
  "claude -p hello",
  "git commit -m \"fix codex exec\"",
  "grep \"codex exec\" file.js",
  // management surface beyond the old allowlist, plus subcommand-help short-circuit.
  "codex mcp list", "codex doctor", "codex apply", "codex --help",
  "codex exec --help", "codex review --help",
  "agy install", "agy plugin list", "agy changelog",
  "codex sandbox echo hi",
];

test("detectDirectInference flags every direct-inference vector with the exact vendor", () => {
  for (const [command, vendor] of BLOCK) assert.equal(detectDirectInference(command), vendor, command);
});
test("detectDirectInference returns null for dispatcher, management, install, reverse-channel, and prose vectors", () => {
  for (const command of PASS) assert.equal(detectDirectInference(command), null, command);
});
test("detectDirectInference: raw codex exec resolves to codex, dispatcher call to null", () => {
  assert.equal(detectDirectInference("timeout 280 codex exec - < brief.txt"), "codex");
  assert.equal(detectDirectInference("node dispatch.mjs --vendor codex --operation text --brief b.txt"), null);
});

test("spawn error becomes exit 3", async () => {
  const stderr = memoryWriter();
  const spawnFake = () => fakeChild((child) => queueMicrotask(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))), { emitsSpawn: false });
  const code = await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, dryRun: false }, { spawn: spawnFake, stderr: stderr.stream });
  assert.equal(code, 3);
  assert.match(stderr.value(), /spawn failed \(ENOENT\)/);
});
test("timeout kills child and becomes exit 124", async () => {
  const stderr = memoryWriter();
  const receipt = join(root, "timeout.jsonl");
  const spawnFake = () => fakeChild(() => {});
  let code;
  await withReceipt(receipt, async () => {
    code = await run({ ...FIXTURES[0], brief, cwd: root, timeout: 1, dryRun: false }, { spawn: spawnFake, stderr: stderr.stream });
  });
  assert.equal(code, 124);
  assert.match(stderr.value(), /exit=timeout/);
  assert.equal(receiptLines(receipt)[0].exit, "timeout");
});
test("timeout escalates to a forced tree-kill and stays bounded when close never fires", async () => {
  const stderr = memoryWriter();
  const receipt = join(root, "forced-timeout.jsonl");
  let forced = false;
  const stubborn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 999999;
    child.kill = () => true; // ignores termination — never emits "close"
    return child;
  };
  let code;
  await withReceipt(receipt, async () => {
    code = await run(
      { ...FIXTURES[0], brief, cwd: root, timeout: 1, killGraceMs: 20, reapMs: 20, forceKill: () => { forced = true; }, dryRun: false },
      { spawn: () => stubborn(), stderr: stderr.stream },
    );
  });
  assert.equal(code, 124);
  assert.equal(forced, true, "force-kill escalation must fire when the child ignores SIGTERM");
  assert.match(stderr.value(), /exit=timeout/);
  assert.equal(receiptLines(receipt)[0].exit, "timeout");
});

test("default timeout is a large runaway-backstop, not a short work limit", () => {
  const parsed = parseCli(["--vendor", "codex", "--operation", "text", "--brief", brief], root);
  assert.equal(parsed.timeout, 1800);
});

test("relative file paths normalize against start cwd, not vendor cwd", () => {
  const nested = join(root, "vendor-cwd");
  mkdirSync(nested);
  const parsed = parseCli(["--vendor", "codex", "--operation", "image-analyze", "--brief", "brief.txt", "--cwd", nested, "--input", "images/one.png"], root);
  assert.equal(parsed.brief, brief);
  assert.equal(parsed.inputs[0], input1);
});

test("resolved Windows executable is absolute and cmd-only discovery is classified", () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const exe = join(bin, "codex.exe");
  writeFileSync(exe, "fake");
  assert.equal(resolveExecutable("codex", { platform: "win32", env: {}, pathValue: bin }), exe);
  const cmdBin = join(root, "cmd-bin");
  mkdirSync(cmdBin);
  writeFileSync(join(cmdBin, "agy.cmd"), "fake");
  assert.throws(() => resolveExecutable("agy", { platform: "win32", env: {}, pathValue: cmdBin }), (error) => error instanceof PolicyError && error.classification === "channel_mixing");
});

test("vendor stderr file excludes the parent receipt", async () => {
  const outFile = join(root, "vendor-only.out");
  const errFile = join(root, "vendor-only.err");
  const receipt = join(root, "output-paths.jsonl");
  const parent = memoryWriter();
  const spawnFake = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stderr.end("vendor-only\n");
      child.stdout.end("vendor-out\n");
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  let code;
  await withReceipt(receipt, async () => {
    code = await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, out: outFile, err: errFile, dryRun: false }, { spawn: spawnFake, stderr: parent.stream });
  });
  assert.equal(code, 0);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(readFileSync(outFile, "utf8"), "vendor-out\n");
  assert.equal(readFileSync(errFile, "utf8"), "vendor-only\n");
  assert.match(parent.value(), /^\[dispatch\]/);
  assert.doesNotMatch(readFileSync(errFile, "utf8"), /\[dispatch\]/);
  const [row] = receiptLines(receipt);
  assert.equal(row.outPath, outFile);
  assert.equal(row.errPath, errFile);
});

const USAGE_SESSION = "12345678-1234-1234-1234-123456789abc";
const USAGE_TOKENS = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120 };
function tokenCountEvent(tokens = USAGE_TOKENS, { contextWindow = 128000, quota = 45, includeQuota = true } = {}) {
  const payload = { type: "token_count", info: { total_token_usage: tokens, model_context_window: contextWindow } };
  if (includeQuota) payload.rate_limits = { primary: { used_percent: quota } };
  return JSON.stringify({ type: "event_msg", payload });
}
function rolloutPath(codexHome, sessionId = USAGE_SESSION, suffix = "one") {
  const path = join(codexHome, "sessions", "2026", "07", "21", `rollout-${suffix}-${sessionId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
function writeRollout(codexHome, lines, sessionId = USAGE_SESSION, suffix = "one") {
  const path = rolloutPath(codexHome, sessionId, suffix);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}
function usageSpawn(stderrText) {
  return () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stderr.end(stderrText);
      child.stdout.end();
      setTimeout(() => child.emit("close", 0, null), 5);
    });
    child.stdin.resume();
  });
}
async function runForUsage({ codexHome, vendor = "codex", errText = `session id: ${USAGE_SESSION}\n`, invoked = true } = {}) {
  const usageRoot = makeTempDir("second-opinion-r031-");
  const receipt = join(usageRoot, "receipt.jsonl");
  const err = join(usageRoot, "vendor.err");
  const options = { ...FIXTURES[vendor === "codex" ? 0 : 3], brief, cwd: root, timeout: 2, err, dryRun: !invoked };
  const deps = { stderr: memoryWriter().stream, env: { SECOND_OPINION_RECEIPT: receipt, CODEX_HOME: codexHome } };
  if (invoked) deps.spawn = usageSpawn(errText);
  assert.equal(await run(options, deps), 0);
  return receiptLines(receipt)[0];
}

test("vendor usage reads the last valid token_count from CODEX_HOME and preserves optional fields", async () => {
  const codexHome = makeTempDir("second-opinion-codex-home-");
  writeRollout(codexHome, ["{broken json", tokenCountEvent({ ...USAGE_TOKENS, total_tokens: 111 }), tokenCountEvent()]);
  const row = await runForUsage({ codexHome });
  assert.equal(row.vendorUsageStatus, "ok");
  assert.deepEqual(row.vendorUsage, {
    source: "codex-rollout", inputTokens: 100, cachedInputTokens: 60, outputTokens: 20,
    reasoningOutputTokens: 8, totalTokens: 120, contextWindow: 128000, quotaUsedPercent: 45,
  });
  assert.equal(row.schemaVersion, 1);
});

test("vendor usage falls back to ~/.codex when CODEX_HOME is unset", async () => {
  const temporaryHome = makeTempDir("second-opinion-home-");
  const previous = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    delete process.env.CODEX_HOME;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;
    const codexHome = join(homedir(), ".codex");
    writeRollout(codexHome, [tokenCountEvent()]);
    const row = await runForUsage({ codexHome: undefined });
    assert.equal(row.vendorUsageStatus, "ok");
    assert.equal(row.vendorUsage.totalTokens, 120);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("vendor usage rejects ambiguous rollout files and ignores a stale pre-invocation stderr", async () => {
  const codexHome = makeTempDir("second-opinion-codex-home-");
  writeRollout(codexHome, [tokenCountEvent()]);
  writeRollout(codexHome, [tokenCountEvent()], USAGE_SESSION, "two");
  const ambiguous = await runForUsage({ codexHome });
  assert.equal(ambiguous.vendorUsage, null);
  assert.equal(ambiguous.vendorUsageStatus, "ambiguous-rollout-file");
  const staleHome = makeTempDir("second-opinion-codex-home-");
  writeRollout(staleHome, [tokenCountEvent({ input_tokens: 1000000, cached_input_tokens: 1000000, output_tokens: 1000000, reasoning_output_tokens: 1000000, total_tokens: 1000000 })]);
  const staleRoot = makeTempDir("second-opinion-r031-stale-");
  const staleReceipt = join(staleRoot, "receipt.jsonl");
  const staleErr = join(staleRoot, "stale.err");
  writeFileSync(staleErr, `session id: ${USAGE_SESSION}\n`);
  assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, err: staleErr, dryRun: true }, {
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: staleReceipt, CODEX_HOME: staleHome },
  }), 0);
  const [notInvoked] = receiptLines(staleReceipt);
  assert.equal(notInvoked.vendorUsage, null);
  assert.equal(notInvoked.vendorUsageStatus, "not-invoked");
});

test("vendor usage validates IDs, files, tokens, and optional quota independently", async () => {
  const invalidIdHome = makeTempDir("second-opinion-codex-home-");
  writeRollout(invalidIdHome, [tokenCountEvent()]);
  const invalidId = await runForUsage({ codexHome: invalidIdHome, errText: "session id: ../../*.jsonl\n" });
  assert.equal(invalidId.vendorUsageStatus, "no-session-id");

  const regularHome = makeTempDir("second-opinion-codex-home-");
  mkdirSync(rolloutPath(regularHome), { recursive: true });
  const nonRegular = await runForUsage({ codexHome: regularHome });
  assert.equal(nonRegular.vendorUsageStatus, "not-regular-file");

  for (const [index, tokens] of [
    { ...USAGE_TOKENS, input_tokens: "100" },
    { cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120 },
    { ...USAGE_TOKENS, total_tokens: null },
  ].entries()) {
    const invalidHome = makeTempDir("second-opinion-codex-home-");
    writeRollout(invalidHome, [tokenCountEvent(tokens)], USAGE_SESSION, String(index));
    const row = await runForUsage({ codexHome: invalidHome });
    assert.equal(row.vendorUsageStatus, "invalid-token-fields");
  }
  const infiniteHome = makeTempDir("second-opinion-codex-home-");
  writeFileSync(rolloutPath(infiniteHome), "{\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1e400,\"cached_input_tokens\":60,\"output_tokens\":20,\"reasoning_output_tokens\":8,\"total_tokens\":120}}}}\n");
  const infinite = await runForUsage({ codexHome: infiniteHome });
  assert.equal(infinite.vendorUsageStatus, "invalid-token-fields");
  const quotaHome = makeTempDir("second-opinion-codex-home-");
  writeRollout(quotaHome, [tokenCountEvent(USAGE_TOKENS, { contextWindow: "128000", includeQuota: false })]);
  const quota = await runForUsage({ codexHome: quotaHome });
  assert.equal(quota.vendorUsageStatus, "ok");
  assert.equal(quota.vendorUsage.contextWindow, null);
  assert.equal(quota.vendorUsage.quotaUsedPercent, null);
});

test("vendor usage statuses fail open for unsupported vendors, missing sources, and oversized rollouts", async () => {
  const codexHome = makeTempDir("second-opinion-codex-home-");
  const unsupported = await runForUsage({ codexHome, vendor: "agy" });
  assert.equal(unsupported.vendorUsageStatus, "unsupported-vendor");

  const noRollout = await runForUsage({ codexHome });
  assert.equal(noRollout.vendorUsageStatus, "no-rollout-file");

  const atLimitHome = makeTempDir("second-opinion-codex-home-");
  const atLimit = writeRollout(atLimitHome, [tokenCountEvent()]);
  truncateSync(atLimit, 64 * 1024 * 1024);
  const withinLimit = await runForUsage({ codexHome: atLimitHome });
  assert.equal(withinLimit.vendorUsageStatus, "ok");

  const tooLargeHome = makeTempDir("second-opinion-codex-home-");
  const large = rolloutPath(tooLargeHome);
  writeFileSync(large, "x");
  truncateSync(large, 64 * 1024 * 1024 + 1);
  const tooLarge = await runForUsage({ codexHome: tooLargeHome });
  assert.equal(tooLarge.vendorUsageStatus, "file-too-large");
});

test("vendor usage records no-token-count and read-failed without affecting dispatch", async () => {
  const noTokenHome = makeTempDir("second-opinion-codex-home-");
  writeRollout(noTokenHome, ["{\"payload\":{\"type\":\"other\"}}"]);
  const noToken = await runForUsage({ codexHome: noTokenHome });
  assert.equal(noToken.vendorUsage, null);
  assert.equal(noToken.vendorUsageStatus, "no-token-count");

  const failedRoot = makeTempDir("second-opinion-r031-read-failed-");
  const failedReceipt = join(failedRoot, "receipt.jsonl");
  const failedErr = join(failedRoot, "vendor.err");
  const readFailureSpawn = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end();
      child.stderr.end();
      rmSync(failedErr, { force: true });
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, err: failedErr, dryRun: false }, {
    spawn: readFailureSpawn,
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: failedReceipt },
  }), 0);
  const [readFailed] = receiptLines(failedReceipt);
  assert.equal(readFailed.vendorUsage, null);
  assert.equal(readFailed.vendorUsageStatus, "read-failed");
});

test("P0: receipt paths matching --out or --err are rejected before output opens", async () => {
  const shared = join(root, "p0", "receipt.jsonl");
  mkdirSync(dirname(shared), { recursive: true });
  const original = "{\"one\":1}\n{\"two\":2}\n{\"three\":3}\n";
  for (const flag of ["--out", "--err"]) {
    writeFileSync(shared, original);
    await withReceipt(shared, async () => {
      const stderr = memoryWriter();
      const status = await executeCli(["--vendor", "codex", "--operation", "text", "--brief", brief, flag, shared], { cwd: root, stderr: stderr.stream });
      assert.equal(status, 2);
      assert.match(stderr.value(), /SECOND_OPINION_RECEIPT/);
    });
    assert.equal(readFileSync(shared, "utf8"), original);
  }
  if (process.platform === "win32") {
    const equivalent = shared.replace(/\\/g, "/").toUpperCase();
    writeFileSync(shared, original);
    await withReceipt(shared, async () => {
      assert.equal(await executeCli(["--vendor", "codex", "--operation", "text", "--brief", brief, "--out", equivalent], { cwd: root, stderr: memoryWriter().stream }), 2);
    });
    assert.equal(readFileSync(shared, "utf8"), original);
  }
});

test("P2: a missing win32 receipt still conflicts with case- and separator-variant --out", { skip: process.platform !== "win32" }, async () => {
  const receipt = join(root, "p2-missing-receipt", "receipt.jsonl");
  const equivalentOut = receipt.replace(/\\/g, "/").toUpperCase();
  assert.equal(existsSync(receipt), false);
  let spawned = false;
  await withReceipt(receipt, async () => {
    const status = await executeCli(["--vendor", "codex", "--operation", "text", "--brief", brief, "--out", equivalentOut], {
      cwd: root,
      spawn: () => { spawned = true; throw new Error("must not spawn after receipt conflict"); },
      stderr: memoryWriter().stream,
    });
    assert.equal(status, 2);
  });
  assert.equal(spawned, false);
  assert.equal(existsSync(receipt), false);
});

test("P0: run normalizes direct relative paths before receipt conflict checks and receipt recording", async () => {
  const p0Root = join(root, "p0-direct-relative");
  const receipt = join(p0Root, "receipt.jsonl");
  const out = join(p0Root, "vendor.out");
  const err = join(p0Root, "vendor.err");
  const receiptRelative = relative(process.cwd(), receipt);
  const original = "{\"one\":1}\n{\"two\":2}\n{\"three\":3}\n";
  mkdirSync(p0Root, { recursive: true });
  writeFileSync(receipt, original);
  let spawned = false;
  assert.equal(await run({ ...FIXTURES[0], brief: relative(process.cwd(), brief), cwd: root, timeout: 2, out: receiptRelative, err: relative(process.cwd(), err), dryRun: false }, {
    spawn: () => { spawned = true; throw new Error("must not spawn on receipt conflict"); },
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: receiptRelative },
  }), 2);
  assert.equal(spawned, false);
  assert.equal(readFileSync(receipt, "utf8"), original);

  const spawnFake = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end("vendor-output\n");
      child.stderr.end("vendor-error\n");
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  assert.equal(await run({ ...FIXTURES[0], brief: relative(process.cwd(), brief), cwd: root, timeout: 2, out: relative(process.cwd(), out), err: relative(process.cwd(), err), dryRun: false }, {
    spawn: spawnFake,
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: receiptRelative },
  }), 0);
  const row = receiptLines(receipt).at(-1);
  assert.equal(row.outPath, out);
  assert.equal(row.errPath, err);
  assert.equal(isAbsolute(row.outPath), true);
  assert.equal(isAbsolute(row.errPath), true);
});

test("P0: a relative SECOND_OPINION_RECEIPT blocks normal CLI output", async () => {
  const receipt = join(root, "p0-relative-cli", "receipt.jsonl");
  const receiptRelative = relative(process.cwd(), receipt);
  const original = "{\"one\":1}\n{\"two\":2}\n{\"three\":3}\n";
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(receipt, original);
  await withReceipt(receiptRelative, async () => {
    assert.equal(await executeCli(["--vendor", "codex", "--operation", "text", "--brief", brief, "--out", receiptRelative], {
      cwd: process.cwd(), stderr: memoryWriter().stream,
    }), 2);
  });
  assert.equal(readFileSync(receipt, "utf8"), original);
});

test("P0: hardlink aliases of the receipt are rejected for both --out and --err before output opens", async (t) => {
  const receipt = join(root, "p0-hardlink", "receipt.jsonl");
  const original = "{\"one\":1}\n{\"two\":2}\n{\"three\":3}\n";
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(receipt, original);
  for (const flag of ["--out", "--err"]) {
    const alias = join(root, "p0-hardlink", `receipt-${flag.slice(2)}-alias.jsonl`);
    try { linkSync(receipt, alias); }
    catch (error) {
      if (LINK_SKIP_CODES.has(error?.code)) {
        t.skip("hardlinks unavailable: " + error.code);
        return;
      }
      throw error;
    }
    await withReceipt(receipt, async () => {
      assert.equal(await executeCli(["--vendor", "codex", "--operation", "text", "--brief", brief, flag, alias], { cwd: root, stderr: memoryWriter().stream }), 2);
    });
    assert.equal(readFileSync(receipt, "utf8"), original);
  }
});

test("P0: hardlink aliases of --brief and --input cannot be opened as output", async (t) => {
  const p0Root = join(root, "p0-source-hardlinks");
  const protectedBrief = join(p0Root, "brief.md");
  const protectedInput = join(p0Root, "input.png");
  const ordinaryBrief = join(p0Root, "ordinary-brief.md");
  const briefBytes = Buffer.from("중요한 사용자 데이터 — 잃어버리면 안 됨\n");
  const inputBytes = Buffer.from([0, 1, 2, 3, 255]);
  mkdirSync(p0Root, { recursive: true });
  writeFileSync(protectedBrief, briefBytes);
  writeFileSync(protectedInput, inputBytes);
  writeFileSync(ordinaryBrief, "describe this image\n");
  const cases = [
    { name: "brief", source: protectedBrief, bytes: briefBytes, args: ["--operation", "text", "--brief", protectedBrief] },
    { name: "input", source: protectedInput, bytes: inputBytes, args: ["--operation", "image-analyze", "--brief", ordinaryBrief, "--input", protectedInput] },
  ];
  for (const { name, source, bytes, args } of cases) {
    for (const flag of ["--out", "--err"]) {
      const alias = join(p0Root, `${name}-${flag.slice(2)}-alias`);
      try { linkSync(source, alias); }
      catch (error) {
        if (LINK_SKIP_CODES.has(error?.code)) {
          t.skip("hardlinks unavailable: " + error.code);
          return;
        }
        throw error;
      }
      const stderr = memoryWriter();
      const status = await executeCli(["--vendor", "codex", ...args, flag, alias], { cwd: root, stderr: stderr.stream });
      assert.equal(status, 2, `${name}/${flag}: ${stderr.value()}`);
      assert.deepEqual(readFileSync(source), bytes, `${name}/${flag} must remain byte-for-byte unchanged`);
    }
  }
});

test("P0: --input cannot alias the receipt append target", async (t) => {
  const p0Root = join(root, "p0-receipt-input");
  const input = join(p0Root, "input.png");
  const receipt = join(p0Root, "receipt-alias.jsonl");
  const original = Buffer.from([0, 1, 2, 3, 255]);
  mkdirSync(p0Root, { recursive: true });
  writeFileSync(input, original);
  try { linkSync(input, receipt); }
  catch (error) {
    if (LINK_SKIP_CODES.has(error?.code)) {
      t.skip("hardlinks unavailable: " + error.code);
      return;
    }
    throw error;
  }
  await withReceipt(receipt, async () => {
    const status = await executeCli(["--vendor", "codex", "--operation", "image-analyze", "--brief", brief, "--input", input, "--dry-run"], {
      cwd: root, stderr: memoryWriter().stream,
    });
    assert.equal(status, 2);
  });
  assert.deepEqual(readFileSync(input), original);
});

test("P0: run rejects hardlink aliases of --brief before either output opens", async (t) => {
  const p0Root = join(root, "p0-run-brief-hardlinks");
  const source = join(p0Root, "brief.md");
  const original = Buffer.from("중요한 사용자 데이터 — 잃어버리면 안 됨\n");
  mkdirSync(p0Root, { recursive: true });
  writeFileSync(source, original);
  for (const flag of ["out", "err"]) {
    const alias = join(p0Root, `${flag}-alias`);
    try { linkSync(source, alias); }
    catch (error) {
      if (LINK_SKIP_CODES.has(error?.code)) {
        t.skip("hardlinks unavailable: " + error.code);
        return;
      }
      throw error;
    }
    let spawned = false;
    const status = await run({ ...FIXTURES[0], brief: source, cwd: root, timeout: 2, [flag]: alias, dryRun: false }, {
      spawn: () => { spawned = true; throw new Error("must not spawn after alias validation failure"); },
      stderr: memoryWriter().stream,
    });
    assert.equal(status, 2);
    assert.equal(spawned, false);
    assert.deepEqual(readFileSync(source), original);
  }
});

test("P0: --out and --err cannot alias one another", async (t) => {
  const p0Root = join(root, "p0-output-hardlinks");
  const out = join(p0Root, "out.txt");
  const err = join(p0Root, "err.txt");
  const original = Buffer.from("preserve until validation\n");
  mkdirSync(p0Root, { recursive: true });
  writeFileSync(out, original);
  try { linkSync(out, err); }
  catch (error) {
    if (LINK_SKIP_CODES.has(error?.code)) {
      t.skip("hardlinks unavailable: " + error.code);
      return;
    }
    throw error;
  }
  const stderr = memoryWriter();
  const status = await executeCli(["--vendor", "codex", "--operation", "text", "--brief", brief, "--out", out, "--err", err], {
    cwd: root, stderr: stderr.stream,
  });
  assert.equal(status, 2);
  assert.match(stderr.value(), /--out and --err/);
  assert.deepEqual(readFileSync(out), original);
});

test("P3: an oversized --err file records file-too-large", async () => {
  const usageRoot = makeTempDir("second-opinion-r031-large-err-");
  const receipt = join(usageRoot, "receipt.jsonl");
  const err = join(usageRoot, "vendor.err");
  const spawnLargeErr = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end();
      child.stderr.end();
      truncateSync(err, 64 * 1024 * 1024 + 1);
      setTimeout(() => child.emit("close", 0, null), 5);
    });
    child.stdin.resume();
  });
  assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, err, dryRun: false }, {
    spawn: spawnLargeErr,
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: receipt },
  }), 0);
  assert.equal(receiptLines(receipt)[0].vendorUsageStatus, "file-too-large");
});

test("P3: a directory supplied as --err is rejected before the child starts", async () => {
  const usageRoot = makeTempDir("second-opinion-r031-directory-err-");
  const receipt = join(usageRoot, "receipt.jsonl");
  const err = join(usageRoot, "vendor.err");
  mkdirSync(err);
  let spawned = false;
  const stderr = memoryWriter();
  assert.equal(await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, err, dryRun: false }, {
    spawn: () => { spawned = true; throw new Error("must not spawn when --err is a directory"); },
    stderr: stderr.stream,
    env: { SECOND_OPINION_RECEIPT: receipt },
  }), 3);
  assert.equal(spawned, false);
  assert.match(stderr.value(), /unable to open output file/);
  assert.equal(receiptLines(receipt)[0].vendorUsageStatus, "not-invoked");
});

test("P3: vendor usage retries until a delayed rollout appears", async () => {
  const codexHome = makeTempDir("second-opinion-codex-home-");
  const writerProgram = [
    'const { mkdirSync, writeFileSync } = require("node:fs");',
    'const { dirname, join } = require("node:path");',
    'const [home, sessionId, event] = process.argv.slice(1);',
    'const path = join(home, "sessions", "2026", "07", "21", `rollout-delayed-${sessionId}.jsonl`);',
    'setTimeout(() => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, event + "\\n"); }, 75);',
    'process.stdout.write("ready\\n");',
  ].join(" ");
  const writer = spawn(process.execPath, ["-e", writerProgram, codexHome, USAGE_SESSION, tokenCountEvent()], {
    stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
  });
  const writerExit = new Promise((resolve, reject) => {
    let stderr = "";
    writer.stderr.on("data", (chunk) => { stderr += chunk; });
    writer.once("error", reject);
    writer.once("close", (code) => code === 0 ? resolve() : reject(new Error(`delayed rollout writer exited ${code}: ${stderr}`)));
  });
  await new Promise((resolve, reject) => {
    writer.stdout.once("data", (chunk) => chunk.toString() === "ready\n" ? resolve() : reject(new Error(`unexpected writer readiness: ${chunk}`)));
    writer.once("error", reject);
  });
  const row = await runForUsage({ codexHome });
  await writerExit;
  assert.equal(row.vendorUsageStatus, "ok");
  assert.equal(row.vendorUsage.totalTokens, USAGE_TOKENS.total_tokens);
});
