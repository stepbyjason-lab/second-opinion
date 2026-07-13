import { accessSync, constants, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const VENDORS = Object.freeze(["codex", "agy"]);
export const OPERATIONS = Object.freeze(["text", "image-analyze", "image-generate"]);
export const CODEX_INFERENCE_SUBCOMMAND = "exec";
export const AGY_MANAGEMENT_COMMANDS = Object.freeze([
  "--version", "-v", "models", "--help", "-h", "login", "logout", "update",
]);

export class PolicyError extends Error {
  constructor(classification, message) {
    super(message);
    this.name = "PolicyError";
    this.classification = classification;
  }
}

export function normalizeVendor(value) { return value === "antigravity" ? "agy" : value; }
export function executableName(vendor) { return normalizeVendor(vendor) === "agy" ? "agy" : "codex"; }
function regularFile(path) { try { return statSync(path).isFile(); } catch { return false; } }
function posixExecutable(path) {
  if (!regularFile(path)) return false;
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function resolveExecutable(vendor, options = {}) {
  const normalized = normalizeVendor(vendor);
  const name = executableName(normalized);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathValue = options.pathValue ?? env.PATH ?? "";
  const separator = platform === "win32" ? ";" : ":";
  let foundChannelMixing = false;
  let foundNonExecutable = false;
  for (const entry of pathValue.split(separator).filter(Boolean)) {
    let directory;
    try {
      directory = resolve(entry.replace(/^"|"$/g, ""));
      if (!statSync(directory).isDirectory()) continue;
    } catch { continue; }
    if (platform === "win32") {
      const executable = resolve(directory, `${name}.exe`);
      if (regularFile(executable)) return executable;
      if (regularFile(resolve(directory, `${name}.cmd`)) || regularFile(resolve(directory, `${name}.bat`))) foundChannelMixing = true;
    } else {
      const executable = resolve(directory, name);
      if (posixExecutable(executable)) return executable;
      if (regularFile(executable)) foundNonExecutable = true;
      if (regularFile(resolve(directory, `${name}.cmd`)) || regularFile(resolve(directory, `${name}.bat`))) foundChannelMixing = true;
    }
  }
  if (normalized === "agy" && platform === "win32" && env.LOCALAPPDATA) {
    const fallback = resolve(env.LOCALAPPDATA, "agy", "bin", "agy.exe");
    if (regularFile(fallback)) return fallback;
  }
  if (foundChannelMixing) {
    const installer = normalized === "codex" ? "official Codex install.ps1" : "official Antigravity install.ps1/sh";
    throw new PolicyError("channel_mixing", `channel_mixing: only .cmd/.bat was found for ${name}; reinstall with the ${installer}`);
  }
  if (foundNonExecutable) throw new PolicyError("not_executable", `not_executable: ${name} exists but is not executable`);
  throw new PolicyError("executable_not_found", `executable_not_found: canonical ${name} executable was not found`);
}

export function buildVendorArgv(options) {
  const vendor = normalizeVendor(options.vendor);
  const { operation, model, effort } = options;
  const inputs = options.inputs ?? [];
  const isGitRepo = options.isGitRepo ?? true;
  if (vendor === "codex") {
    const argv = ["exec"];
    if (operation === "image-generate") argv.push("-s", "workspace-write");
    if (!isGitRepo) argv.push("--skip-git-repo-check");
    if (model) argv.push("-m", model);
    if (effort) argv.push("-c", `model_reasoning_effort="${effort}"`);
    if (operation === "image-analyze") for (const input of inputs) argv.push("-i", input);
    argv.push("-");
    return argv;
  }
  const argv = [];
  if (model) argv.push("--model", model);
  if (operation === "image-analyze") {
    const seen = new Set();
    for (const input of inputs) {
      const directory = dirname(input);
      if (!seen.has(directory)) { seen.add(directory); argv.push("--add-dir", directory); }
    }
  }
  return argv;
}

function tokenizeShell(command) {
  const segments = [[]];
  let token = "";
  let quote = null;
  const pushToken = () => { if (token !== "") segments.at(-1).push(token); token = ""; };
  const split = () => { pushToken(); if (segments.at(-1).length > 0) segments.push([]); };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && ["\\", '"'].includes(command[i + 1])) token += command[++i];
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (char === "\n" || char === "\r") split(); else pushToken(); continue; }
    if (char === ";" || char === "|" || char === "&") {
      split();
      if ((char === "|" || char === "&") && command[i + 1] === char) i += 1;
      continue;
    }
    token += char;
  }
  pushToken();
  return segments.filter((segment) => segment.length > 0);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const TRANSPARENT_WRAPPERS = new Set(["timeout", "env", "nice", "nohup", "stdbuf", "time", "command"]);
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "cmd", "cmd.exe", "powershell", "pwsh", "powershell.exe", "pwsh.exe"]);
function commandBase(token) { return basename(token.replace(/^&\s*/, "").replace(/\\/g, "/")).toLowerCase(); }
function vendorFromCommand(token) {
  const normalized = token.trim().replace(/^&\s*/, "").replace(/^"|"$/g, "").toLowerCase();
  if (/^\$\{?codex\}?$/.test(normalized)) return "codex";
  if (/^\$\{?agy\}?$/.test(normalized)) return "agy";
  const base = commandBase(normalized).replace(/\.exe$/, "");
  return base === "codex" || base === "agy" ? base : null;
}
function skipToCommand(tokens) {
  let index = 0;
  while (ASSIGNMENT.test(tokens[index] ?? "")) index += 1;
  while (index < tokens.length && TRANSPARENT_WRAPPERS.has(commandBase(tokens[index]))) {
    const wrapper = commandBase(tokens[index++]);
    while (index < tokens.length) {
      const value = tokens[index];
      if (value === "--") { index += 1; break; }
      const consumesNext = {
        timeout: ["-s", "--signal", "-k", "--kill-after"],
        env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
        nice: ["-n", "--adjustment"],
        stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
        time: ["-f", "--format", "-o", "--output"],
      }[wrapper]?.includes(value);
      if (consumesNext) { index += 2; continue; }
      if (ASSIGNMENT.test(value) || value.startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(value)) { index += 1; continue; }
      break;
    }
    while (ASSIGNMENT.test(tokens[index] ?? "")) index += 1;
  }
  return index;
}
function shellPayload(tokens, index) {
  const shell = commandBase(tokens[index]);
  if (!SHELL_WRAPPERS.has(shell)) return null;
  const rest = tokens.slice(index + 1);
  if (shell === "cmd" || shell === "cmd.exe") {
    const marker = rest.findIndex((value) => value.toLowerCase() === "/c");
    return marker >= 0 ? rest.slice(marker + 1).join(" ") : null;
  }
  const marker = rest.findIndex((value) => ["-c", "-lc"].includes(value.toLowerCase()));
  return marker >= 0 ? rest.slice(marker + 1).join(" ") : null;
}
function detectSegment(tokens, depth) {
  const index = skipToCommand(tokens);
  if (index >= tokens.length) return null;
  const nested = shellPayload(tokens, index);
  if (nested && depth < 4) return detectDirectInference(nested, depth + 1);
  const vendor = vendorFromCommand(tokens[index]);
  if (!vendor) return null;
  const next = (tokens[index + 1] ?? "").toLowerCase();
  if (vendor === "codex") return next === CODEX_INFERENCE_SUBCOMMAND ? vendor : null;
  return AGY_MANAGEMENT_COMMANDS.includes(next) ? null : vendor;
}
export function detectDirectInference(command, depth = 0) {
  if (typeof command !== "string") return null;
  for (const segment of tokenizeShell(command)) {
    const vendor = detectSegment(segment, depth);
    if (vendor) return vendor;
  }
  return null;
}
