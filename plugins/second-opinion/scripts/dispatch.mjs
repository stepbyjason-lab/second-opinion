import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, createWriteStream, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONS, PolicyError, buildVendorArgv, executableName, normalizeVendor, resolveExecutable } from "./vendor-policy.mjs";

const MAX_BRIEF_BYTES = 8 * 1024 * 1024;
const MAX_VENDOR_USAGE_BYTES = 64 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SINGLE_OPTIONS = new Set(["--vendor", "--operation", "--brief", "--cwd", "--model", "--effort", "--timeout", "--out", "--err", "--dry-run"]);

export class CliError extends Error {
  constructor(message) { super(message); this.name = "CliError"; }
}

function absoluteFrom(base, value) { return isAbsolute(value) ? resolve(value) : resolve(base, value); }
function samePath(left, right) { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function assertRegularFile(path, label) {
  try { if (!statSync(path).isFile()) throw new Error(); }
  catch { throw new CliError(`${label} must be an existing regular file: ${path}`); }
}
function assertDirectory(path, label) {
  try { if (!statSync(path).isDirectory()) throw new Error(); }
  catch { throw new CliError(`${label} must be an existing directory: ${path}`); }
}

export function parseCli(argv, startCwd = process.cwd()) {
  const raw = { inputs: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--input") {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw new CliError("--input requires a value");
      raw.inputs.push(argv[++index]);
      continue;
    }
    if (!SINGLE_OPTIONS.has(flag)) throw new CliError(`unknown argument: ${flag}`);
    if (seen.has(flag)) throw new CliError(`duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--dry-run") raw.dryRun = true;
    else {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw new CliError(`${flag} requires a value`);
      raw[flag.slice(2)] = argv[++index];
    }
  }
  if (!raw.vendor || !["codex", "agy", "antigravity"].includes(raw.vendor)) throw new CliError("--vendor must be codex or agy");
  const vendor = normalizeVendor(raw.vendor);
  if (!OPERATIONS.includes(raw.operation)) throw new CliError("--operation must be text, image-analyze, or image-generate");
  if (!raw.brief) throw new CliError("--brief is required");
  const brief = absoluteFrom(startCwd, raw.brief);
  const cwd = absoluteFrom(startCwd, raw.cwd ?? startCwd);
  const inputs = raw.inputs.map((value) => absoluteFrom(startCwd, value));
  const out = raw.out ? absoluteFrom(startCwd, raw.out) : undefined;
  const err = raw.err ? absoluteFrom(startCwd, raw.err) : undefined;
  assertRegularFile(brief, "brief");
  if (statSync(brief).size > MAX_BRIEF_BYTES) throw new CliError("brief exceeds 8MB");
  assertDirectory(cwd, "cwd");
  if (raw.model !== undefined && (raw.model.length === 0 || raw.model.startsWith("-") || /[\x00-\x1f\x7f]/.test(raw.model))) {
    throw new CliError("--model must be non-empty, must not start with '-', and must not contain control characters");
  }
  if (raw.effort !== undefined) {
    if (vendor !== "codex") throw new CliError("--effort is supported only for codex");
    if (!["low", "medium", "high", "xhigh"].includes(raw.effort)) throw new CliError("invalid --effort");
  }
  if (raw.operation === "image-analyze") {
    if (inputs.length === 0) throw new CliError("image-analyze requires at least one --input");
    for (const input of inputs) assertRegularFile(input, "input");
  } else if (inputs.length > 0) throw new CliError("--input is supported only for image-analyze");
  // Default is a large runaway-backstop, NOT a work limit. A short fixed timeout
  // kills legitimate heavy reasoning (codex high/xhigh reading several files) and
  // the child is SIGTERM'd before its final message reaches stdout — the recurring
  // "exit 124, empty out, reasoning stranded in stderr" failure. 30min only catches
  // a genuine hang; callers wanting a tighter bound pass --timeout explicitly.
  const timeout = raw.timeout === undefined ? 1800 : Number(raw.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new CliError("--timeout must be an integer from 1 to 3600");
  const conflicts = outputConflicts({ brief, inputs, out, err });
  if (conflicts.brief) throw new CliError("--out/--err must not equal --brief");
  if (conflicts.input) throw new CliError("--out/--err must not equal --input");
  if (conflicts.outputs) throw new CliError("--out and --err must not refer to the same file");
  if (receiptConflicts({ brief, inputs, out, err }, process.env)) throw new CliError("--out/--err must not equal SECOND_OPINION_RECEIPT");
  return { vendor, operation: raw.operation, brief, cwd, model: raw.model, effort: raw.effort, inputs, timeout, out, err, dryRun: raw.dryRun ?? false };
}

function isGitRepository(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { shell: false, encoding: "utf8", windowsHide: true });
  return result.status === 0 && typeof result.stdout === "string" && result.stdout.trim() === "true";
}
function receiptPath(env) {
  const receipt = env.SECOND_OPINION_RECEIPT?.trim();
  return receipt ? absoluteFrom(process.cwd(), receipt) : undefined;
}
function sameFile(left, right) {
  try {
    const leftInfo = statSync(left);
    const rightInfo = statSync(right);
    return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
  } catch {
    return samePath(left, right);
  }
}
function outputConflicts(options) {
  const outputs = [options.out, options.err].filter(Boolean);
  return {
    brief: outputs.some((output) => sameFile(output, options.brief)),
    input: (options.inputs ?? []).some((input) => outputs.some((output) => sameFile(output, input))),
    outputs: Boolean(options.out && options.err && sameFile(options.out, options.err)),
  };
}
function receiptConflicts(options, env) {
  const receipt = receiptPath(env);
  if (!receipt) return false;
  return [options.brief, ...(options.inputs ?? []), options.out, options.err].filter(Boolean).some((value) => sameFile(receipt, value));
}
function readBoundedRegularFile(path, tooLargeStatus = "file-too-large") {
  try {
    const info = statSync(path);
    if (!info.isFile()) return { status: "not-regular-file" };
    if (info.size > MAX_VENDOR_USAGE_BYTES) return { status: tooLargeStatus };
    return { data: readFileSync(path, "utf8") };
  } catch { return { status: "read-failed" }; }
}
function lastSessionId(stderr) {
  const matches = [...stderr.matchAll(/^session id:\s*(.*?)\s*$/gim)];
  const value = matches.at(-1)?.[1];
  return value && SESSION_ID.test(value) ? value : null;
}
function rolloutFiles(root, sessionId) {
  const found = [];
  const name = new RegExp(`^rollout-.*-${sessionId}\\.jsonl$`, "i");
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (name.test(entry.name)) found.push(path);
        else walk(path);
      } else if (name.test(entry.name)) found.push(path);
    }
  };
  try { walk(join(root, "sessions")); return { files: found }; }
  catch (error) { return error?.code === "ENOENT" ? { files: found } : { status: "read-failed" }; }
}
function lastTokenCount(data) {
  let last = null;
  for (const line of data.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event?.payload?.type === "token_count") last = event.payload;
    } catch { /* A partially flushed JSONL line must not hide an earlier valid event. */ }
  }
  return last;
}
function usageFromTokenCount(payload) {
  const usage = payload?.info?.total_token_usage;
  const values = [usage?.input_tokens, usage?.cached_input_tokens, usage?.output_tokens, usage?.reasoning_output_tokens, usage?.total_tokens];
  if (!values.every(Number.isFinite)) return null;
  const optionalNumber = (value) => Number.isFinite(value) ? value : null;
  return {
    source: "codex-rollout",
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
    totalTokens: usage.total_tokens,
    contextWindow: optionalNumber(payload.info.model_context_window),
    quotaUsedPercent: optionalNumber(payload.rate_limits?.primary?.used_percent),
  };
}
function waitForRollout() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
function collectVendorUsage(options, invoked, env) {
  if (options.vendor !== "codex") return { usage: null, status: "unsupported-vendor" };
  if (!invoked) return { usage: null, status: "not-invoked" };
  if (!options.err) return { usage: null, status: "no-err-file" };
  let result = { usage: null, status: "no-session-id", retry: true };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stderr = readBoundedRegularFile(options.err);
    if (stderr.status) return { usage: null, status: stderr.status };
    const sessionId = lastSessionId(stderr.data);
    if (!sessionId) result = { usage: null, status: "no-session-id", retry: true };
    else {
      const root = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
      const matches = rolloutFiles(root, sessionId);
      if (matches.status) return { usage: null, status: matches.status };
      if (matches.files.length === 0) result = { usage: null, status: "no-rollout-file", retry: true };
      else if (matches.files.length > 1) return { usage: null, status: "ambiguous-rollout-file" };
      else {
        const rollout = readBoundedRegularFile(matches.files[0]);
        if (rollout.status) return { usage: null, status: rollout.status };
        const tokenCount = lastTokenCount(rollout.data);
        if (!tokenCount) result = { usage: null, status: "no-token-count", retry: true };
        else {
          const usage = usageFromTokenCount(tokenCount);
          return usage ? { usage, status: "ok" } : { usage: null, status: "invalid-token-fields" };
        }
      }
    }
    if (attempt < 3) waitForRollout();
  }
  return { usage: null, status: result.status };
}
function writeReceipt(stderr, options, exit, startedAt, invoked, env = process.env) {
  const duration = ((Date.now() - startedAt) / 1000).toFixed(3);
  stderr.write(`[dispatch] vendor=${options.vendor} op=${options.operation} model=${options.model ?? "-"} exit=${exit} duration=${duration}s\n`);
  try {
    const receipt = receiptPath(env);
    if (!receipt) return;
    if ([options.brief, ...(options.inputs ?? []), options.out, options.err].filter(Boolean).some((value) => sameFile(receipt, value))) return;
    mkdirSync(dirname(receipt), { recursive: true });
    const existing = statSync(receipt, { throwIfNoEntry: false });
    let separator = "";
    if (existing?.size) {
      const fd = openSync(receipt, "r");
      try {
        const lastByte = Buffer.alloc(1);
        readSync(fd, lastByte, 0, 1, existing.size - 1);
        if (lastByte[0] !== 0x0a) separator = "\n";
      } finally { closeSync(fd); }
    }
    let vendorUsage = { usage: null, status: "read-failed" };
    try { vendorUsage = collectVendorUsage(options, invoked, env); }
    catch { /* Usage is additive; its own failure must not suppress the receipt. */ }
    appendFileSync(receipt, `${separator}${JSON.stringify({ schemaVersion: 1, ts: new Date().toISOString(), vendor: options.vendor, operation: options.operation, model: options.model ?? null, effort: options.effort ?? null, exit, durationSec: Number(duration), invoked, cwd: options.cwd, outPath: options.out ?? null, errPath: options.err ?? null, pid: process.pid, vendorUsage: vendorUsage.usage, vendorUsageStatus: vendorUsage.status })}\n`);
  } catch { /* Receipt recording must not affect dispatch. */ }
}
function openOutput(path) {
  const fd = openSync(path, "w");
  try { return createWriteStream(path, { fd, autoClose: true }); }
  catch (error) { closeSync(fd); throw error; }
}

// Bounded, cross-platform termination of the child AND its descendants. child.kill()
// signals only the direct process — on Windows it does not touch the tree at all — so
// a vendor that ignores SIGTERM, or leaves a descendant holding a stdio pipe, would
// keep the dispatcher waiting on `close` forever. With agy now running full-access,
// that stranded descendant also keeps running. This is the forced-kill escalation.
function defaultForceKill(child) {
  const pid = child?.pid;
  if (process.platform === "win32") {
    if (Number.isInteger(pid) && pid > 0) {
      try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true }); } catch { /* best effort */ }
    }
  } else {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

export async function run(options, deps = { spawn }) {
  options = {
    ...options,
    brief: absoluteFrom(process.cwd(), options.brief),
    inputs: (options.inputs ?? []).map((input) => absoluteFrom(process.cwd(), input)),
    out: options.out ? absoluteFrom(process.cwd(), options.out) : undefined,
    err: options.err ? absoluteFrom(process.cwd(), options.err) : undefined,
  };
  const spawnImpl = deps.spawn;
  const env = deps.env ?? process.env;
  const parentStdout = deps.stdout ?? process.stdout;
  const parentStderr = deps.stderr ?? process.stderr;
  const startedAt = Date.now();
  const conflicts = outputConflicts(options);
  if (conflicts.brief) {
    parentStderr.write("dispatch validation error: --out/--err must not equal --brief\n");
    return 2;
  }
  if (conflicts.input) {
    parentStderr.write("dispatch validation error: --out/--err must not equal --input\n");
    return 2;
  }
  if (conflicts.outputs) {
    parentStderr.write("dispatch validation error: --out and --err must not refer to the same file\n");
    return 2;
  }
  if (receiptConflicts(options, env)) {
    parentStderr.write("dispatch validation error: --out/--err must not equal SECOND_OPINION_RECEIPT\n");
    return 2;
  }
  const isGitRepo = options.isGitRepo ?? isGitRepository(options.cwd);
  const argv = buildVendorArgv({ ...options, isGitRepo });
  if (options.dryRun) {
    parentStdout.write(`${JSON.stringify({ vendor: options.vendor, operation: options.operation, executable: executableName(options.vendor), argv, stdinMode: "brief-file", cwd: options.cwd })}\n`);
    writeReceipt(parentStderr, options, 0, startedAt, false, env);
    return 0;
  }
  let brief;
  try { brief = readFileSync(options.brief); }
  catch (error) {
    parentStderr.write(`dispatch internal error: unable to read brief (${error.code ?? "read_failed"})\n`);
    writeReceipt(parentStderr, options, 3, startedAt, false, env);
    return 3;
  }
  let executable;
  try { executable = spawnImpl === spawn ? resolveExecutable(options.vendor) : executableName(options.vendor); }
  catch (error) {
    const code = error instanceof PolicyError ? 2 : 3;
    parentStderr.write(`${error.message ?? "dispatch executable resolution failed"}\n`);
    writeReceipt(parentStderr, options, code, startedAt, false, env);
    return code;
  }
  let stdoutStream;
  let stderrStream;
  try {
    stdoutStream = options.out ? openOutput(options.out) : null;
    stderrStream = options.err ? openOutput(options.err) : null;
  } catch (error) {
    stdoutStream?.destroy();
    stderrStream?.destroy();
    parentStderr.write(`dispatch internal error: unable to open output file (${error.code ?? "open_failed"})\n`);
    writeReceipt(parentStderr, options, 3, startedAt, false, env);
    return 3;
  }
  return await new Promise((resolveRun) => {
    let settled = false;
    let timedOut = false;
    let invoked = false;
    let child;
    let timer, escalateTimer, reapTimer;
    const clearTimers = () => { for (const t of [timer, escalateTimer, reapTimer]) if (t) clearTimeout(t); };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      writeReceipt(parentStderr, options, code === 124 ? "timeout" : code, startedAt, invoked, env);
      resolveRun(code);
    };
    try {
      const spawnOptions = { cwd: options.cwd, shell: false, stdio: ["pipe", stdoutStream ? "pipe" : "inherit", stderrStream ? "pipe" : "inherit"], windowsHide: true };
      if (receiptPath(env)) {
        spawnOptions.env = { ...env };
        for (const key of Object.keys(spawnOptions.env)) {
          if (key.toUpperCase() === "SECOND_OPINION_RECEIPT") delete spawnOptions.env[key];
        }
      }
      child = spawnImpl(executable, argv, spawnOptions);
    } catch (error) {
      stdoutStream?.destroy();
      stderrStream?.destroy();
      parentStderr.write(`dispatch internal error: spawn failed (${error.code ?? "spawn_failed"})\n`);
      finish(3);
      return;
    }
    const graceMs = options.killGraceMs ?? 5000;
    const reapMs = options.reapMs ?? 3000;
    const forceKill = options.forceKill ?? defaultForceKill;
    child.once("spawn", () => { invoked = true; });
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }          // graceful SIGTERM first
      escalateTimer = setTimeout(() => {                            // still not closed → force-kill the whole tree
        try { forceKill(child); } catch { /* best effort */ }
        reapTimer = setTimeout(() => finish(124), reapMs);         // bounded: resolve even if `close` never fires
        reapTimer.unref?.();
      }, graceMs);
      escalateTimer.unref?.();
    }, options.timeout * 1000);
    timer.unref?.();
    const streamError = (error) => {
      parentStderr.write(`dispatch internal error: stdio failed (${error.code ?? "stdio_failed"})\n`);
      child.kill();
      finish(3);
    };
    child.once("error", (error) => {
      parentStderr.write(`dispatch internal error: spawn failed (${error.code ?? "spawn_failed"})\n`);
      finish(3);
    });
    child.once("close", (code, signal) => {
      if (timedOut) finish(124);
      else if (signal || code === null) finish(3);
      else finish(code);
    });
    child.stdin.once("error", streamError);
    stdoutStream?.once("error", streamError);
    stderrStream?.once("error", streamError);
    if (stdoutStream) child.stdout.pipe(stdoutStream);
    if (stderrStream) child.stderr.pipe(stderrStream);
    try { child.stdin.end(brief); } catch (error) { streamError(error); }
  });
}

async function main() {
  process.exitCode = await executeCli(process.argv.slice(2));
}

export async function executeCli(argv, deps = {}) {
  let options;
  const stderr = deps.stderr ?? process.stderr;
  try { options = parseCli(argv, deps.cwd ?? process.cwd()); }
  catch (error) {
    stderr.write(`dispatch validation error: ${error.message}\n`);
    return 2;
  }
  const runDeps = deps.spawn ? { spawn: deps.spawn, stdout: deps.stdout, stderr } : { spawn, stdout: deps.stdout, stderr };
  return await run(options, runDeps);
}

// Compare real paths so junction/symlink invocation still reaches main().
function invokedAsMain() {
  try {
    return !!process.argv[1] &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    try {
      const a = fileURLToPath(import.meta.url), b = resolve(process.argv[1]);
      const norm = (s) => (process.platform === "win32" || process.platform === "darwin") ? s.toLowerCase() : s;
      return !!process.argv[1] && norm(a) === norm(b);
    } catch { return false; }
  }
}
if (invokedAsMain()) await main();
