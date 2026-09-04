// second-opinion dispatcher — the one canonical way to call an external vendor.
//
// Run `node dispatch.mjs --help` first — it lists the flags, the per-combination
// requirements, and the two path bases. The flag/vendor/operation names there are
// printed from the same constants the parser enforces; the conditional rules are
// prose and must be kept in step by hand when validation changes.
// This header is a shortcut for someone who already has the file open — the
// hard part is usually finding the file at all, so start here:
//
//   FINDING THIS FILE — never hardcode a version directory. That is how a caller
//   silently pins an old build: one stayed on 0.8.2 and kept hitting agy's
//   5-minute internal timeout long after 0.8.3 fixed it.
//     Claude Code : "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs"
//                   or read plugins["second-opinion@second-opinion"][0].installPath
//                   from ~/.claude/plugins/installed_plugins.json
//     other hosts : use the exact path from that host's available-skills
//                   catalog. Join its root alias and relative path literally;
//                   repeated marketplace/plugin names are normal and must not
//                   be flattened. Codex, for example, installs under
//                   <CODEX_HOME>/plugins/cache/second-opinion/second-opinion/<version>.
//                   Only if the host provides no catalog or manifest should a
//                   caller discover the current version in that host's own cache.
//
//   CALLING IT (brief is a file; its contents go to the vendor over stdin)
//     node <dispatch> --vendor codex  --operation text --brief b.txt --cwd <dir> --out o.txt --err e.txt
//     node <dispatch> --vendor agy    --operation text --brief b.txt --cwd <dir> --model gemini-3.8-flash --effort medium --out o.txt --err e.txt
//     node <dispatch> --vendor claude --operation text --brief b.txt --cwd <dir> --model sonnet --effort low --out o.txt --err e.txt
//     node <dispatch> --vendor grok   --operation text --brief b.txt --cwd <dir> --model grok-4.6 --effort medium --out o.txt --err e.txt
//
//   RECEIPTS — SECOND_OPINION_RECEIPT remains private and keeps its raw v1
//   locators. SECOND_OPINION_PORTABLE_RECEIPT is an independent, optional JSONL
//   sink. Its closed emitter excludes dispatcher-owned locator fields, but free-
//   form vendor vocabulary can still contain sensitive text, so review portable
//   content before public sharing. Environment variables win over the matching
//   `receipt`/`portableReceipt` keys in ~/.second-opinion/config.json; malformed or
//   absent config is ignored, and no default path is invented. Each sink is attempted independently
//   after a dispatch; receipt I/O remains fail-open and the exit set stays
//   0, 2, 3, 4, 124. `ts` is only a timestamp, not a correlation key. A dispatch
//   is not guaranteed to write two rows.
//
//   Per-vendor requirements are not restated here or in --help. Validation
//   reports them precisely when a call is wrong, and prose copies of those rules
//   drift from the checks that enforce them.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, createWriteStream, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPATCH_MODES, OPERATIONS, PolicyError, VENDORS, applyGrokHarnessIsolationEnv, buildVendorArgv, composeVendorInput, effectiveInputProfile, effectiveVendorMode, executableName, grokNeedsHarnessIsolation, normalizeVendor, resolveExecutable } from "./vendor-policy.mjs";
import { appendPortableReceipt, buildPortableReceipt, MAX_EXPECT_OUTPUTS, MAX_EXPECT_TOTAL, MAX_FREE_STRING, preparePortableUsage } from "./portable-receipt.mjs";

export const MAX_BRIEF_BYTES = 8 * 1024 * 1024;
export const MAX_VENDOR_USAGE_BYTES = 64 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_SHORTHAND_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const MODEL_CATALOG_SCHEMA = 1;
const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_CATALOG_FAILURE_TTL_MS = 5 * 60 * 1000;
const MODEL_CATALOG_FILENAME = "model-catalog-v1.json";
const RECEIPT_CONFIG_FILENAME = "config.json";
const MAX_RECEIPT_CONFIG_BYTES = 1024 * 1024;
const SINGLE_OPTIONS = new Set(["--vendor", "--operation", "--brief", "--cwd", "--model", "--effort", "--mode", "--timeout", "--out", "--err", "--lens-id", "--expect-total", "--dry-run"]);
// Accepted --vendor spellings: the canonical set plus the "antigravity" alias
// normalizeVendor() folds into "agy". Kept next to VENDORS so a new vendor is
// one edit, and so usage text and validation cannot disagree.
const VENDOR_INPUTS = Object.freeze([...VENDORS, "antigravity"]);
const HELP_FLAGS = new Set(["--help", "-h", "help"]);

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

// Usage text is derived from the same constants the parser enforces, so a new
// flag or vendor shows up here without a second edit. A caller that guessed
// wrong should never have to read this source to recover — the unknown-argument
// error below prints the same list.
// Deliberately short. An earlier draft restated the whole call contract in prose
// — which flags each vendor needs, which modes apply where — and review found a
// fresh batch of inaccuracies every pass, because hand-written rules duplicate
// validation logic and drift from it silently. What is listed here comes from
// the same constants the parser enforces. Everything conditional is left to the
// validation errors, which are generated by the checks themselves and therefore
// cannot be wrong: they name the missing flag, the unsupported combination, or
// the rejected value at the moment it matters.
export function usageText() {
  const flags = [...SINGLE_OPTIONS, "--input", "--expect-output"].sort().join(" ");
  return [
    "second-opinion dispatcher — call an external vendor through one audited path.",
    "",
    "  node dispatch.mjs [--vendor <v>] --operation <op> --brief <file> [options]",
    "  node dispatch.mjs --request-json <file> --response-json <file>",
    "",
    `  vendors    : ${VENDOR_INPUTS.join(", ")}`,
    `  operations : ${OPERATIONS.join(", ")}`,
    `  flags      : ${flags}`,
    `  help       : ${[...HELP_FLAGS].join(" ")}  (first argument only)`,
    "",
    "  MADI REVIEW EXAMPLE (first-pass code review):",
    "    node dispatch.mjs --vendor codex --operation text --mode review --brief <review-brief.txt>",
    "      --cwd <review-target> --out <review.out> --err <review.err>",
    "  Independent second pass: keep the same brief/cwd/mode, change only --vendor,",
    "    any vendor-required --model, and the output paths. Reviewers must not edit.",
    "  Grok review baseline: add --model grok-4.6 --effort medium; the dispatcher",
    "    forwards --effort unchanged to the Grok CLI.",
    "  AGY reasoning effort is its own axis since agy 1.1.26: pass --model gemini-3.8-flash --effort",
    "    low|medium|high. The older -high suffix still resolves alone, but combining it with --effort",
    "    exits 1 rather than picking a winner, and a bare model name without --effort is rejected too.",
    "  Linked-worktree Grok/AGY review: their explicit modes have no git shell. Put",
    "    the exact diff and changed-file list in the brief; never ask them to discover .git.",
    "",
    "  --brief is a FILE; Codex/AGY/Claude receive it on stdin, Grok via --prompt-file.",
    "  --request-json selects one named HTTP/subscription provider with same-provider retry,",
    "  payload-silence detection, an optional caller deadline, and provider attribution.",
    "  Cross-provider routing and budgets belong to the caller; budget is rejected.",
    "  Retry defaults: max_retries=5, full-jitter exponential backoff capped at 60s.",
    "  Silence defaults to 600s via silence_timeout_seconds; legacy connect/read fields are absorbed.",
    "  timeout_seconds is an optional caller deadline; without it there is no total elapsed-time cap.",
    "  Paid execution retains a 3600s dispatcher cost backstop; retry sleeps do not count.",
    "  Retry-After scheduling is capped at 3600s; its raw observation is still recorded on HTTP failures.",
    "  Only a parsed, present empty string is transient; missing/non-string text and malformed JSON/SSE are permanent.",
    "  --response-json cannot alias request/env/receipt files and is replaced atomically.",
    "  Subscription generation honors receipt sinks; HTTP generation records them too.",
    "  Receipts retain requested/executed model, effort, stop, prompt-byte, and attempt evidence.",
    "  Run provider-probe.mjs explicitly for a one-shot status/duration/failure-class table.",
    "  Without --vendor, --model is matched against a cache-first provider catalog.",
    "  Catalog metadata is cached for 24h at ~/.second-opinion/model-catalog-v1.json.",
    "  A fresh-cache miss refreshes once; refresh failure uses last-known-good data.",
    "  Degraded fallback retries after 5m; the active Codex local cache is re-read.",
    "  Model separators/case and effort labels (light/very-high/maximum) are normalized.",
    "  --cwd is the vendor's workspace; omitted, it is this process's directory.",
    "  --brief/--input/--out/--err resolve from THIS process's directory, not --cwd.",
    "  Vendor-native flags (agy --add-dir, codex -s) are assembled internally.",
    "  Default --timeout is a 3600s cost backstop, not a review deadline. Never give a",
    "  review a short timeout (for example 300s): run it in background, observe liveness/--err, then require a receipt.",
    "  --dry-run prints the argv without running the vendor.",
    `  --expect-output <ASCII token, max ${MAX_FREE_STRING} chars> may be repeated up to ${MAX_EXPECT_OUTPUTS} times with --out; every token`,
    "  must occur literally in stdout or the dispatcher exits 4 and names every missing token on stderr.",
    "  Choose tokens that are not substrings of one another; literal matching does not infer token boundaries.",
    `  --expect-total <n> declares how many sections existed (1..${MAX_EXPECT_TOTAL}); it requires --expect-output and is`,
    "  recorded as expectedTotal without changing exit codes. Compare it with outputChecks.length: equal means every",
    "  section was registered, greater means the caller registered only some of them; a total below the",
    "  registered count is rejected, so those two readings are the only ones a receipt can carry.",
    "",
    "  Which flags a given vendor/operation/mode actually requires is enforced by",
    "  validation, not repeated here — run the call and the error names exactly",
    "  what is missing or unsupported.",
    "",
    // Stated here because no error can teach it: a Codex --mode review call
    // succeeds and looks restricted while running at full access.
    "  --mode plan|review narrows permissions on Claude, AGY, and Grok. Codex has no",
    "  tool allowlist — its review runs at whatever sandbox_mode its own config",
    "  sets, so the brief's no-edit prohibition is the only guard there.",
    "",
    "LOCATING THIS FILE — never hardcode a version directory:",
    "  Claude Code : \"$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs\", or installPath from",
    "                ~/.claude/plugins/installed_plugins.json",
    "                (plugins[\"second-opinion@second-opinion\"][0].installPath)",
    "  other hosts : use the exact path from YOUR host's available-skills catalog;",
    "                join its root alias and relative path literally. Do not flatten",
    "                repeated marketplace/plugin names. Codex installs under",
    "                <CODEX_HOME>/plugins/cache/second-opinion/second-opinion/<version>.",
    "                If no catalog or manifest exists, only then discover the current",
    "                version in that same host's cache. Never use another host's copy.",
    "                On Windows PowerShell 5.1, verify catalog paths directly; an empty",
    "                rg --files ... | rg '...$' result is not proof of absence.",
    "",
    "  Set SECOND_OPINION_RECEIPT to a path to record private calls as JSON lines;",
    "  its locator-rich raw receipt must stay outside any repository.",
    "  Set SECOND_OPINION_PORTABLE_RECEIPT independently for cumulative portable JSONL.",
    "  Env wins over receipt/portableReceipt in ~/.second-opinion/config.json; broken",
    "  config is ignored, no default path is created, and drive policy is not enforced.",
    "  Rows identify transport=cli|api; vendor is CLI-only and provider is API-only.",
    "  Its closed emitter excludes dispatcher-owned locator fields. Free-form vendor",
    "  vocabulary can still contain sensitive text, so review content before sharing.",
    "  Raw and portable appends are independent and fail-open; the exit set remains",
    "  0, 2, 3, 4, 124. A configured sink may have no row after an I/O failure, and one",
    "  dispatch is not guaranteed to produce two rows. `ts` is only a timestamp,",
    "  not a correlation key. Keep raw receipts outside repositories.",
  ].join("\n");
}

export function splitModelEffort(model, effort) {
  if (model === undefined || effort !== undefined) return { model, effort };
  const separator = model.lastIndexOf("@");
  if (separator <= 0) return { model, effort };
  const candidate = model.slice(separator + 1).toLowerCase();
  const normalized = normalizeEffort(candidate);
  if (!MODEL_SHORTHAND_EFFORTS.has(normalized)) return { model, effort };
  return { model: model.slice(0, separator), effort: normalized };
}

export function resolveCodexModelAlias(model, env = process.env) {
  if (!model) return model;
  try {
    const matches = rankedCatalogMatches(model, "codex", codexModelCatalog(env));
    const best = winningMatches(matches);
    return best.length === 1 ? best[0].model : model;
  } catch {
    return model;
  }
}

function codexModelCatalog(env = process.env) {
  const root = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const payload = JSON.parse(readFileSync(join(root, "models_cache.json"), "utf8"));
  return Array.isArray(payload?.models)
    ? payload.models.map((entry) => catalogRecord("codex", entry)).filter(Boolean)
    : [];
}

function normalizeEffort(value) {
  const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return ({ light: "low", "very high": "xhigh", maximum: "max" })[normalized] ?? normalized.replace(/ /g, "");
}

function stripModelDecoration(value) {
  return String(value ?? "").replace(/(?:\x1b\[[0-9;]*m|\[[0-9;]*m\])/g, "").trim();
}

function normalizeModelKey(value) {
  return stripModelDecoration(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function uniqueStrings(values) {
  return [...new Set(values.map(stripModelDecoration).filter(Boolean))];
}

function catalogRecord(vendor, value) {
  if (typeof value === "string") value = vendor === "claude" ? { value, resolvedModel: value } : { slug: value };
  if (!value || typeof value !== "object") return null;
  if (value.canonical && Array.isArray(value.aliases)) {
    // 0.9.3 development caches created before provider-advertised aliases were
    // distinguished from display-derived families are unsafe to reuse: refresh
    // those Claude rows instead of guessing whether a bare token is executable.
    if (vendor === "claude" && !Object.hasOwn(value, "latestAlias")) return null;
    const canonical = stripModelDecoration(value.canonical);
    if (!canonical) return null;
    return {
      canonical,
      aliases: uniqueStrings([canonical, ...value.aliases]),
      efforts: uniqueStrings(value.efforts ?? []).map(normalizeEffort),
      family: value.family ? normalizeModelKey(value.family) : undefined,
      latestAlias: value.latestAlias ? normalizeModelKey(value.latestAlias) : null,
    };
  }
  if (vendor === "codex") {
    const canonical = stripModelDecoration(value.slug);
    if (!canonical) return null;
    const withoutProvider = canonical.replace(/^gpt[-_. ]+/i, "");
    const lastPart = normalizeModelKey(withoutProvider).split(" ").at(-1);
    return {
      canonical,
      aliases: uniqueStrings([canonical, value.display_name, withoutProvider, lastPart && !/^\d+$/.test(lastPart) ? lastPart : ""]),
      efforts: uniqueStrings((value.supported_reasoning_levels ?? []).map((row) => row?.effort)).map(normalizeEffort),
    };
  }
  if (vendor === "agy") {
    const canonical = stripModelDecoration(value.slug ?? value.canonical);
    if (!canonical) return null;
    const withoutProvider = canonical.replace(/^claude[-_. ]+/i, "");
    const withoutThinking = withoutProvider.replace(/[-_. ]+thinking$/i, "");
    return { canonical, aliases: uniqueStrings([canonical, withoutProvider, withoutThinking]), efforts: [] };
  }
  if (vendor === "grok") {
    const canonical = stripModelDecoration(value.slug ?? value.canonical);
    if (!canonical) return null;
    const withoutBuild = canonical.replace(/[-_. ]+build$/i, "");
    return { canonical, aliases: uniqueStrings([canonical, withoutBuild]), efforts: [] };
  }
  const canonical = stripModelDecoration(value.resolvedModel ?? value.value ?? value.canonical);
  if (!canonical) return null;
  const shortValue = stripModelDecoration(value.value);
  const display = stripModelDecoration(value.displayName).replace(/\s*\([^)]*\)\s*$/, "");
  const withoutProvider = canonical.replace(/^claude[-_. ]+/i, "");
  const shortKey = normalizeModelKey(shortValue);
  const latestAlias = shortKey !== "default" && /^[a-z]+$/.test(shortKey) ? shortKey : undefined;
  const familyCandidate = shortKey === "default"
    ? undefined
    : (/^[a-z]+$/.test(shortKey) ? shortKey : normalizeModelKey(display || withoutProvider).split(" ")[0]);
  const family = familyCandidate && familyCandidate !== "default" && /^[a-z]+$/.test(familyCandidate) ? familyCandidate : undefined;
  return {
    canonical,
    aliases: uniqueStrings([canonical, withoutProvider, shortValue !== "default" ? shortValue : "", display, family]),
    efforts: uniqueStrings(value.supportedEffortLevels ?? []).map(normalizeEffort),
    family,
    latestAlias: latestAlias ?? null,
  };
}

function normalizeCatalog(vendor, catalog) {
  const source = Array.isArray(catalog) ? catalog : catalog?.models;
  const models = Array.isArray(source) ? source.map((value) => catalogRecord(vendor, value)).filter(Boolean) : [];
  return { available: (Array.isArray(catalog) || catalog?.available === true) && models.length > 0, models };
}

function claudeModelCatalog(output) {
  for (const line of String(output).split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const models = event?.type === "control_response" ? event?.response?.response?.models : undefined;
      if (Array.isArray(models)) return models.map((value) => catalogRecord("claude", value)).filter(Boolean);
    } catch { /* ignore non-protocol stderr and partial lines */ }
  }
  return [];
}

function commandModelCatalog(command, args, parse, deps, input) {
  try {
    const result = (deps.spawnSync ?? spawnSync)(command, args, {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      env: deps.env ?? process.env,
      input,
      timeout: deps.catalogTimeoutMs ?? 20_000,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error || result.signal) return { available: false, models: [] };
    const models = parse(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return { available: models.length > 0, models };
  } catch { return { available: false, models: [] }; }
}

function liveModelCatalogs(deps = {}) {
  const env = deps.env ?? process.env;
  let codex = { available: false, models: [] };
  try {
    const models = codexModelCatalog(env);
    codex = { available: models.length > 0, models };
  } catch { /* unavailable vendor catalog */ }
  const agy = commandModelCatalog("agy", ["models"], (output) => output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[a-z0-9][a-z0-9._-]*$/i.test(line)).map((slug) => catalogRecord("agy", { slug })), deps);
  // Claude's supportedModels metadata is returned by the initialize control
  // request. Cache only the model rows: the full response also carries account
  // metadata that must never be persisted by second-opinion. This exact
  // non-print protocol (intentionally no -p) is field-verified on Claude Code
  // 2.1.220; adding -p would switch away from the control session being queried.
  const request = `${JSON.stringify({ request_id: "second-opinion-catalog", type: "control_request", request: { subtype: "initialize" } })}\n`;
  const claude = commandModelCatalog("claude", ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--tools", "", "--no-session-persistence", "--safe-mode", "--disable-slash-commands"], claudeModelCatalog, deps, request);
  let grok = { available: false, models: [] };
  try {
    const grokExe = resolveExecutable("grok", { env, platform: process.platform });
    grok = commandModelCatalog(grokExe, ["models"], grokModelCatalog, deps);
  } catch { /* unavailable vendor catalog */ }
  return { codex, agy, claude, grok };
}

function grokModelCatalog(output) {
  const models = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*[*\-]\s+(grok-[a-z0-9][a-z0-9.-]*)/i);
    if (match) {
      const record = catalogRecord("grok", { slug: match[1] });
      if (record) models.push(record);
    }
  }
  return models;
}

function modelCatalogCachePath(deps = {}) {
  return deps.cachePath ?? join(homedir(), ".second-opinion", MODEL_CATALOG_FILENAME);
}

function readCatalogCache(deps = {}) {
  try {
    const payload = JSON.parse(readFileSync(modelCatalogCachePath(deps), "utf8"));
    if (payload?.schemaVersion !== MODEL_CATALOG_SCHEMA || !Number.isFinite(payload.checkedAt)) return null;
    const catalogs = Object.fromEntries(VENDORS.map((vendor) => [vendor, normalizeCatalog(vendor, payload.vendors?.[vendor])]));
    const invalid = VENDORS.some((vendor) => payload.vendors?.[vendor]?.available === true && catalogs[vendor].available !== true);
    return { checkedAt: payload.checkedAt, degraded: payload.degraded === true, invalid, catalogs };
  } catch { return null; }
}

function writeCatalogCache(catalogs, now, degraded, deps = {}) {
  const path = modelCatalogCachePath(deps);
  const temp = `${path}.${process.pid}.tmp`;
  const vendors = Object.fromEntries(VENDORS.map((vendor) => [vendor, {
    available: catalogs[vendor]?.available === true,
    models: catalogs[vendor]?.models ?? [],
  }]));
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ schemaVersion: MODEL_CATALOG_SCHEMA, checkedAt: now, degraded, vendors }, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* cache failure must not block routing */ }
  }
}

function refreshModelCatalogs(stale, deps = {}) {
  const live = liveModelCatalogs(deps);
  let degraded = false;
  const catalogs = Object.fromEntries(VENDORS.map((vendor) => {
    if (live[vendor]?.available) return [vendor, live[vendor]];
    degraded = true;
    // Codex's source is already a local cache and may vary with CODEX_HOME.
    // Never reuse a unified-cache Codex row when the active local source failed.
    if (vendor !== "codex" && stale?.[vendor]?.available) return [vendor, stale[vendor]];
    return [vendor, { available: false, models: [] }];
  }));
  writeCatalogCache(catalogs, deps.now?.() ?? Date.now(), degraded, deps);
  return catalogs;
}

function currentCodexCatalog(deps = {}) {
  try {
    const models = codexModelCatalog(deps.env ?? process.env);
    return { available: models.length > 0, models };
  } catch { return { available: false, models: [] }; }
}

function discoverModelCatalogs(deps = {}, forceRefresh = false) {
  if (deps.modelCatalogs) {
    return { catalogs: Object.fromEntries(VENDORS.map((vendor) => [vendor, normalizeCatalog(vendor, deps.modelCatalogs[vendor])])), refreshable: false, refreshed: false };
  }
  const now = deps.now?.() ?? Date.now();
  const cached = readCatalogCache(deps);
  const cacheTtl = cached?.degraded ? MODEL_CATALOG_FAILURE_TTL_MS : MODEL_CATALOG_TTL_MS;
  const age = cached ? now - cached.checkedAt : null;
  if (!forceRefresh && cached && !cached.invalid && age >= 0 && age < cacheTtl) {
    return { catalogs: { ...cached.catalogs, codex: currentCodexCatalog(deps) }, refreshable: true, refreshed: false };
  }
  return { catalogs: refreshModelCatalogs(cached?.catalogs, deps), refreshable: true, refreshed: true };
}

function requestedRouteHint(model) {
  const source = stripModelDecoration(model).toLowerCase();
  for (const [prefix, vendor] of [["claude code ", "claude"], ["codex ", "codex"], ["antigravity ", "agy"], ["agy ", "agy"]]) {
    if (source.startsWith(prefix)) return { vendor, model: normalizeModelKey(source.slice(prefix.length)) };
  }
  return { vendor: undefined, model: normalizeModelKey(source) };
}

function rankedCatalogMatches(requested, vendor, catalog) {
  const hint = requestedRouteHint(requested);
  if (hint.vendor && hint.vendor !== vendor) return [];
  const key = hint.model;
  if (!key) return [];
  const matches = [];
  for (const record of catalog) {
    const aliases = record.aliases.map(normalizeModelKey);
    if (aliases.includes(key)) {
      const preserveLatestAlias = vendor === "claude" && record.latestAlias === key;
      matches.push({ vendor, model: preserveLatestAlias ? key : record.canonical, rank: 100, record });
      continue;
    }
    if (vendor === "claude" && record.family && new RegExp(`^${record.family} \\d+(?: \\d+)*(?: [a-z0-9]+)*$`).test(key)) {
      matches.push({ vendor, model: `claude-${key.replace(/ /g, "-")}`, rank: 70, record });
      continue;
    }
    if (aliases.some((alias) => alias.endsWith(` ${key}`) || alias.startsWith(`${key} `))) {
      matches.push({ vendor, model: record.canonical, rank: 40, record });
    }
  }
  return matches;
}

function winningMatches(matches) {
  const rank = Math.max(-1, ...matches.map((match) => match.rank));
  return matches.filter((match) => match.rank === rank);
}

function modelNameMatches(requested, available) {
  const alias = normalizeModelKey(requested);
  const candidate = normalizeModelKey(available);
  if (!alias || !candidate) return false;
  if (candidate === alias || candidate.endsWith(` ${alias}`) || candidate.startsWith(`${alias} `)) return true;
  const firstSeparator = candidate.indexOf(" ");
  return firstSeparator >= 0 && candidate.slice(firstSeparator + 1).startsWith(`${alias} `);
}

function matchModelRoute(model, catalogs) {
  const requiredVendors = VENDORS.filter((vendor) => vendor !== "grok");
  const unavailable = requiredVendors.filter((vendor) => catalogs[vendor]?.available !== true);
  if (unavailable.length > 0) {
    throw new CliError(`model catalog unavailable for automatic vendor routing: ${unavailable.join(", ")} (pass --vendor explicitly)`);
  }
  const routingVendors = VENDORS.filter((vendor) => catalogs[vendor]?.available === true);
  const matches = winningMatches(routingVendors.flatMap((vendor) => rankedCatalogMatches(model, vendor, catalogs[vendor].models)));
  const vendors = [...new Set(matches.map((match) => match.vendor))];
  if (vendors.length === 1) {
    const sameVendor = matches.filter((match) => match.vendor === vendors[0]);
    const models = [...new Set(sameVendor.map((match) => match.model))];
    if (models.length === 1) {
      return {
        vendor: vendors[0],
        model: models[0],
        efforts: uniqueStrings(sameVendor.flatMap((match) => match.record.efforts ?? [])).map(normalizeEffort),
      };
    }
  }
  if (matches.length === 0) return null;
  throw new CliError(`ambiguous model for automatic vendor routing: ${model} (${matches.map((match) => `${match.vendor}:${match.model}`).join(", ")})`);
}

function resolveModelRouteDetailed(model, deps = {}) {
  let discovery = discoverModelCatalogs(deps);
  let route = matchModelRoute(model, discovery.catalogs);
  if (!route && discovery.refreshable && !discovery.refreshed) {
    discovery = discoverModelCatalogs(deps, true);
    route = matchModelRoute(model, discovery.catalogs);
  }
  if (!route) throw new CliError(`unknown model for automatic vendor routing: ${model}`);
  return route;
}

export function resolveModelRoute(model, deps = {}) {
  const { vendor, model: routedModel } = resolveModelRouteDetailed(model, deps);
  return { vendor, model: routedModel };
}

export function resolveVendorForModel(model, deps = {}) {
  return resolveModelRouteDetailed(model, deps).vendor;
}

function validateModelValue(model) {
  if (model !== undefined && (model.length === 0 || model.startsWith("-") || /[\x00-\x1f\x7f]/.test(model))) {
    throw new CliError("--model must be non-empty, must not start with '-', and must not contain control characters");
  }
}

export function parseCli(argv, startCwd = process.cwd(), deps = {}) {
  const raw = { inputs: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--input") {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw new CliError("--input requires a value");
      raw.inputs.push(argv[++index]);
      continue;
    }
    if (flag === "--expect-output") {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw new CliError("--expect-output requires a value");
      (raw.expectOutputs ??= []).push(argv[++index]);
      continue;
    }
    if (!SINGLE_OPTIONS.has(flag)) {
      throw new CliError(`unknown argument: ${flag}\n${usageText()}`);
    }
    if (seen.has(flag)) throw new CliError(`duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--dry-run") raw.dryRun = true;
    else {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw new CliError(`${flag} requires a value`);
      raw[flag.slice(2)] = argv[++index];
    }
  }
  const modelRequested = raw.model;
  const shorthand = splitModelEffort(raw.model, raw.effort);
  let model = shorthand.model;
  const effortRequested = shorthand.effort;
  const effort = shorthand.effort === undefined ? undefined : normalizeEffort(shorthand.effort);
  validateModelValue(model);
  if (raw.vendor !== undefined && !VENDOR_INPUTS.includes(raw.vendor)) throw new CliError(`--vendor must be one of: ${VENDOR_INPUTS.join(", ")}`);
  if (!raw.vendor && !model) throw new CliError("--vendor is required when --model is omitted");
  const route = raw.vendor ? { vendor: normalizeVendor(raw.vendor), model, efforts: [] } : resolveModelRouteDetailed(model, deps);
  const vendor = route.vendor;
  model = route.model;
  validateModelValue(model);
  // Accepted values come from the constant, not a hand-typed copy of it — the
  // same drift that made the prose usage wrong applies to error strings.
  if (!OPERATIONS.includes(raw.operation)) throw new CliError(`--operation must be one of: ${OPERATIONS.join(", ")}`);
  if (raw.mode !== undefined && !DISPATCH_MODES.filter((mode) => mode !== "default").includes(raw.mode)) {
    throw new CliError(`--mode must be one of: ${DISPATCH_MODES.filter((mode) => mode !== "default").join(", ")}`);
  }
  const mode = raw.mode ?? "default";
  try { effectiveVendorMode({ vendor, operation: raw.operation, mode }); }
  catch (error) {
    if (error instanceof PolicyError) throw new CliError(error.message);
    throw error;
  }
  if (!raw.brief) throw new CliError("--brief is required");
  const brief = absoluteFrom(startCwd, raw.brief);
  const cwd = absoluteFrom(startCwd, raw.cwd ?? startCwd);
  const inputs = raw.inputs.map((value) => absoluteFrom(startCwd, value));
  const out = raw.out ? absoluteFrom(startCwd, raw.out) : undefined;
  const err = raw.err ? absoluteFrom(startCwd, raw.err) : undefined;
  const expectOutputs = raw.expectOutputs ?? [];
  const expectOutput = expectOutputs[0];
  const lensId = raw["lens-id"] ?? null;
  if (lensId !== null && (lensId.length < 1 || lensId.length > 64 || /[\x00-\x1f\x7f]/.test(lensId))) {
    throw new CliError("--lens-id must be 1 to 64 characters without control characters");
  }
  assertRegularFile(brief, "brief");
  if (statSync(brief).size > MAX_BRIEF_BYTES) throw new CliError("brief exceeds 8MB");
  assertDirectory(cwd, "cwd");
  if (effort !== undefined) {
    if (!["codex", "claude", "grok", "agy"].includes(vendor)) throw new CliError("--effort is supported only for codex, claude, grok, or agy");
    const allowedEffort = route.efforts.length > 0
      ? route.efforts
      : vendor === "claude" ? ["low", "medium", "high", "xhigh", "max"]
        : vendor === "agy" ? ["low", "medium", "high"]
          : ["low", "medium", "high", "xhigh", "max", "ultra"];
    // Name the accepted values, not just the rejection. Usage deliberately does
    // not restate per-vendor rules, so this error is the caller's only route to
    // a working call — "invalid --effort" alone leaves them guessing, and the
    // accepted set differs by vendor (claude adds "max", agy stops at "high").
    if (!allowedEffort.includes(effort)) {
      throw new CliError(`invalid --effort: ${effort} (${vendor} accepts ${allowedEffort.join(", ")})`);
    }
  }
  if (raw.operation === "image-analyze") {
    if (inputs.length === 0) throw new CliError("image-analyze requires at least one --input");
    for (const input of inputs) assertRegularFile(input, "input");
  } else if (inputs.length > 0) throw new CliError("--input is supported only for image-analyze");
  if (expectOutputs.length > MAX_EXPECT_OUTPUTS) throw new CliError(`--expect-output may be repeated at most ${MAX_EXPECT_OUTPUTS} times`);
  if (expectOutput !== undefined) {
    if (!out) throw new CliError("--expect-output requires --out");
    if (expectOutputs.some((value) => value.length > MAX_FREE_STRING || !/^[\x21-\x7e]+$/.test(value))) throw new CliError(`--expect-output must be a 1 to ${MAX_FREE_STRING} character ASCII token without whitespace`);
  }
  const expectedTotal = raw["expect-total"] === undefined ? null : Number(raw["expect-total"]);
  if (expectedTotal !== null) {
    if (!Number.isInteger(expectedTotal) || expectedTotal < 1 || expectedTotal > MAX_EXPECT_TOTAL) {
      throw new CliError(`--expect-total must be an integer from 1 to ${MAX_EXPECT_TOTAL}`);
    }
    // A declared total with no registered token would leave outputChecks null, and
    // `total > null?.length` reads false, so a partial registration would look full.
    if (expectOutputs.length === 0) throw new CliError("--expect-total requires at least one --expect-output");
    // Fewer declared than registered is a fourth state the documented reading rule
    // (null / equal / greater) does not define, so it is rejected rather than recorded.
    if (expectedTotal < expectOutputs.length) {
      throw new CliError("--expect-total must be at least the number of --expect-output tokens");
    }
  }
  if (vendor === "claude") {
    if (raw.operation !== "text") throw new CliError("claude supports only --operation text");
    if (!model) throw new CliError("claude requires --model");
    if (!effort) throw new CliError("claude requires --effort");
    if (!out) throw new CliError("claude requires --out to preserve and validate the result JSON");
    if (!err) throw new CliError("claude requires --err to preserve vendor stderr");
  }
  // Default is the dispatcher cost backstop, NOT a caller work limit. A short fixed timeout
  // kills legitimate heavy reasoning (codex high/xhigh reading several files) and
  // the child is SIGTERM'd before its final message reaches stdout — the recurring
  // "exit 124, empty out, reasoning stranded in stderr" failure. One hour is the
  // maximum paid execution. A caller may pass --timeout only for a declared hard
  // deadline outside a review; ordinary reviews run in the background and are
  // observed rather than cut off by a short limit such as 300 seconds.
  const timeout = raw.timeout === undefined ? 3600 : Number(raw.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new CliError("--timeout must be an integer from 1 to 3600");
  const conflicts = outputConflicts({ brief, inputs, out, err });
  if (conflicts.brief) throw new CliError("--out/--err must not equal --brief");
  if (conflicts.input) throw new CliError("--out/--err must not equal --input");
  if (conflicts.outputs) throw new CliError("--out and --err must not refer to the same file");
  if (receiptConflicts({ brief, inputs, out, err }, deps.env ?? process.env)) throw new CliError("--out/--err must not equal the resolved raw receipt sink");
  return {
    vendor, operation: raw.operation, mode, brief, cwd, modelRequested, model, effortRequested, effort, inputs, timeout, out, err,
    expectOutput, ...(expectOutputs.length ? { expectOutputs } : {}), expectedTotal, lensId, dryRun: raw.dryRun ?? false,
  };
}

function isGitRepository(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { shell: false, encoding: "utf8", windowsHide: true });
  return result.status === 0 && typeof result.stdout === "string" && result.stdout.trim() === "true";
}
function receiptConfig(configPath = join(homedir(), ".second-opinion", RECEIPT_CONFIG_FILENAME)) {
  try {
    const info = statSync(configPath);
    if (!info.isFile() || info.size > MAX_RECEIPT_CONFIG_BYTES) return {};
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function resolveReceiptSinks(env = process.env, configPath) {
  const config = receiptConfig(configPath);
  const rawEnv = typeof env.SECOND_OPINION_RECEIPT === "string" ? env.SECOND_OPINION_RECEIPT.trim() : "";
  const portableEnv = typeof env.SECOND_OPINION_PORTABLE_RECEIPT === "string" ? env.SECOND_OPINION_PORTABLE_RECEIPT.trim() : "";
  const rawConfig = typeof config.receipt === "string" ? config.receipt.trim() : "";
  const portableConfig = typeof config.portableReceipt === "string" ? config.portableReceipt.trim() : "";
  return {
    receipt: rawEnv || rawConfig ? absoluteFrom(process.cwd(), rawEnv || rawConfig) : undefined,
    portableReceipt: portableEnv || portableConfig ? absoluteFrom(process.cwd(), portableEnv || portableConfig) : undefined,
  };
}

function receiptPath(env, sinks) {
  return sinks ? sinks.receipt : resolveReceiptSinks(env).receipt;
}
function portableReceiptPath(env, sinks) {
  return sinks ? sinks.portableReceipt : resolveReceiptSinks(env).portableReceipt;
}
function hasEnvKey(env, expected) {
  return Object.keys(env).some((key) => key.toUpperCase() === expected);
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
function receiptConflicts(options, env, sinks) {
  const receipt = receiptPath(env, sinks);
  if (!receipt) return false;
  return [options.brief, ...(options.inputs ?? []), options.out, options.err].filter(Boolean).some((value) => sameFile(receipt, value));
}
function portableConfigError(options, env, sinks) {
  const portable = portableReceiptPath(env, sinks);
  if (!portable) return null;
  const raw = receiptPath(env, sinks);
  if (raw && sameFile(raw, portable)) return "SECOND_OPINION_RECEIPT and SECOND_OPINION_PORTABLE_RECEIPT must not refer to the same file";
  if ([options.brief, ...(options.inputs ?? []), options.out, options.err].filter(Boolean).some((value) => sameFile(portable, value))) {
    return "SECOND_OPINION_PORTABLE_RECEIPT must not refer to an input or output file";
  }
  return null;
}
export function generationPathConfigError({ requestPath, responsePath, envFile }, env = process.env, sinks) {
  const inputs = [requestPath, envFile].filter(Boolean);
  const raw = receiptPath(env, sinks);
  const portable = portableReceiptPath(env, sinks);
  if (inputs.some((input) => sameFile(responsePath, input))) return "--response-json must not refer to the request or provider env file";
  if (raw && sameFile(responsePath, raw)) return "--response-json must not refer to SECOND_OPINION_RECEIPT";
  if (portable && sameFile(responsePath, portable)) return "--response-json must not refer to SECOND_OPINION_PORTABLE_RECEIPT";
  if (raw && portable && sameFile(raw, portable)) return "SECOND_OPINION_RECEIPT and SECOND_OPINION_PORTABLE_RECEIPT must not refer to the same file";
  if (raw && inputs.some((input) => sameFile(raw, input))) return "SECOND_OPINION_RECEIPT must not refer to a generation input file";
  if (portable && inputs.some((input) => sameFile(portable, input))) return "SECOND_OPINION_PORTABLE_RECEIPT must not refer to a generation input file";
  return null;
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
function normalizeClaudeModel(value) {
  return String(value).replace(/(?:\x1b\[[0-9;]*m|\[[0-9;]*m\])/g, "");
}
function claudeModelMatches(requested, actualModels) {
  const expected = normalizeClaudeModel(requested ?? "").toLowerCase();
  if (!expected || actualModels.length === 0) return false;
  return actualModels.every((model) => modelNameMatches(expected, normalizeClaudeModel(model)));
}
function inspectClaudeOutput(options, capturedOutput) {
  if (capturedOutput?.tooLarge) return { usage: null, status: "output-too-large", valid: false };
  const data = capturedOutput?.data;
  if (!Buffer.isBuffer(data) || data.length === 0) return { usage: null, status: "empty-output", valid: false };
  let payload;
  try { payload = JSON.parse(data.toString("utf8")); }
  catch { return { usage: null, status: "invalid-json", valid: false }; }
  if (payload?.type !== "result" || payload?.subtype !== "success" || payload?.is_error === true) {
    return { usage: null, status: "vendor-reported-error", valid: false };
  }
  if (typeof payload.result !== "string" || payload.result.trim() === "") {
    return { usage: null, status: "empty-result", valid: false };
  }
  if (!payload.modelUsage || typeof payload.modelUsage !== "object" || Array.isArray(payload.modelUsage)) {
    return { usage: null, status: "missing-model-usage", valid: false };
  }
  const modelEntries = Object.entries(payload.modelUsage).map(([model, row]) => ({
    model: normalizeClaudeModel(model),
    outputTokens: row?.outputTokens,
  }));
  const actualModels = modelEntries.map((entry) => entry.model);
  const outputModels = modelEntries.filter((entry) => Number.isFinite(entry.outputTokens) && entry.outputTokens > 0);
  const maxOutputTokens = outputModels.length > 0
    ? Math.max(...outputModels.map((entry) => entry.outputTokens))
    : null;
  const modelsToBind = maxOutputTokens === null
    ? actualModels
    : outputModels.filter((entry) => entry.outputTokens === maxOutputTokens).map((entry) => entry.model);
  if (!claudeModelMatches(options.model, modelsToBind)) {
    return { usage: null, status: "model-mismatch", valid: false };
  }
  const usage = payload.usage;
  const modelRows = Object.values(payload.modelUsage);
  const contextWindows = modelRows.map((row) => row?.contextWindow).filter(Number.isFinite);
  const optionalNumber = (value) => value === undefined || value === null ? 0 : (Number.isFinite(value) ? value : null);
  const cacheCreationInputTokens = optionalNumber(usage?.cache_creation_input_tokens);
  const cacheReadInputTokens = optionalNumber(usage?.cache_read_input_tokens);
  const required = [
    usage?.input_tokens,
    usage?.output_tokens,
    payload.total_cost_usd,
  ];
  if (!required.every(Number.isFinite) || cacheCreationInputTokens === null || cacheReadInputTokens === null) {
    return { usage: null, status: "invalid-token-fields", valid: false };
  }
  return {
    valid: true,
    status: "ok",
    usage: {
      source: "claude-result-json",
      actualModels,
      inputTokens: usage.input_tokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens: usage.output_tokens,
      totalCostUsd: payload.total_cost_usd,
      contextWindow: contextWindows.length > 0 ? Math.max(...contextWindows) : null,
    },
  };
}
function inspectGrokOutput(options, capturedOutput) {
  if (capturedOutput?.tooLarge) return { usage: null, status: "output-too-large", valid: false };
  const data = capturedOutput?.data;
  if (!Buffer.isBuffer(data) || data.length === 0) return { usage: null, status: "empty-output", valid: false };
  let text = data.toString("utf8");
  if (data[0] === 0xff && data[1] === 0xfe) text = data.toString("utf16le");
  else if (data[0] === 0xfe && data[1] === 0xff) text = data.subarray(2).toString("utf16le");
  let payload;
  try { payload = JSON.parse(text.trim()); }
  catch { return { usage: null, status: "invalid-json", valid: false }; }
  if (typeof payload?.text !== "string" || payload.text.trim() === "") {
    return { usage: null, status: "empty-result", valid: false };
  }
  const modelUsage = payload.modelUsage && typeof payload.modelUsage === "object" && !Array.isArray(payload.modelUsage)
    ? payload.modelUsage
    : {};
  const actualModels = Object.keys(modelUsage);
  if (actualModels.length === 0) {
    return { usage: null, status: "missing-model-usage", valid: false };
  }
  const requested = String(options.model ?? "").trim();
  if (requested && !actualModels.some((model) => modelNameMatches(requested, model))) {
    return { usage: null, status: "model-mismatch", valid: false };
  }
  const usage = payload.usage;
  const required = [usage?.input_tokens, usage?.output_tokens, usage?.total_tokens];
  if (!required.every(Number.isFinite)) {
    return { usage: null, status: "invalid-token-fields", valid: false };
  }
  const optionalNumber = (value) => value === undefined || value === null ? 0 : (Number.isFinite(value) ? value : null);
  return {
    valid: true,
    status: "ok",
    usage: {
      source: "grok-result-json",
      actualModels,
      inputTokens: usage.input_tokens,
      cacheCreationInputTokens: optionalNumber(usage.cache_creation_input_tokens),
      cacheReadInputTokens: optionalNumber(usage.cache_read_input_tokens),
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      totalCostUsd: Number.isFinite(payload.total_cost_usd) ? payload.total_cost_usd : null,
    },
  };
}
function waitForRollout() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
function collectVendorUsage(options, invoked, env, observation) {
  if (!invoked) return { usage: null, status: "not-invoked" };
  if (options.vendor === "claude") {
    const inspected = observation ?? inspectClaudeOutput(options, null);
    return { usage: inspected.usage, status: inspected.status };
  }
  if (options.vendor === "grok") {
    const inspected = observation ?? inspectGrokOutput(options, null);
    return { usage: inspected.usage, status: inspected.status };
  }
  if (options.vendor !== "codex") return { usage: null, status: "unsupported-vendor" };
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
function credentialValues(env) {
  return Object.entries(env ?? {})
    .filter(([key, value]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value);
}
function redactEvidenceValue(value, env) {
  let result = String(value);
  for (const secret of credentialValues(env)) result = result.split(secret).join("[REDACTED]");
  return result;
}
function redactArgv(argv, env) {
  return argv.map((value) => redactEvidenceValue(value, env));
}
function redactNullable(value, env) {
  return value === null || value === undefined ? null : redactEvidenceValue(value, env);
}
function receiptEvidence(options, invoked, vendorUsage, env = {}) {
  const stop = options.providerStopSignals ?? {};
  return {
    modelReported: options.modelReported === "observed" || vendorUsage?.actualModels?.length ? "observed" : "none",
    effortRequested: redactNullable(options.effortRequested, env),
    truncatedSuspected: typeof options.truncatedSuspected === "boolean" ? options.truncatedSuspected : null,
    promptSource: redactNullable(options.promptSource, env),
    promptBytes: invoked ? (options.promptBytes ?? null) : 0,
    finish_reason: redactNullable(stop.finish_reason, env),
    finishReason: redactNullable(stop.finishReason, env),
    incomplete_details: stop.incomplete_details?.reason == null
      ? null
      : { reason: redactEvidenceValue(stop.incomplete_details.reason, env) },
  };
}
function writeReceipt(stderr, options, exit, startedAt, invoked, outputCheckStatus, env = process.env, vendorObservation = null, sinks = null) {
  const duration = ((Date.now() - startedAt) / 1000).toFixed(3);
  const requestedMode = options.mode ?? "default";
  let effectiveMode = "invalid";
  let inputProfile = "invalid";
  try { effectiveMode = effectiveVendorMode({ ...options, mode: requestedMode }); }
  catch { /* Validation errors still need a receipt with an explicit invalid mode. */ }
  try { inputProfile = effectiveInputProfile({ ...options, mode: requestedMode }); }
  catch { /* Validation errors still need a receipt with an explicit invalid profile. */ }
  stderr.write(`[dispatch] vendor=${options.vendor} op=${options.operation} mode=${requestedMode}/${effectiveMode} model=${redactNullable(options.model, env) ?? "-"} exit=${exit} duration=${duration}s\n`);
  try {
    const receipt = receiptPath(env, sinks);
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
    try { vendorUsage = collectVendorUsage(options, invoked, env, vendorObservation); }
    catch { /* Usage is additive; its own failure must not suppress the receipt. */ }
    const evidence = receiptEvidence(options, invoked, vendorUsage.usage, env);
    appendFileSync(receipt, `${separator}${JSON.stringify({
      schemaVersion: 1,
      ts: new Date().toISOString(),
      transport: "cli",
      vendor: options.vendor,
      provider: null,
      operation: options.operation,
      requestedMode,
      effectiveMode,
      inputProfile,
      modelRequested: redactNullable(options.modelRequested ?? options.model, env),
      model: redactNullable(options.model, env),
      effort: redactNullable(options.effort, env),
      ...evidence,
      lensId: options.lensId ?? null,
      exit,
      durationSec: Number(duration),
      invoked,
      cwd: options.cwd,
      outPath: options.out ?? null,
      errPath: options.err ?? null,
      pid: process.pid,
      argv: options.receiptArgv ?? [],
      executable: options.receiptExecutable ?? executableName(options.vendor),
      vendorUsage: vendorUsage.usage,
      vendorUsageStatus: vendorUsage.status,
      outputCheckStatus,
      outputChecks: options.outputChecks ?? null,
      expectedTotal: options.expectedTotal ?? null,
      attempts: invoked ? 1 : 0,
      attemptWaitsMs: invoked ? [0] : [],
      successfulAttempt: invoked && exit === 0 ? 1 : null,
      completionTokenLimit: options.completionTokenLimit ?? { requested: null, status: "not-applicable-cli" },
      failureClass: null,
      failureActor: null,
      remedy: null,
    })}\n`);
  } catch { /* Receipt recording must not affect dispatch. */ }
}

function writePortableReceipt(stderr, options, exit, startedAt, invoked, outputCheckStatus, env = process.env, vendorObservation = null, sinks = null) {
  try {
    const target = portableReceiptPath(env, sinks);
    if (!target) return;
    const duration = Number(((Date.now() - startedAt) / 1000).toFixed(3));
    const requestedMode = options.mode ?? "default";
    let effectiveMode = "invalid";
    let inputProfile = "invalid";
    try { effectiveMode = effectiveVendorMode({ ...options, mode: requestedMode }); } catch { /* closed invalid marker */ }
    try { inputProfile = effectiveInputProfile({ ...options, mode: requestedMode }); } catch { /* closed invalid marker */ }
    let observedUsage = { usage: null, status: "read-failed" };
    try { observedUsage = collectVendorUsage(options, invoked, env, vendorObservation); } catch { /* degraded below */ }
    const preparedUsage = preparePortableUsage(observedUsage.usage, observedUsage.status);
    const evidence = receiptEvidence(options, invoked, observedUsage.usage, env);
    const record = buildPortableReceipt(
      new Date().toISOString(),
      options.vendor,
      options.operation,
      requestedMode,
      effectiveMode,
      inputProfile,
      portableVocabulary(redactNullable(options.modelRequested ?? options.model, env), MAX_FREE_STRING),
      portableVocabulary(redactNullable(options.model, env), MAX_FREE_STRING),
      portableVocabulary(redactNullable(options.effort, env), 64),
      exit,
      duration,
      invoked,
      Boolean(options.out),
      Boolean(options.err),
      preparedUsage.usage,
      preparedUsage.status,
      outputCheckStatus,
      "cli",
      null,
      options.lensId ?? null,
      invoked ? 1 : 0,
      invoked && exit === 0 ? 1 : null,
      invoked ? [0] : [],
      options.completionTokenLimit ?? { requested: null, status: "not-applicable-cli" },
      null,
      null,
      null,
      evidence,
      options.outputChecks ?? null,
      options.expectedTotal ?? null,
    );
    appendPortableReceipt(target, record);
  } catch {
    warnPortableReceiptFailure(stderr);
  }
}

function portableVocabulary(value, maximum) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : null;
}

function warnPortableReceiptFailure(stderr) {
  try { stderr.write("dispatch portable receipt write failed\n"); } catch { /* Warning delivery is fail-open too. */ }
}

function writeDispatchReceipts(stderr, options, exit, startedAt, invoked, outputCheckStatus, env, vendorObservation, writers, internalReceipt, sinks) {
  try {
    (writers?.raw ?? writeReceipt)(stderr, options, exit, startedAt, invoked, outputCheckStatus, env, vendorObservation, sinks);
  } catch { /* An unexpected raw sink failure cannot affect dispatch or its sibling. */ }
  try {
    (writers?.portable ?? writePortableReceipt)(stderr, options, exit, startedAt, invoked, outputCheckStatus, env, vendorObservation, sinks);
  } catch {
    warnPortableReceiptFailure(stderr);
  }
  if (internalReceipt) {
    try {
      const internalEnv = {
        ...env,
        SECOND_OPINION_RECEIPT: internalReceipt,
        SECOND_OPINION_PORTABLE_RECEIPT: "",
      };
      (writers?.raw ?? writeReceipt)({ write: () => true }, options, exit, startedAt, invoked, outputCheckStatus, internalEnv, vendorObservation, {
        receipt: internalReceipt,
        portableReceipt: undefined,
      });
    } catch { /* A private usage receipt cannot affect the caller's configured sinks. */ }
  }
}

function appendRawReceiptRecord(target, record) {
  mkdirSync(dirname(target), { recursive: true });
  const existing = statSync(target, { throwIfNoEntry: false });
  let separator = "";
  if (existing?.size) {
    const descriptor = openSync(target, "r");
    try {
      const lastByte = Buffer.alloc(1);
      readSync(descriptor, lastByte, 0, 1, existing.size - 1);
      if (lastByte[0] !== 0x0a) separator = "\n";
    } finally { closeSync(descriptor); }
  }
  appendFileSync(target, `${separator}${JSON.stringify(record)}\n`);
}

function apiPortableUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    source: "api-response",
    actualModels: null,
    inputTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
    reasoningOutputTokens: null,
    totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
    totalCostUsd: null,
    contextWindow: null,
    quotaUsedPercent: null,
  };
}

export function writeApiDispatchReceipts(stderr, options, exit, startedAt, env = process.env, sinks = null) {
  const durationSec = Number(((Date.now() - startedAt) / 1000).toFixed(3));
  const invoked = Array.isArray(options.attemptLog) && options.attemptLog.length > 0;
  const actualAttempts = Math.max(0, Number.isInteger(options.attempts) ? options.attempts : 0);
  const attemptWaitsMs = Array.from({ length: actualAttempts }, (_, index) => {
    const waitedMs = options.attemptLog?.[index]?.waitedMs;
    return Number.isFinite(waitedMs) ? Math.max(0, waitedMs) : 0;
  });
  const evidence = receiptEvidence(options, invoked, null, env);
  try {
    stderr.write(`[dispatch] provider=${options.provider} op=generate model=${redactNullable(options.model, env) ?? "-"} exit=${exit} duration=${durationSec.toFixed(3)}s attempts=${options.attempts}\n`);
  } catch { /* summary delivery never changes generation */ }
  try {
    const target = receiptPath(env, sinks);
    if (target) {
      appendRawReceiptRecord(target, {
        schemaVersion: 1,
        ts: new Date().toISOString(),
        transport: "api",
        vendor: null,
        provider: options.provider,
        operation: "generate",
        requestedMode: "default",
        effectiveMode: "default",
        inputProfile: "none",
        modelRequested: redactNullable(options.model, env),
        model: redactNullable(options.model, env),
        effort: null,
        ...evidence,
        lensId: options.lensId ?? null,
        exit,
        durationSec,
        invoked,
        cwd: null,
        outPath: options.responsePath ?? null,
        errPath: null,
        pid: null,
        argv: null,
        executable: null,
        vendorUsage: apiPortableUsage(options.usage),
        vendorUsageStatus: options.usage ? "ok" : (exit === 0 ? "not-reported" : "vendor-reported-error"),
        outputCheckStatus: "not-requested",
        outputChecks: null,
        expectedTotal: null,
        attempts: actualAttempts,
        attemptWaitsMs,
        successfulAttempt: options.successfulAttempt ?? null,
        completionTokenLimit: { requested: options.maxCompletionTokens, status: "applied-unchanged" },
        failureClass: options.failureClass ?? null,
        failureActor: options.failureActor ?? null,
        remedy: options.remedy ?? null,
        retryAfter: options.retryAfter ?? { observed: false, value: null },
      });
    }
  } catch { /* Raw receipt recording remains fail-open. */ }
  try {
    const target = portableReceiptPath(env, sinks);
    if (!target) return;
    const prepared = preparePortableUsage(apiPortableUsage(options.usage), options.usage ? "ok" : (exit === 0 ? "not-reported" : "vendor-reported-error"));
    const record = buildPortableReceipt(
      new Date().toISOString(),
      null,
      "generate",
      "default",
      "default",
      "none",
      portableVocabulary(redactNullable(options.model, env), MAX_FREE_STRING),
      portableVocabulary(redactNullable(options.model, env), MAX_FREE_STRING),
      null,
      exit,
      durationSec,
      invoked,
      Boolean(options.responsePath),
      false,
      prepared.usage,
      prepared.status,
      "not-requested",
      "api",
      options.provider,
      options.lensId ?? null,
      actualAttempts,
      options.successfulAttempt ?? null,
      attemptWaitsMs,
      { requested: options.maxCompletionTokens, status: "applied-unchanged" },
      options.failureClass ?? null,
      options.failureActor ?? null,
      options.remedy ?? null,
      evidence,
      null,
      null,
    );
    appendPortableReceipt(target, record);
  } catch { warnPortableReceiptFailure(stderr); }
}
function openOutput(path) {
  const fd = openSync(path, "w");
  try { return createWriteStream(path, { fd, autoClose: true }); }
  catch (error) { closeSync(fd); throw error; }
}

function meaningfulCliPayload(chunk) {
  const text = (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)).trim();
  if (!text) return false;
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.some((line) => {
    try {
      const parsed = JSON.parse(line);
      const marker = parsed?.type ?? parsed?.event ?? parsed?.kind;
      return !(typeof marker === "string" && /^(?:heartbeat|ping|keep-?alive)$/i.test(marker.trim()));
    } catch { return true; }
  });
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
  const env = deps.env ?? process.env;
  const resolvedReceiptSinks = deps.receiptSinks ?? resolveReceiptSinks(env, deps.receiptConfigPath);
  const modelRequested = options.modelRequested ?? options.model;
  options = {
    ...options,
    mode: options.mode ?? "default",
    modelRequested,
    model: options.vendor === "codex" ? resolveCodexModelAlias(options.model, env) : options.model,
    brief: absoluteFrom(process.cwd(), options.brief),
    inputs: (options.inputs ?? []).map((input) => absoluteFrom(process.cwd(), input)),
    out: options.out ? absoluteFrom(process.cwd(), options.out) : undefined,
    err: options.err ? absoluteFrom(process.cwd(), options.err) : undefined,
  };
  const spawnImpl = deps.spawn;
  const parentStdout = deps.stdout ?? process.stdout;
  const parentStderr = deps.stderr ?? process.stderr;
  const receiptWriters = deps.receiptWriters;
  const internalReceipt = deps.internalReceiptPath ? absoluteFrom(process.cwd(), deps.internalReceiptPath) : undefined;
  const onStdoutChunk = deps.onStdoutChunk;
  const startedAt = Date.now();
  let vendorObservation = null;
  if ((options.expectOutputs !== undefined && !Array.isArray(options.expectOutputs))
    || (options.expectOutput !== undefined && (!Array.isArray(options.expectOutputs) || options.expectOutput !== options.expectOutputs[0]))) {
    parentStderr.write("dispatch validation error: run() accepts expectOutputs; expectOutput must match its first token\n");
    return 2;
  }
  if (options.expectedTotal !== undefined && options.expectedTotal !== null) {
    const declared = options.expectedTotal;
    const registered = Array.isArray(options.expectOutputs) ? options.expectOutputs.length : 0;
    // parseCli enforces this contract; run() is a separate entry point, and an
    // unchecked value here either reads as full registration (registered 0, so
    // `declared > outputChecks?.length` is false) or throws inside the portable
    // emitter, where the catch drops the entire row.
    const reason = !Number.isInteger(declared) || declared < 1 || declared > MAX_EXPECT_TOTAL
      ? `must be an integer from 1 to ${MAX_EXPECT_TOTAL}`
      : registered === 0
        ? "requires at least one expectOutputs token"
        : declared < registered
          ? "must be at least the number of expectOutputs tokens"
          : null;
    if (reason) {
      parentStderr.write(`dispatch validation error: run() expectedTotal ${reason}\n`);
      return 2;
    }
  }
  const expectedOutputTokens = options.expectOutputs ?? [];
  options = {
    ...options,
    outputChecks: expectedOutputTokens.length
      ? expectedOutputTokens.map((token) => ({ token, status: "missing" }))
      : null,
  };
  let outputCheckStatus = expectedOutputTokens.length ? "not-evaluated" : "not-requested";
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
  if (receiptConflicts(options, env, resolvedReceiptSinks)) {
    parentStderr.write("dispatch validation error: --out/--err must not equal SECOND_OPINION_RECEIPT\n");
    return 2;
  }
  const portableError = portableConfigError(options, env, resolvedReceiptSinks);
  if (portableError) {
    parentStderr.write(`dispatch validation error: ${portableError}\n`);
    return 2;
  }
  if (options.vendor === "claude" && (!options.model || !options.effort || !options.out || !options.err)) {
    parentStderr.write("dispatch validation error: Claude requires model, effort, out, and err\n");
    writeDispatchReceipts(parentStderr, options, 2, startedAt, false, outputCheckStatus, env, undefined, receiptWriters, internalReceipt, resolvedReceiptSinks);
    return 2;
  }
  if (options.vendor === "grok" && (!options.model || !options.out || !options.err)) {
    parentStderr.write("dispatch validation error: Grok requires model, out, and err\n");
    writeDispatchReceipts(parentStderr, options, 2, startedAt, false, outputCheckStatus, env, undefined, receiptWriters, internalReceipt, resolvedReceiptSinks);
    return 2;
  }
  const isGitRepo = options.isGitRepo ?? isGitRepository(options.cwd);
  let argv;
  try { argv = buildVendorArgv({ ...options, isGitRepo }); }
  catch (error) {
    const code = error instanceof PolicyError ? 2 : 3;
    const detail = error.message ?? "vendor mode resolution failed";
    parentStderr.write(`dispatch validation error: ${detail}\n`);
    writeDispatchReceipts(parentStderr, options, code, startedAt, false, outputCheckStatus, env, undefined, receiptWriters, internalReceipt, resolvedReceiptSinks);
    return code;
  }
  options = {
    ...options,
    receiptArgv: redactArgv(argv, env),
    receiptExecutable: executableName(options.vendor),
    receiptModelRequested: redactNullable(options.modelRequested ?? options.model, env),
    receiptModel: redactNullable(options.model, env),
    receiptEffort: redactNullable(options.effort, env),
  };
  if (options.dryRun) {
    parentStdout.write(`${JSON.stringify({ vendor: options.vendor, operation: options.operation, requestedMode: options.mode, effectiveMode: effectiveVendorMode(options), inputProfile: effectiveInputProfile(options), modelRequested: options.receiptModelRequested, model: options.receiptModel, executable: options.receiptExecutable, argv: options.receiptArgv, stdinMode: "brief-file", cwd: options.cwd })}\n`);
    writeDispatchReceipts(parentStderr, options, 0, startedAt, false, outputCheckStatus, env, undefined, receiptWriters, internalReceipt, resolvedReceiptSinks);
    return 0;
  }
  let brief;
  try { brief = composeVendorInput(options, readFileSync(options.brief)); }
  catch (error) {
    parentStderr.write(`dispatch internal error: unable to read brief (${error.code ?? "read_failed"})\n`);
    writeDispatchReceipts(parentStderr, options, 3, startedAt, false, outputCheckStatus, env, undefined, receiptWriters, internalReceipt, resolvedReceiptSinks);
    return 3;
  }
  options = { ...options, promptBytes: brief.byteLength };
  let executable;
  try { executable = spawnImpl === spawn ? resolveExecutable(options.vendor) : executableName(options.vendor); }
  catch (error) {
    const code = error instanceof PolicyError ? 2 : 3;
    parentStderr.write(`${error.message ?? "dispatch executable resolution failed"}\n`);
    writeDispatchReceipts(parentStderr, options, code, startedAt, false, outputCheckStatus, env, undefined, receiptWriters, internalReceipt, resolvedReceiptSinks);
    return code;
  }
  options = { ...options, receiptExecutable: redactEvidenceValue(executable, env) };
  let stdoutStream;
  let stderrStream;
  try {
    stdoutStream = options.out ? openOutput(options.out) : null;
    stderrStream = options.err ? openOutput(options.err) : null;
  } catch (error) {
    stdoutStream?.destroy();
    stderrStream?.destroy();
    parentStderr.write(`dispatch internal error: unable to open output file (${error.code ?? "open_failed"})\n`);
    writeDispatchReceipts(parentStderr, options, 3, startedAt, false, outputCheckStatus, env, undefined, receiptWriters, internalReceipt, resolvedReceiptSinks);
    return 3;
  }
  return await new Promise((resolveRun) => {
    let settled = false;
    let timedOut = false;
    let invoked = false;
    let child;
    let timer, silenceTimer, escalateTimer, reapTimer;
    let timeoutDeadlineMs = null;
    let silenceDeadlineMs = null;
    const validateExplicitOutput = options.mode !== "default";
    const jsonStdoutVendor = options.vendor === "claude" || options.vendor === "grok";
    const captureStdout = Boolean(stdoutStream || expectedOutputTokens.length || jsonStdoutVendor || validateExplicitOutput);
    let outputBytes = 0;
    const claudeOutputChunks = [];
    let claudeOutputBytes = 0;
    let claudeOutputTooLarge = false;
    const outputMatched = expectedOutputTokens.map(() => false);
    const clearTimers = () => { for (const t of [timer, silenceTimer, escalateTimer, reapTimer]) if (t) clearTimeout(t); };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // Individual checks describe the bytes actually observed even when the
      // vendor itself exits unsuccessfully. The aggregate status keeps its
      // established not-evaluated meaning outside a successful vendor exit.
      if (expectedOutputTokens.length) options.outputChecks = expectedOutputTokens.map((token, index) => ({ token, status: outputMatched[index] ? "matched" : "missing" }));
      if (jsonStdoutVendor && !vendorObservation) {
        vendorObservation = (options.vendor === "grok" ? inspectGrokOutput : inspectClaudeOutput)(options, {
          data: Buffer.concat(claudeOutputChunks),
          tooLarge: claudeOutputTooLarge,
        });
      }
      writeDispatchReceipts(parentStderr, options, code === 124 ? "timeout" : code, startedAt, invoked, outputCheckStatus, env, vendorObservation, receiptWriters, internalReceipt, resolvedReceiptSinks);
      resolveRun(code);
    };
    try {
      const spawnOptions = { cwd: options.cwd, shell: false, stdio: ["pipe", captureStdout ? "pipe" : "inherit", stderrStream ? "pipe" : "inherit"], windowsHide: true };
      const rawReceiptConfigured = Boolean(receiptPath(env, resolvedReceiptSinks));
      const isolateGrok = grokNeedsHarnessIsolation(options);
      if (rawReceiptConfigured || hasEnvKey(env, "SECOND_OPINION_PORTABLE_RECEIPT") || options.vendor === "claude" || isolateGrok) {
        spawnOptions.env = isolateGrok ? applyGrokHarnessIsolationEnv(env) : { ...env };
        for (const key of Object.keys(spawnOptions.env)) {
          const upper = key.toUpperCase();
          if (upper === "SECOND_OPINION_PORTABLE_RECEIPT"
            || (rawReceiptConfigured && upper === "SECOND_OPINION_RECEIPT")
            || (options.vendor === "claude" && upper === "CLAUDECODE")) {
            delete spawnOptions.env[key];
          }
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
    const expected = expectedOutputTokens.map((token) => Buffer.from(token, "ascii"));
    let outputTail = Buffer.alloc(0);
    const finishOutputCheck = () => {
      const missing = expectedOutputTokens.filter((_token, index) => !outputMatched[index]);
      outputCheckStatus = missing.length ? "missing" : "matched";
      if (missing.length) parentStderr.write(`dispatch output check failed: missing token${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}\n`);
      return missing.length ? 4 : 0;
    };
    const triggerTimeout = () => {
      if (settled || timedOut) return;
      // Resolve by absolute deadlines instead of callback insertion order.
      // Silence wins an exact tie; a later meaningful payload moves only the
      // silence deadline and leaves the caller/cost deadline intact.
      const kind = silenceDeadlineMs !== null
        && (timeoutDeadlineMs === null || silenceDeadlineMs <= timeoutDeadlineMs)
        ? "silence"
        : "backstop";
      timedOut = true;
      try { deps.onTimeout?.(kind); } catch { /* timeout attribution must not change termination */ }
      if (timer) clearTimeout(timer);
      if (silenceTimer) clearTimeout(silenceTimer);
      try { child.kill(); } catch { /* already gone */ }
      escalateTimer = setTimeout(() => {
        try { forceKill(child); } catch { /* best effort */ }
        reapTimer = setTimeout(() => finish(124), reapMs);
      }, graceMs);
    };
    const armSilenceTimer = (originMs = Date.now(), recordPayload = true) => {
      if (settled || timedOut) return;
      if (!Number.isFinite(options.silenceTimeout) || options.silenceTimeout <= 0) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceDeadlineMs = originMs + (options.silenceTimeout * 1000);
      if (recordPayload) {
        try { deps.onSilenceDeadline?.(originMs, silenceDeadlineMs); } catch { /* observation must not change termination */ }
      }
      silenceTimer = setTimeout(triggerTimeout, Math.max(1, silenceDeadlineMs - Date.now()));
    };
    child.once("spawn", () => { invoked = true; });
    const timerStartedAt = Date.now();
    timeoutDeadlineMs = options.timeoutDeadlineMs ?? timerStartedAt + (options.timeout * 1000);
    timer = setTimeout(triggerTimeout, Math.max(1, timeoutDeadlineMs - timerStartedAt));
    armSilenceTimer(options.silenceOriginMs ?? timerStartedAt, false);
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
      else if (code === 0 && jsonStdoutVendor) {
        vendorObservation = (options.vendor === "grok" ? inspectGrokOutput : inspectClaudeOutput)(options, {
          data: Buffer.concat(claudeOutputChunks),
          tooLarge: claudeOutputTooLarge,
        });
        if (!vendorObservation.valid) {
          const vendorLabel = options.vendor === "claude" ? "Claude" : options.vendor === "grok" ? "Grok" : options.vendor;
          parentStderr.write(`dispatch ${vendorLabel} output validation failed: ${vendorObservation.status}\n`);
          finish(4);
        } else if (expected.length) finish(finishOutputCheck());
        else finish(0);
      }
      else if (code === 0 && expected.length) finish(finishOutputCheck());
      else if (code === 0 && validateExplicitOutput && outputBytes === 0) {
        parentStderr.write("dispatch output validation failed: explicit mode returned empty output\n");
        finish(4);
      } else finish(code);
    });
    child.stdin.once("error", streamError);
    stdoutStream?.once("error", streamError);
    stderrStream?.once("error", streamError);
    if (expected.length) {
      child.stdout.on("data", (chunk) => {
        if (outputMatched.every(Boolean)) return;
        const combined = Buffer.concat([outputTail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        for (let index = 0; index < expected.length; index += 1) {
          if (!outputMatched[index] && combined.includes(expected[index])) outputMatched[index] = true;
        }
        const maxExpectedBytes = Math.max(...expected.map((token) => token.length));
        if (!outputMatched.every(Boolean)) outputTail = combined.subarray(Math.max(0, combined.length - maxExpectedBytes + 1));
      });
    }
    if (captureStdout) {
      child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (meaningfulCliPayload(chunk)) armSilenceTimer();
        try { onStdoutChunk?.(chunk); } catch { /* observation must not break dispatch */ }
      });
    }
    if (jsonStdoutVendor) {
      child.stdout.on("data", (chunk) => {
        if (claudeOutputTooLarge) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        claudeOutputBytes += data.length;
        if (claudeOutputBytes > MAX_VENDOR_USAGE_BYTES) {
          claudeOutputTooLarge = true;
          claudeOutputChunks.length = 0;
        } else claudeOutputChunks.push(data);
      });
    }
    if (stdoutStream) child.stdout.pipe(stdoutStream);
    else if (captureStdout) child.stdout.pipe(parentStdout, { end: false });
    if (stderrStream) {
      child.stderr.on("data", (chunk) => {
        if (meaningfulCliPayload(chunk)) armSilenceTimer();
      });
      child.stderr.pipe(stderrStream);
    }
    try {
      // Grok already has the brief as --prompt-file. Writing it to stdin too
      // duplicates the prompt or can stall waiting on stdin.
      if (options.vendor === "grok") child.stdin.end();
      else child.stdin.end(brief);
    } catch (error) { streamError(error); }
  });
}

async function main() {
  process.exitCode = await executeCli(process.argv.slice(2));
}

export async function executeCli(argv, deps = {}) {
  if (argv[0] === "--request-json") {
    const { executeGenerationCli } = await import("./generation-dispatch.mjs");
    return await executeGenerationCli(argv, {
      ...deps,
      runSubscription: async (options, runDeps) => await run(options, { spawn, ...runDeps }),
    });
  }
  let options;
  const stderr = deps.stderr ?? process.stderr;
  // Help is answered before parsing so it works with no other arguments, and it
  // goes to stdout with exit 0 — a caller piping usage into a log should not
  // have to treat success as an error.
  //
  // Only the FIRST argument counts. Scanning the whole argv would swallow real
  // calls whose *values* happen to be "help"/"-h" (`--model help`, `--out -h`)
  // and exit 0 without ever reaching the vendor — a silent skip is worse than a
  // missing convenience. A value can never occupy argv[0], so this position is
  // unambiguous. `--vendor x --help` still reaches the parser and prints the
  // same usage through the unknown-argument path, just with exit 2.
  if (argv.length === 0 || HELP_FLAGS.has(argv[0])) {
    (deps.stdout ?? process.stdout).write(`${usageText()}\n`);
    return 0;
  }
  try {
    options = parseCli(argv, deps.cwd ?? process.cwd(), {
      env: deps.env,
      spawnSync: deps.spawnSync,
      modelCatalogs: deps.modelCatalogs,
      cachePath: deps.cachePath,
      now: deps.now,
    });
  }
  catch (error) {
    stderr.write(`dispatch validation error: ${error.message}\n`);
    return 2;
  }
  const runDeps = deps.spawn ? { spawn: deps.spawn, stdout: deps.stdout, stderr, env: deps.env, onStdoutChunk: deps.onStdoutChunk } : { spawn, stdout: deps.stdout, stderr, env: deps.env, onStdoutChunk: deps.onStdoutChunk };
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
// Let this module finish evaluating before generation-dispatch imports it back.
// The catch keeps a rejected main() fatal on its own terms: `void` would route the
// rejection through --unhandled-rejections policy, where `warn` turns a failed
// dispatch into a silent exit 0.
if (invokedAsMain()) main().catch((error) => { process.exitCode = 1; console.error(error); });
