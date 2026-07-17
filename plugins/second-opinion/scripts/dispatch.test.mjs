import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { PolicyError, buildVendorArgv, detectDirectInference, resolveExecutable } from "./vendor-policy.mjs";
import { executeCli, parseCli, run } from "./dispatch.mjs";

const root = mkdtempSync(join(tmpdir(), "second-opinion-r030-"));
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
function fakeChild(onStart) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  onStart(child);
  return child;
}

test("run injection preserves literal argv, complete stdin, and shell:false boundary", async () => {
  const fixture = FIXTURES[0];
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
  const code = await run({ ...fixture, brief, cwd: root, timeout: 2, dryRun: false }, { spawn: spawnFake, stderr: stderr.stream });
  assert.equal(code, 0);
  assert.equal(captured.executable, "codex");
  assert.deepEqual(captured.argv, fixture.argv);
  assert.equal(captured.options.shell, false);
  assert.equal(stdin, "brief with spaces and quotes: \"complete\"\n");
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
  const spawnFake = () => fakeChild((child) => queueMicrotask(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))));
  const code = await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, dryRun: false }, { spawn: spawnFake, stderr: stderr.stream });
  assert.equal(code, 3);
  assert.match(stderr.value(), /spawn failed \(ENOENT\)/);
});
test("timeout kills child and becomes exit 124", async () => {
  const stderr = memoryWriter();
  const spawnFake = () => fakeChild(() => {});
  const code = await run({ ...FIXTURES[0], brief, cwd: root, timeout: 1, dryRun: false }, { spawn: spawnFake, stderr: stderr.stream });
  assert.equal(code, 124);
  assert.match(stderr.value(), /exit=timeout/);
});
test("timeout escalates to a forced tree-kill and stays bounded when close never fires", async () => {
  const stderr = memoryWriter();
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
  const code = await run(
    { ...FIXTURES[0], brief, cwd: root, timeout: 1, killGraceMs: 20, reapMs: 20, forceKill: () => { forced = true; }, dryRun: false },
    { spawn: () => stubborn(), stderr: stderr.stream },
  );
  assert.equal(code, 124);
  assert.equal(forced, true, "force-kill escalation must fire when the child ignores SIGTERM");
  assert.match(stderr.value(), /exit=timeout/);
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
  const errFile = join(root, "vendor-only.err");
  const parent = memoryWriter();
  const spawnFake = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stderr.end("vendor-only\n");
      child.stdout.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  const code = await run({ ...FIXTURES[0], brief, cwd: root, timeout: 2, err: errFile, dryRun: false }, { spawn: spawnFake, stderr: parent.stream });
  assert.equal(code, 0);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(readFileSync(errFile, "utf8"), "vendor-only\n");
  assert.match(parent.value(), /^\[dispatch\]/);
  assert.doesNotMatch(readFileSync(errFile, "utf8"), /\[dispatch\]/);
});
