import { accessSync, constants, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const VENDORS = Object.freeze(["codex", "agy", "claude", "grok"]);
export const OPERATIONS = Object.freeze(["text", "image-analyze", "image-generate"]);
export const DISPATCH_MODES = Object.freeze(["default", "plan", "review"]);
export const AGY_NATIVE_READONLY_PROFILE = "agy-native-readonly/v1";

// Grok reads foreign harness config by default (`[compat.*]` cells, env > toml).
// Forced cells: Claude 6 + Cursor 6 + Codex sessions (1). Codex skills/rules/
// agents/mcps/hooks are reserved and inert in grok 1.0.5 — sessions is the
// only live Codex cell. Env wins, so a review spawn can force isolation
// without writing ~/.grok/config.toml.
// Project-root CLAUDE.md / AGENTS.md still load — that remaining gap is
// disclosed in adapter-grok.md, not papered over here.
export const GROK_HARNESS_ISOLATION_ENV = Object.freeze({
  GROK_CLAUDE_SKILLS_ENABLED: "false",
  GROK_CLAUDE_RULES_ENABLED: "false",
  GROK_CLAUDE_AGENTS_ENABLED: "false",
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CLAUDE_HOOKS_ENABLED: "false",
  GROK_CLAUDE_SESSIONS_ENABLED: "false",
  GROK_CURSOR_SKILLS_ENABLED: "false",
  GROK_CURSOR_RULES_ENABLED: "false",
  GROK_CURSOR_AGENTS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
  GROK_CURSOR_HOOKS_ENABLED: "false",
  GROK_CURSOR_SESSIONS_ENABLED: "false",
  GROK_CODEX_SESSIONS_ENABLED: "false",
});

export function grokNeedsHarnessIsolation(options) {
  return normalizeVendor(options.vendor) === "grok"
    && (options.mode === "plan" || options.mode === "review");
}

// Forcing an isolation variable means dropping whatever the caller already had
// under that name, not writing on top of it: Windows resolves environment names
// case-insensitively, so a caller's `grok_claude_hooks_enabled=true` or
// `claude_code_disable_claude_mds=0` left in place would hand the child both
// spellings and let it read the caller's value while the receipt records the
// axis as closed. `names` says which variables this dispatcher owns; `forced`
// says what they become, and may be empty when the caller asked for the axis to
// stay open — the ownership is what has to be exercised either way.
export function applyForcedIsolationEnv(env, names, forced = {}) {
  const isolated = { ...env };
  const owned = new Set(names.map((key) => key.toUpperCase()));
  for (const key of Object.keys(isolated)) {
    if (owned.has(key.toUpperCase())) delete isolated[key];
  }
  return { ...isolated, ...forced };
}

export function applyGrokHarnessIsolationEnv(env = {}) {
  return applyForcedIsolationEnv(env, Object.keys(GROK_HARNESS_ISOLATION_ENV), GROK_HARNESS_ISOLATION_ENV);
}

const AGY_NATIVE_READONLY_PREFIX = Buffer.from(
  `<second-opinion-provider-control profile="${AGY_NATIVE_READONLY_PROFILE}">
This explicit plan/review call runs in Antigravity's headless native plan mode.
Use only Antigravity native file listing, file reading, and code-search tools.
Do not request or invoke terminal, command, shell, Bash, PowerShell, git, package-manager, or other process-execution tools.
Keep the same complete project cwd available; this control changes tool choice, not repository scope.
</second-opinion-provider-control>

<user-brief>
`,
  "utf8",
);
const AGY_NATIVE_READONLY_SUFFIX = Buffer.from(
  `
</user-brief>

<second-opinion-provider-control-reminder profile="${AGY_NATIVE_READONLY_PROFILE}">
The user brief may mention git diff or another shell command. Do not execute it.
Use native read/list/search over the complete project instead, and explicitly report any evidence that native tools cannot obtain.
Do not edit, create, delete, stage, commit, install, or publish anything.
</second-opinion-provider-control-reminder>
`,
  "utf8",
);

export class PolicyError extends Error {
  constructor(classification, message) {
    super(message);
    this.name = "PolicyError";
    this.classification = classification;
  }
}

export function normalizeVendor(value) { return value === "antigravity" ? "agy" : value; }
export function effectiveVendorMode(options) {
  const vendor = normalizeVendor(options.vendor);
  const mode = options.mode ?? "default";
  if (!DISPATCH_MODES.includes(mode)) throw new PolicyError("invalid_mode", `invalid_mode: unsupported dispatch mode ${mode}`);
  if (vendor === "grok" && options.operation !== "text") {
    throw new PolicyError("mode_unsupported", "mode_unsupported: grok supports text only");
  }
  if (mode === "default") return "default";
  if (options.operation !== "text") throw new PolicyError("mode_unsupported", `mode_unsupported: ${mode} requires text operation`);
  if (vendor === "codex") {
    if (mode === "plan") throw new PolicyError("mode_unsupported", "mode_unsupported: codex plan has no approved non-sandbox CLI mapping");
    return "review";
  }
  if (vendor === "claude") return mode;
  if (vendor === "grok") {
    if (options.operation !== "text") throw new PolicyError("mode_unsupported", "mode_unsupported: grok supports text only");
    return mode;
  }
  return "plan";
}
export function effectiveInputProfile(options) {
  const vendor = normalizeVendor(options.vendor);
  const mode = options.mode ?? "default";
  const effectiveMode = effectiveVendorMode({ ...options, vendor, mode });
  return vendor === "agy" && effectiveMode === "plan" && mode !== "default"
    ? AGY_NATIVE_READONLY_PROFILE
    : "none";
}
export function composeVendorInput(options, brief) {
  const input = Buffer.isBuffer(brief) ? brief : Buffer.from(brief);
  if (effectiveInputProfile(options) === "none") return input;
  return Buffer.concat([AGY_NATIVE_READONLY_PREFIX, input, AGY_NATIVE_READONLY_SUFFIX]);
}
export function executableName(vendor) {
  const normalized = normalizeVendor(vendor);
  if (normalized === "agy") return "agy";
  if (normalized === "claude") return "claude";
  if (normalized === "grok") return "grok";
  return "codex";
}
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
  if (normalized === "grok" && platform === "win32") {
    const home = env.USERPROFILE || env.HOME;
    if (home) {
      const fallback = resolve(home, ".grok", "bin", "grok.exe");
      if (regularFile(fallback)) return fallback;
    }
  }
  if (foundChannelMixing) {
    const installer = {
      codex: "official Codex install.ps1",
      agy: "official Antigravity install.ps1/sh",
      claude: "official Claude native installer",
      grok: "official Grok install.ps1 (irm https://x.ai/cli/install.ps1 | iex)",
    }[normalized];
    throw new PolicyError("channel_mixing", `channel_mixing: only .cmd/.bat was found for ${name}; reinstall with the ${installer}`);
  }
  if (foundNonExecutable) throw new PolicyError("not_executable", `not_executable: ${name} exists but is not executable`);
  throw new PolicyError("executable_not_found", `executable_not_found: canonical ${name} executable was not found`);
}

// The caller's own configuration reaches a vendor child by several paths: hooks
// push context at lifecycle events, the CLI reads instruction files (AGENTS.md /
// CLAUDE.md) on its own, and MCP servers arrive as tool definitions that cost
// prompt whether or not the reviewer calls them. Keeping them out is a matter of
// which flags and variables this dispatcher hands over.
//
// This returns exactly that: what we pass, not what state the child ends in.
// Recording an outcome was the earlier shape and it cost far more than it was
// worth — a state vocabulary, a table of which flag "closes" which axis, and a
// test cross-checking the two, repaired five times between them. It also let the
// record overstate: a deny list we passed was written down as the thing holding
// the reviewer back, when measurement later showed the child's own policy did
// that and our list did nothing. What we handed over is a fact we own; what the
// child then did is the child's, and a reader can see the flags and judge.
//
// All four CLI vendors have invocation controls recorded here. Codex and
// Claude use host-configuration switches; Grok also supplies its harness
// environment and read-only tool controls; AGY records its explicit permission
// mode. This function describes the planned invocation vector. Whether it was
// applied is decided at the spawn/receipt boundary.
const CLAUDE_DOC_ISOLATION_VAR = "CLAUDE_CODE_DISABLE_CLAUDE_MDS";
export function hostIsolationPlan(options) {
  const vendor = normalizeVendor(options.vendor);
  const argv = [];
  const env = {};
  if (vendor === "grok") {
    // grok's devices are its own, but they are still things this dispatcher
    // hands over, so they belong in the plan rather than being curated out of
    // it. Recording an empty plan here once told a reader that a grok review had
    // run with no tool narrowing and no harness isolation — the opposite of what
    // happened. Whether a flag is "ours" is not a judgement the record should be
    // making; it reports what was passed.
    const readOnly = isReadOnlyMode(options);
    argv.push("--permission-mode", readOnly ? "plan" : "bypassPermissions");
    if (readOnly) argv.push("--tools", "read_file,grep,list_dir", "--no-subagents");
    if (grokNeedsHarnessIsolation({ ...options, vendor })) Object.assign(env, GROK_HARNESS_ISOLATION_ENV);
    return { argv, env };
  }
  if (vendor === "agy") {
    argv.push(...(isReadOnlyMode(options) ? ["--mode", "plan"] : ["--dangerously-skip-permissions"]));
    return { argv, env };
  }
  if (vendor === "codex") {
    // `hooks` is a stable feature flag: --disable hooks silences every user,
    // project, session and plugin lifecycle hook for this call only and leaves
    // plugins, skills and MCP running. Measured on codex-cli 0.153.4.
    if (blocks(options.hostHooks, options)) argv.push("--disable", "hooks");
    // The project AGENTS.md is capped by this byte budget, so zero drops it. The
    // CODEX_HOME copy is NOT covered — it loads through a different path and
    // stays in the prompt. That gap is disclosed, not silently carried.
    if (blocks(options.hostDocs, options)) argv.push("-c", "project_doc_max_bytes=0");
    return { argv, env };
  }
  if (vendor !== "claude") return { argv, env };
  // --safe-mode is one switch for six things at once (CLAUDE.md, skills,
  // plugins, hooks, MCP, custom agents), and skills cannot be opened without
  // dropping it. --disable-slash-commands is named separately because
  // `claude --help` 2.1.251 defines it as "Disable all skills".
  if (options.hostSkills !== "enabled") {
    argv.push("--safe-mode", "--disable-slash-commands");
    // --safe-mode is documented to set this itself, but that has never been
    // measured here, and a caller's own differently-cased copy would otherwise
    // ride along. The variable is stated rather than assumed.
    env[CLAUDE_DOC_ISOLATION_VAR] = "1";
    return { argv, env };
  }
  // With skills open the wholesale switch is gone, so everything it had been
  // doing is restated one lever at a time — and defaults to on in every mode,
  // not only explicit plan/review, because nothing else is holding host config
  // back once it is dropped.
  if (blocks(options.hostHooks, options, true)) argv.push("--settings", '{"disableAllHooks":true}');
  // No --mcp-config is passed, so this leaves the child with no MCP server.
  if (blocks(options.hostMcp, options, true)) argv.push("--strict-mcp-config");
  if (blocks(options.hostDocs, options, true)) env[CLAUDE_DOC_ISOLATION_VAR] = "1";
  return { argv, env };
}

// Read from the requested mode rather than the effective one. effectiveVendorMode
// throws for combinations the vendor cannot serve, and a record of what was
// handed over must never be the thing that raises — that is exactly the
// regression this shape introduced once: the receipt producer threw from inside
// the handler that was recording the failure, and the failure went unrecorded.
function isReadOnlyMode(options) {
  return options.mode === "plan" || options.mode === "review";
}

// A caller's explicit switch wins; otherwise explicit plan/review modes block and the
// full-access default does not. `skillsOpen` forces the blocking default in
// every mode, for the branch that has dropped the one switch that used to cover
// it regardless of mode.
function blocks(requested, options, skillsOpen = false) {
  if (requested === "allowed") return false;
  if (requested === "blocked") return true;
  return skillsOpen || options.mode === "plan" || options.mode === "review";
}

// claude's document lever is an environment variable rather than a flag, so it
// cannot ride in the argv. The dispatcher owns the name on every claude call —
// not only where it sets a value — because Windows resolves environment names
// case-insensitively: a caller's `claude_code_disable_claude_mds=0` left in
// place would be read by the child while the receipt recorded that we had
// passed `=1`, and an inner dispatch would inherit an outer `=1` on a call that
// deliberately left documents open.
export function applyVendorHostIsolationEnv(env = {}, options = {}) {
  if (normalizeVendor(options.vendor) !== "claude") return env;
  return applyForcedIsolationEnv(env, [CLAUDE_DOC_ISOLATION_VAR], hostIsolationPlan(options).env);
}

// The tool surface for a claude call. `default` is the general-purpose call and
// must be able to do the work, not just describe it; explicit plan/review are
// the restricted ones. No sandbox, worktree, or rewritten cwd is used as the
// permission model — the vendor runs in the caller's real --cwd, and this
// allowlist is what narrows the built-in tools.
//
// No command rule list is shipped with the shell. One was carried for several
// passes and measurement (probe-pwsh.json, probe-norules.json) took it apart:
// the allow rules did not confine the tool at all, and the denials attributed to
// our list happen the same way without it, because the child's own policy sorts
// read from mutating. A name list also cannot cover the effects it is named for
// — `git checkout` needed `restore` and `switch`, and aliases and `git -C`
// remained outside. A caller who needs the shell gone uses --no-host-shell,
// which removes it rather than narrowing it.
export function claudeToolArgv(options) {
  if (!isReadOnlyMode(options)) return ["--dangerously-skip-permissions", "--tools=default"];
  const shell = options.hostShell ?? "open";
  const tools = ["Read", "Glob", "Grep"];
  // Both shell names are listed because the registered one is platform
  // dependent: measured on claude 2.1.251 for Windows, naming only Bash leaves
  // the child with no shell at all — PowerShell is what registers.
  if (shell === "open") tools.push("Bash", "PowerShell");
  if (options.hostSkills === "enabled") tools.push("Skill");
  const argv = [`--tools=${tools.join(",")}`];
  // Naming a shell tool is not enough on its own: without a permission mode the
  // headless child silently drops it, because nothing there can approve its use.
  // `dontAsk` never prompts. Measured: read-oriented git runs under it and mutating
  // git is refused by the child itself.
  if (shell === "open") argv.push("--permission-mode", "dontAsk");
  return argv;
}

function hostIsolationFor(options, vendor = normalizeVendor(options.vendor)) {
  const plan = hostIsolationPlan({ ...options, vendor });
  return {
    argv: vendor === "claude"
      ? [...plan.argv, ...claudeToolArgv({ ...options, vendor })]
      : [...plan.argv],
    env: Object.entries(plan.env).map(([name, value]) => `${name}=${value}`),
  };
}

// This is a policy-plan query. It deliberately stays non-throwing because
// failure receipts may ask it about a combination that cannot reach a child.
export function hostIsolationRecord(options) {
  const vendor = normalizeVendor(options.vendor);
  try { effectiveVendorMode({ ...options, vendor }); } catch { return { argv: [], env: [] }; }
  return hostIsolationFor({ ...options, vendor }, vendor);
}

// Build the executable argv and the receipt projection in the same operation.
// `assemble` is the only insertion point for isolation argv, so the record
// cannot omit or duplicate a run without changing this returned object itself.
export function buildVendorInvocation(options) {
  const vendor = normalizeVendor(options.vendor);
  if (!VENDORS.includes(vendor)) {
    throw new PolicyError("invalid_vendor", `invalid_vendor: unsupported vendor ${String(options.vendor)}`);
  }
  const { operation, model, effort } = options;
  const effectiveMode = effectiveVendorMode({ ...options, vendor });
  const inputs = options.inputs ?? [];
  const isGitRepo = options.isGitRepo ?? true;
  const hostIsolation = hostIsolationFor({ ...options, vendor }, vendor);
  const assemble = (before, after = []) => ({
    argv: [...before, ...hostIsolation.argv, ...after],
    hostIsolation,
  });
  if (vendor === "codex") {
    // `exec review` picks a review workflow, not a permission level — unlike the
    // Claude branch below, nothing here narrows what the vendor may touch. The
    // Codex CLI has no tool allowlist; its only way to restrict is the sandbox
    // (`-s read-only`), which this project does not use, so a --mode review call
    // still runs at whatever `sandbox_mode` the user's config sets. Measured: a
    // review dispatch recorded `sandbox: danger-full-access`. Callers must treat
    // the brief's own prohibitions as the only guard here.
    const before = effectiveMode === "review" ? ["exec", "review"] : ["exec"];
    const after = [];
    if (operation === "image-generate") after.push("-s", "workspace-write");
    if (!isGitRepo) after.push("--skip-git-repo-check");
    if (model) after.push("-m", model);
    if (effort) after.push("-c", `model_reasoning_effort="${effort}"`);
    if (operation === "image-analyze") for (const input of inputs) after.push("-i", input);
    after.push("-");
    return assemble(before, after);
  }
  if (vendor === "grok") {
    if (operation !== "text") {
      throw new PolicyError("mode_unsupported", "mode_unsupported: grok supports text only");
    }
    if (!options.brief) {
      throw new PolicyError("invalid_mode", "invalid_mode: grok requires a brief file path");
    }
    const before = ["--prompt-file", resolve(options.brief), "--output-format", "json"];
    if (model) before.push("-m", model);
    if (effort) before.push("--effort", effort);
    if (options.cwd) before.push("--cwd", options.cwd);
    // default stays bypassPermissions (headless, no prompt). plan/review use
    // native `plan` as a floor: --tools names that all miss fail-open, and
    // bypassPermissions would then approve writes. Measured grok 1.0.5.
    return assemble(before);
  }
  if (vendor === "claude") {
    return assemble([
      "-p",
      "--model", model,
      "--effort", effort,
      "--output-format", "json",
      "--no-session-persistence",
    ]);
  }
  // --dangerously-skip-permissions: headless agy cannot prompt for tool
  // permissions, so it auto-DENIES them ("jetski: no output produced — a tool
  // required the ... permission that headless mode cannot prompt for"). Without
  // this, any brief that asks agy to read a file returns empty. This grants the
  // full-access posture codex already runs by config default — symmetric, and
  // the accepted policy for a single-user dev machine. The flag is assembled
  // here, never exposed on the orchestrator's shell line, so a host command
  // classifier never sees it (that is the point of mechanical dispatch).
  // --print-timeout: agy's print mode has its OWN timeout, default 5m0s
  // (`agy --help`). The dispatcher's own default is 1800s, so any job longer
  // than 5 minutes is killed by agy itself long before the dispatcher would
  // act — and it exits 1, not 124, so it does not even look like a timeout.
  // Measured: a review lens died 4x in a row at 304-306s with exit 1 and zero
  // output, while lighter slots in the same window finished at 111s; shrinking
  // the brief changed nothing because the brief was never the variable.
  // Propagating our own timeout keeps the two bounds coherent instead of
  // letting the shorter, invisible one win. A fixed constant would drift apart
  // again, so it is derived, not hardcoded.
  if (vendor !== "agy") {
    throw new PolicyError("invalid_vendor", `invalid_vendor: unsupported vendor ${String(options.vendor)}`);
  }
  const after = [];
  if (Number.isInteger(options.timeout) && options.timeout > 0) {
    after.push("--print-timeout", `${options.timeout}s`);
  }
  if (model) after.push("--model", model);
  // agy 1.1.26 split reasoning effort out of the model name: a bare `--model
  // gemini-3.8-flash` now exits 1 with `requires --effort (available: low,
  // medium, high)`, while the older `-high` suffix still resolves. Forward what
  // the caller asked for and let agy reconcile the two spellings — rewriting the
  // slug here would hide which of them the vendor actually honoured.
  if (effort) after.push("--effort", effort);
  const directories = [options.cwd, ...(operation === "image-analyze" ? inputs.map((input) => dirname(input)) : [])].filter(Boolean);
  const seen = new Set();
  for (const directory of directories) {
    const key = process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory);
    if (!seen.has(key)) { seen.add(key); after.push("--add-dir", directory); }
  }
  return assemble([], after);
}

export function buildVendorArgv(options) {
  return buildVendorInvocation(options).argv;
}

// --- caller-scoped enforcement reference (see references/enforcement.md) ---
// second-opinion itself never calls detectDirectInference — a broker does not
// block. This is the copyable detection logic a caller's own PreToolUse hook
// uses to keep codex/agy/grok calls routed through its dispatcher.
//
// Model: DEFAULT-DENY. Vendor CLIs run model inference on far more entry
// points than "exec" alone — bare `codex`, `codex "prompt"`, `review`/
// `resume`/`fork`, or any of INFERENCE_FLAGS below; agy defaults to inference
// on any invocation without an explicit management subcommand. A deny-list
// keyed on "exec" alone misses most of these (that was this file's own
// earlier gap). Here, any invocation is blocked UNLESS its subcommand is on
// an explicit management allowlist or it is pure --version/--help. A false
// negative (inference slips through undetected) is worse than a false
// positive (an unusual management command nags) — bias accordingly if you
// extend this.
//
// Threat model is ACCIDENT PREVENTION — stopping habitual/careless direct
// calls — not a determined adversary. Disclosed static-parser limits: shell
// aliases (`Set-Alias cx codex`), PowerShell -EncodedCommand (base64), and
// calls hidden inside script files are not detected. See enforcement.md
// "한계" for the full disclosure.
//
// Management allowlists below reflect `codex --help` (0.144.1),
// `agy --help` (1.1.26), and `grok --help` (1.0.5) as installed — re-derive if
// the CLIs change.
const CODEX_MANAGEMENT = new Set([
  "login", "logout", "mcp", "mcp-server", "plugin", "app", "app-server",
  "remote-control", "exec-server", "completion", "update", "doctor",
  "sandbox", "debug", "apply", "a", "archive", "delete", "unarchive",
  "features", "help", "cloud",
]);
const AGY_MANAGEMENT = new Set([
  "agent", "agents", "changelog", "help", "install", "models",
  "plugin", "plugins", "update",
]);
const GROK_MANAGEMENT = new Set([
  "login", "logout", "models", "version", "v", "help", "dashboard", "update",
]);
const MANAGEMENT = { codex: CODEX_MANAGEMENT, agy: AGY_MANAGEMENT, grok: GROK_MANAGEMENT };

// Flags that alone mean inference regardless of subcommand position (fixes
// variadic ordering like `codex -i x.png` with no explicit subcommand).
// codex -p/--profile is a config profile usable with management commands too
// — a neutral value flag, NOT inference. agy -p is --print (inference).
const INFERENCE_FLAGS = {
  codex: new Set(["-i", "--image", "-m", "--model", "-a", "--ask-for-approval", "--search", "--oss"]),
  agy: new Set(["-p", "--print", "--prompt", "-i", "--prompt-interactive", "-c", "--continue", "--conversation"]),
  grok: new Set(["-p", "--single", "--prompt-file", "--prompt-json"]),
};

// Neutral flags that take a value but don't themselves signal inference —
// skip the flag AND its value when hunting for the subcommand, so a value
// isn't misread as a management subcommand (e.g. `codex -C review doctor`).
const VALUE_FLAGS = {
  codex: new Set([
    "-c", "--config", "-C", "--cd", "--add-dir", "-s", "--sandbox",
    "-p", "--profile", "--remote", "--remote-auth-token-env",
    "--local-provider", "--enable", "--disable",
  ]),
  agy: new Set(["--add-dir", "--agent", "--effort", "--log-file", "--mode", "--model", "--project", "--print-timeout"]),
  grok: new Set([
    "-m", "--model", "--cwd", "--output-format", "--prompt-file", "--prompt-json",
    "--tools", "--disallowed-tools", "--permission-mode", "--effort",
    "--reasoning-effort", "--max-turns", "--sandbox", "--allow", "--deny",
    "-s", "--session-id", "-r", "--resume",
  ]),
};

// `-v` covers both `-v`/`-V` because membership is tested via a lowercasing
// helper — do not add uppercase variants.
const PURE_INFO_FLAGS = new Set(["--version", "-version", "-v", "--help", "-h", "-help"]);
const HELP_FLAGS = new Set(["--help", "-h", "-help", "--version", "-version", "-v"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const TRANSPARENT_WRAPPERS = new Set(["timeout", "env", "nice", "nohup", "stdbuf", "time", "command", "&"]);
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "cmd", "cmd.exe", "powershell", "pwsh", "powershell.exe", "pwsh.exe"]);
// Windows `start`/`Start-Process` is intentionally NOT parsed here — its
// title/-FilePath/-ArgumentList grammar produced collateral false positives
// (e.g. `start "codex" notepad` blocking an unrelated command). Disclosed
// limit: nobody routes an accidental codex call through `start`.
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "pnpm", "yarn", "bunx", "npm", "bun"]);
const RUNNER_EXEC_SUBCMDS = new Set(["exec", "x", "dlx"]);

function stripEq(token) { return String(token).split("=")[0].toLowerCase(); }

/** Strip heredoc bodies (data, not commands): <<EOF / <<-EOF, quoted or
 *  hyphenated/dotted delimiters, multiple heredocs per line. Excludes `<<<`
 *  here-strings. Not quote/comment aware (disclosed limit). */
function stripHeredocBodies(command) {
  const lines = command.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const DECL = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][-.A-Za-z0-9_]*)\2/g;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    const decls = [];
    let m;
    DECL.lastIndex = 0;
    while ((m = DECL.exec(line)) !== null) decls.push({ delim: m[3], dash: m[1] === "-" });
    i += 1;
    for (const { delim, dash } of decls) {
      const matches = (l) => (dash ? l.replace(/^\t+/, "") : l) === delim;
      while (i < lines.length && !matches(lines[i])) i += 1;
      i += 1;
    }
  }
  return out.join("\n");
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
    if (char === "<" || char === ">") { pushToken(); continue; }
    token += char;
  }
  pushToken();
  return segments.filter((segment) => segment.length > 0);
}

function commandBase(token) {
  return basename(String(token).replace(/^&\s*/, "").replace(/\\/g, "/").replace(/^"|"$/g, "")).toLowerCase();
}
function execBase(token) { return commandBase(token).replace(/\.(exe|cmd|bat|ps1)$/, ""); }

function vendorFromCommand(token) {
  const normalized = String(token).trim().replace(/^&\s*/, "").replace(/^"|"$/g, "").toLowerCase();
  if (/^\$\{?codex\}?$/.test(normalized)) return "codex";
  if (/^\$\{?agy\}?$/.test(normalized)) return "agy";
  if (/^\$\{?grok\}?$/.test(normalized)) return "grok";
  const base = execBase(normalized);
  return base === "codex" || base === "agy" || base === "grok" ? base : null;
}

/** Reduce an npm-style package spec to its bare vendor name: @scope/codex@1 -> codex */
function packageVendor(token) {
  const spec = String(token).replace(/^@[^/]+\//, "").replace(/@[^@]*$/, "");
  const base = execBase(spec).replace(/\.(js|mjs)$/, "");
  return base === "codex" || base === "agy" || base === "grok" ? base : null;
}

function skipToCommand(tokens) {
  let index = 0;
  while (ASSIGNMENT.test(tokens[index] ?? "")) index += 1;
  while (index < tokens.length && TRANSPARENT_WRAPPERS.has(execBase(tokens[index]))) {
    const wrapper = execBase(tokens[index++]);
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
    const marker = rest.findIndex((value) => ["/c", "/k"].includes(value.toLowerCase()));
    return marker >= 0 ? rest.slice(marker + 1).join(" ") : null;
  }
  // bash/sh/zsh -c/-lc ; powershell/pwsh -Command/-c. -EncodedCommand is base64 (disclosed limit).
  const marker = rest.findIndex((value) => ["-c", "-lc", "-command", "--command"].includes(value.toLowerCase()));
  return marker >= 0 ? rest.slice(marker + 1).join(" ") : null;
}

function packageRunnerTarget(tokens, start) {
  const runner = execBase(tokens[start]);
  if (!PACKAGE_RUNNERS.has(runner)) return null;
  let i = start + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--") { i += 1; continue; }
    if (t.startsWith("-")) { i += 1; continue; }
    if (RUNNER_EXEC_SUBCMDS.has(t.toLowerCase())) { i += 1; continue; }
    break; // first real package spec (or `run <script>`, which packageVendor rejects)
  }
  if (i >= tokens.length) return null;
  const vendor = packageVendor(tokens[i]);
  return vendor ? [vendor, ...tokens.slice(i + 1)] : null;
}

/** Index of the first positional token (skipping flags and neutral value pairs). */
function firstPositionalIndex(args, valueFlags) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (t === "--") return i + 1;
    if (t.startsWith("-") || t.startsWith("/")) {
      if (valueFlags.has(stripEq(t)) && !t.includes("=")) i += 2;
      else i += 1;
      continue;
    }
    return i;
  }
  return args.length;
}

function classifyVendorArgs(vendor, args, depth) {
  const mgmt = MANAGEMENT[vendor];
  const inferFlags = INFERENCE_FLAGS[vendor];
  const valueFlags = VALUE_FLAGS[vendor];

  // A help/version flag in the option region (before `--`) → help output → pass.
  const optionRegion = (() => {
    const end = args.indexOf("--");
    return end === -1 ? args : args.slice(0, end);
  })();
  if (optionRegion.some((t) => HELP_FLAGS.has(stripEq(t)))) return null;

  // An inference-only session flag anywhere → inference.
  if (args.some((t) => inferFlags.has(stripEq(t)))) return vendor;

  const pi = firstPositionalIndex(args, valueFlags);
  const positional = pi < args.length ? args[pi] : null;

  if (positional === null) {
    const nonEmpty = args.filter((t) => t !== "");
    if (nonEmpty.length > 0 && nonEmpty.every((t) => PURE_INFO_FLAGS.has(stripEq(t)))) return null;
    return vendor; // bare interactive, or only neutral flags → inference
  }

  const sub = positional.toLowerCase();
  const after = args.slice(pi + 1);

  if (mgmt.has(sub)) {
    // Command-carrier: `codex sandbox <cmd…>` runs cmd in a sandbox.
    if (vendor === "codex" && sub === "sandbox") {
      const carried = after[0] === "--" ? after.slice(1) : after;
      return carried.length ? detectDirectInference(carried.join(" "), depth + 1) : null;
    }
    // `codex cloud exec` submits an inference task; other cloud verbs are mgmt.
    if (vendor === "codex" && sub === "cloud") {
      const npi = firstPositionalIndex(after, valueFlags);
      const next = npi < after.length ? after[npi].toLowerCase() : null;
      return next === "exec" ? vendor : null;
    }
    return null; // management → pass
  }

  // Non-management subcommand (exec/e/review/resume/fork/…) or bare prompt.
  // Exception: `codex exec --help` — subcommand help, no inference.
  if (after.length > 0 && after.every((t) => PURE_INFO_FLAGS.has(stripEq(t)))) return null;
  return vendor;
}

function detectSegment(tokens, depth) {
  const index = skipToCommand(tokens);
  if (index >= tokens.length) return null;

  const nested = shellPayload(tokens, index);
  if (nested && depth < 4) return detectDirectInference(nested, depth + 1);

  const viaRunner = packageRunnerTarget(tokens, index);
  if (viaRunner) return classifyVendorArgs(viaRunner[0], viaRunner.slice(1), depth);

  const vendor = vendorFromCommand(tokens[index]);
  if (!vendor) return null;
  return classifyVendorArgs(vendor, tokens.slice(index + 1), depth);
}

// Return "codex" | "agy" if `command` directly invokes a vendor CLI for
// model inference (default-deny; management subcommands pass), else null.
export function detectDirectInference(command, depth = 0) {
  if (typeof command !== "string") return null;
  const source = depth === 0 ? stripHeredocBodies(command) : command;
  for (const segment of tokenizeShell(source)) {
    const vendor = detectSegment(segment, depth);
    if (vendor) return vendor;
  }
  return null;
}
