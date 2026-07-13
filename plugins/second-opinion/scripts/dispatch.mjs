import { spawn, spawnSync } from "node:child_process";
import { closeSync, createWriteStream, openSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONS, PolicyError, buildVendorArgv, executableName, normalizeVendor, resolveExecutable } from "./vendor-policy.mjs";

const MAX_BRIEF_BYTES = 8 * 1024 * 1024;
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
  const timeout = raw.timeout === undefined ? 280 : Number(raw.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new CliError("--timeout must be an integer from 1 to 3600");
  if ((out && samePath(out, brief)) || (err && samePath(err, brief))) throw new CliError("--out/--err must not equal --brief");
  return { vendor, operation: raw.operation, brief, cwd, model: raw.model, effort: raw.effort, inputs, timeout, out, err, dryRun: raw.dryRun ?? false };
}

function isGitRepository(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { shell: false, encoding: "utf8", windowsHide: true });
  return result.status === 0 && typeof result.stdout === "string" && result.stdout.trim() === "true";
}
function writeReceipt(stderr, options, exit, startedAt) {
  const duration = ((Date.now() - startedAt) / 1000).toFixed(3);
  stderr.write(`[dispatch] vendor=${options.vendor} op=${options.operation} model=${options.model ?? "-"} exit=${exit} duration=${duration}s\n`);
}
function openOutput(path) {
  const fd = openSync(path, "w");
  try { return createWriteStream(path, { fd, autoClose: true }); }
  catch (error) { closeSync(fd); throw error; }
}

export async function run(options, deps = { spawn }) {
  const spawnImpl = deps.spawn;
  const parentStdout = deps.stdout ?? process.stdout;
  const parentStderr = deps.stderr ?? process.stderr;
  const startedAt = Date.now();
  const isGitRepo = options.isGitRepo ?? isGitRepository(options.cwd);
  const argv = buildVendorArgv({ ...options, isGitRepo });
  if (options.dryRun) {
    parentStdout.write(`${JSON.stringify({ vendor: options.vendor, operation: options.operation, executable: executableName(options.vendor), argv, stdinMode: "brief-file", cwd: options.cwd })}\n`);
    writeReceipt(parentStderr, options, 0, startedAt);
    return 0;
  }
  let brief;
  try { brief = readFileSync(options.brief); }
  catch (error) {
    parentStderr.write(`dispatch internal error: unable to read brief (${error.code ?? "read_failed"})\n`);
    writeReceipt(parentStderr, options, 3, startedAt);
    return 3;
  }
  let executable;
  try { executable = spawnImpl === spawn ? resolveExecutable(options.vendor) : executableName(options.vendor); }
  catch (error) {
    const code = error instanceof PolicyError ? 2 : 3;
    parentStderr.write(`${error.message ?? "dispatch executable resolution failed"}\n`);
    writeReceipt(parentStderr, options, code, startedAt);
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
    writeReceipt(parentStderr, options, 3, startedAt);
    return 3;
  }
  return await new Promise((resolveRun) => {
    let settled = false;
    let timedOut = false;
    let child;
    let timer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      writeReceipt(parentStderr, options, code === 124 ? "timeout" : code, startedAt);
      resolveRun(code);
    };
    try {
      child = spawnImpl(executable, argv, { cwd: options.cwd, shell: false, stdio: ["pipe", stdoutStream ? "pipe" : "inherit", stderrStream ? "pipe" : "inherit"], windowsHide: true });
    } catch (error) {
      stdoutStream?.destroy();
      stderrStream?.destroy();
      parentStderr.write(`dispatch internal error: spawn failed (${error.code ?? "spawn_failed"})\n`);
      finish(3);
      return;
    }
    timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeout * 1000);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
