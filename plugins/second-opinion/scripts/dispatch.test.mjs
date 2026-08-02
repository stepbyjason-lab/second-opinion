import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AGY_NATIVE_READONLY_PROFILE,
  PolicyError,
  buildVendorArgv,
  composeVendorInput,
  detectDirectInference,
  effectiveInputProfile,
  effectiveVendorMode,
  resolveExecutable,
} from "./vendor-policy.mjs";
import { executeCli, parseCli, resolveCodexModelAlias, resolveModelRoute, resolveVendorForModel, run, splitModelEffort, usageText } from "./dispatch.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
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

test("skill resolves the catalog path directly before declaring it missing", () => {
  // This is a user-facing operations contract, not prose decoration. A PS 5.1
  // `rg --files | rg '...$'` false negative previously produced a false install error.
  const skill = readFileSync(new URL("../skills/second-opinion/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /available-skills 카탈로그의 root alias와 상대 경로/);
  assert.match(skill, /Test-Path -LiteralPath/);
  assert.match(skill, /rg --files <root> -g 'SKILL\.md' -g 'dispatch\.mjs'/);
  assert.match(skill, /검색 결과가 비었다는 이유만으로 설치 누락이나 카탈로그 오류라고 단정하지 않는다/);
});

test("0.9.4 public help and documentation describe cache-first ranked routing", () => {
  const plugin = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const skill = readFileSync(new URL("../skills/second-opinion/SKILL.md", import.meta.url), "utf8");
  const publicReadmeUrls = [new URL("../../../README.md", import.meta.url), new URL("../../../README.ko.md", import.meta.url)];
  const publicReadmes = publicReadmeUrls.filter((url) => existsSync(url)).map((url) => readFileSync(url, "utf8"));
  assert.equal(plugin.version, "0.9.4");
  assert.ok(publicReadmes.length === 0 || publicReadmes.length === 2, "public snapshot must carry both README files");
  for (const text of [skill, ...publicReadmes]) {
    assert.match(text, /0\.9\.4/);
    assert.match(text, /model-catalog-v1\.json/);
    assert.match(text, /opus 4\.6/);
  }
  assert.match(usageText(), /cached for 24h.*model-catalog-v1\.json/s);
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
  const scripts = scriptsDirectory;
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
  { vendor: "codex", operation: "text", model: "gpt model \"quoted\"", effort: "high", inputs: [], isGitRepo: false, cwd: root,
    argv: ["exec", "--skip-git-repo-check", "-m", "gpt model \"quoted\"", "-c", "model_reasoning_effort=\"high\"", "-"] },
  { vendor: "codex", operation: "image-analyze", model: "gpt model \"quoted\"", effort: "high", inputs: [input1, input2], isGitRepo: false, cwd: root,
    argv: ["exec", "--skip-git-repo-check", "-m", "gpt model \"quoted\"", "-c", "model_reasoning_effort=\"high\"", "-i", input1, "-i", input2, "-"] },
  { vendor: "codex", operation: "image-generate", model: "gpt model \"quoted\"", effort: "high", inputs: [], isGitRepo: false, cwd: root,
    argv: ["exec", "-s", "workspace-write", "--skip-git-repo-check", "-m", "gpt model \"quoted\"", "-c", "model_reasoning_effort=\"high\"", "-"] },
  // agy carries our timeout into its own --print-timeout (default 5m0s would
  // otherwise kill long jobs with exit 1 before the dispatcher acts). 1234 is
  // deliberately not the dispatcher default, so a passing fixture proves the
  // value is propagated rather than coincidentally matching.
  { vendor: "agy", operation: "text", model: "Gemini 3.5 Flash (High)", inputs: [], isGitRepo: false, timeout: 1234, cwd: root,
    argv: ["--dangerously-skip-permissions", "--print-timeout", "1234s", "--model", "Gemini 3.5 Flash (High)", "--add-dir", root] },
  { vendor: "agy", operation: "image-analyze", model: "Gemini 3.5 Flash (High)", inputs: [input1, input2, input3], isGitRepo: false, timeout: 1234, cwd: dirname(input1),
    argv: ["--dangerously-skip-permissions", "--print-timeout", "1234s", "--model", "Gemini 3.5 Flash (High)", "--add-dir", dirname(input1), "--add-dir", dirname(input3)] },
  { vendor: "agy", operation: "image-generate", model: "Gemini 3.5 Flash (High)", inputs: [], isGitRepo: false, timeout: 1234, cwd: root,
    argv: ["--dangerously-skip-permissions", "--print-timeout", "1234s", "--model", "Gemini 3.5 Flash (High)", "--add-dir", root] },
  { vendor: "claude", operation: "text", model: "opus", effort: "high", inputs: [], isGitRepo: false, cwd: root,
    argv: ["-p", "--model", "opus", "--effort", "high", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--disable-slash-commands", "--dangerously-skip-permissions", "--tools=default"] },
];

test("seven hand-written argv fixtures match policy exactly", () => {
  for (const fixture of FIXTURES) assert.deepEqual(buildVendorArgv(fixture), fixture.argv, `${fixture.vendor}/${fixture.operation}`);
  assert.deepEqual(FIXTURES.filter((fixture) => fixture.argv.includes("-s")).map((fixture) => `${fixture.vendor}/${fixture.operation}`), ["codex/image-generate"]);
  for (const fixture of FIXTURES.filter((fixture) => fixture.operation !== "image-generate")) assert.equal(fixture.argv.includes("-s"), false);
  assert.equal(FIXTURES.at(-1).argv.some((value) => /^timeout$/i.test(value)), false);
});

const MODE_FIXTURES = [
  {
    vendor: "agy", operation: "text", mode: "plan", model: "Gemini 3.5 Flash (High)",
    inputs: [], timeout: 1234, cwd: root,
    effectiveMode: "plan",
    inputProfile: AGY_NATIVE_READONLY_PROFILE,
    argv: ["--mode", "plan", "--print-timeout", "1234s", "--model", "Gemini 3.5 Flash (High)", "--add-dir", root],
  },
  {
    vendor: "agy", operation: "text", mode: "review", model: "Gemini 3.5 Flash (High)",
    inputs: [], timeout: 1234, cwd: root,
    effectiveMode: "plan",
    inputProfile: AGY_NATIVE_READONLY_PROFILE,
    argv: ["--mode", "plan", "--print-timeout", "1234s", "--model", "Gemini 3.5 Flash (High)", "--add-dir", root],
  },
  {
    vendor: "claude", operation: "text", mode: "plan", model: "opus", effort: "high",
    inputs: [], cwd: root,
    effectiveMode: "plan",
    inputProfile: "none",
    argv: ["-p", "--model", "opus", "--effort", "high", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--disable-slash-commands", "--tools=Read,Glob,Grep"],
  },
  {
    vendor: "claude", operation: "text", mode: "review", model: "opus", effort: "high",
    inputs: [], cwd: root,
    effectiveMode: "review",
    inputProfile: "none",
    argv: ["-p", "--model", "opus", "--effort", "high", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--disable-slash-commands", "--tools=Read,Glob,Grep"],
  },
  {
    vendor: "codex", operation: "text", mode: "review", model: "gpt model \"quoted\"",
    effort: "high", inputs: [], isGitRepo: false, cwd: root,
    effectiveMode: "review",
    inputProfile: "none",
    argv: ["exec", "review", "--skip-git-repo-check", "-m", "gpt model \"quoted\"", "-c", "model_reasoning_effort=\"high\"", "-"],
  },
];

test("explicit plan and review modes map to closed provider-native argv", () => {
  for (const fixture of MODE_FIXTURES) {
    assert.equal(effectiveVendorMode(fixture), fixture.effectiveMode, `${fixture.vendor}/${fixture.mode}`);
    assert.equal(effectiveInputProfile(fixture), fixture.inputProfile, `${fixture.vendor}/${fixture.mode}`);
    assert.deepEqual(buildVendorArgv(fixture), fixture.argv, `${fixture.vendor}/${fixture.mode}`);
    if (fixture.vendor === "claude") {
      assert.equal(fixture.argv.includes("--permission-mode"), false, `${fixture.vendor}/${fixture.mode} must not enable a permission workflow`);
      assert.equal(fixture.argv.some((value) => /(?:Write|Edit|Bash|Agent)/.test(value)), false, `${fixture.vendor}/${fixture.mode} must not expose write or process tools`);
      assert.deepEqual(fixture.argv.filter((value) => value.startsWith("--tools=")), ["--tools=Read,Glob,Grep"], `${fixture.vendor}/${fixture.mode} closed tool allowlist`);
    }
  }
  assert.throws(
    () => buildVendorArgv({ ...FIXTURES[0], mode: "plan" }),
    (error) => error instanceof PolicyError && error.classification === "mode_unsupported",
  );
});

// R033-H8. The Claude channel's `default` used to be `--tools=` — no tools at
// all — while explicit --mode plan|review could at least read. The general
// call was weaker than the read-only ones, so anything asked to implement had
// to ship its patch as output text. That empty allowlist was a review-only
// bridge (f6b6953) frozen into the default branch when explicit modes landed
// (60a760f), and left in place by the review-identity fix (6a83b66). This test
// pins the permission split so the bridge cannot be re-inherited: default is
// full access, explicit plan/review stay read-only, and neither uses a sandbox,
// worktree, snapshot, or rewritten cwd as the permission model.
test("Claude default carries full tool access while explicit plan and review stay read-only", async () => {
  const claudeDefault = FIXTURES.find((fixture) => fixture.vendor === "claude");
  const defaultArgv = buildVendorArgv(claudeDefault);
  assert.deepEqual(defaultArgv, claudeDefault.argv);

  // An empty allowlist is the exact regression: it must not survive anywhere in
  // the default call, in either spelling.
  assert.equal(defaultArgv.includes("--tools="), false, "default must not ship an empty tool allowlist");
  assert.equal(defaultArgv.some((value) => /^--tools=\s*$/.test(value)), false, "default must not ship a blank tool allowlist");

  // The two flags that actually let the default call do work rather than
  // describe it.
  assert.ok(defaultArgv.includes("--tools=default"), "default must open the full built-in tool set");
  assert.ok(defaultArgv.includes("--dangerously-skip-permissions"), "default must run non-interactively without a permission prompt");

  // No read-only or permission-workflow behavior may leak back into default.
  assert.equal(defaultArgv.some((value) => value.startsWith("--permission-mode")), false, "default must not enable a permission workflow");
  assert.equal(defaultArgv.some((value) => value.includes("Read,Glob,Grep")), false, "default must not inherit the read-only allowlist");

  // --safe-mode is configuration isolation (CLAUDE.md, hooks, plugins, MCP),
  // not a filesystem sandbox. It coexists with full access and stays.
  assert.ok(defaultArgv.includes("--safe-mode"), "default keeps configuration isolation");

  const readOnly = MODE_FIXTURES.filter((fixture) => fixture.vendor === "claude");
  assert.deepEqual(readOnly.map((fixture) => fixture.mode), ["plan", "review"]);
  for (const fixture of readOnly) {
    const argv = buildVendorArgv(fixture);
    assert.deepEqual(argv, fixture.argv, fixture.mode);
    assert.deepEqual(argv.filter((value) => value.startsWith("--tools=")), ["--tools=Read,Glob,Grep"], `${fixture.mode} closed read-only allowlist`);
    assert.equal(argv.includes("--tools=default"), false, `${fixture.mode} must not open the full tool set`);
    assert.equal(argv.includes("--dangerously-skip-permissions"), false, `${fixture.mode} must not skip permissions`);
    for (const forbidden of ["Write", "Edit", "Bash", "PowerShell", "Agent"]) {
      assert.equal(argv.some((value) => value.includes(forbidden)), false, `${fixture.mode} must not expose ${forbidden}`);
    }
  }

  // Omitting --mode stays default end to end: the dispatcher never guesses an
  // unstated mode, and the receipt keeps the same identity it always had.
  const receipt = join(root, "claude-default-permission.jsonl");
  const out = join(root, "claude-default-permission.out");
  const err = join(root, "claude-default-permission.err");
  let captured;
  const spawnFake = (_executable, argv, spawnOptions) => {
    captured = { argv, spawnOptions };
    return fakeChild((child) => {
      child.stdin.on("end", () => {
        child.stdout.end(claudeResult());
        child.stderr.end();
        queueMicrotask(() => child.emit("close", 0, null));
      });
      child.stdin.resume();
    });
  };
  assert.equal(claudeDefault.mode, undefined, "the default fixture must carry no explicit mode");
  const code = await run({ ...claudeDefault, brief, cwd: root, out, err, timeout: 2, dryRun: false }, {
    spawn: spawnFake, stderr: memoryWriter().stream, env: { SECOND_OPINION_RECEIPT: receipt },
  });
  assert.equal(code, 0);
  const [row] = receiptLines(receipt);
  assert.equal(row.requestedMode, "default");
  assert.equal(row.effectiveMode, "default");
  assert.equal(row.inputProfile, "none");
  assert.deepEqual(captured.argv, claudeDefault.argv);

  // The split is flags only. Every Claude argv is pure vendor flags carrying no
  // directory of its own, and the child runs in the caller's real cwd — no
  // isolation primitive is introduced as the permission model.
  for (const fixture of [claudeDefault, ...readOnly]) {
    const label = fixture.mode ?? "default";
    const argv = buildVendorArgv(fixture);
    for (const value of argv) {
      assert.doesNotMatch(value, /sandbox|worktree|snapshot/i, `${label}: ${value}`);
      assert.equal(value.includes(fixture.cwd), false, `${label} argv must carry no directory: ${value}`);
    }
    assert.equal(argv.includes("--add-dir"), false, `${label} must not rewrite scope`);
    assert.equal(argv.includes("--cwd"), false, `${label} must not rewrite cwd`);
  }
  assert.equal(captured.spawnOptions.cwd, root, "the Claude child runs in the caller's real cwd");
  assert.equal(row.cwd, root);

  const planDryRun = memoryWriter();
  assert.equal(await executeCli([
    "--vendor", "claude", "--operation", "text", "--mode", "plan", "--brief", brief,
    "--cwd", root, "--model", "opus", "--effort", "high",
    "--out", join(root, "claude-plan-cwd.out"), "--err", join(root, "claude-plan-cwd.err"), "--dry-run",
  ], { cwd: root, stdout: planDryRun.stream, stderr: memoryWriter().stream }), 0);
  assert.equal(JSON.parse(planDryRun.value()).cwd, root, "explicit plan keeps the same real cwd");
});

test("AGY explicit modes compose the native-readonly profile while every other input stays byte-identical", () => {
  const original = Buffer.from("inspect git diff origin/main, then review 현재 파일\n", "utf8");
  for (const mode of ["plan", "review"]) {
    const composed = composeVendorInput({ vendor: "agy", operation: "text", mode }, original);
    assert.notStrictEqual(composed, original);
    assert.match(composed.toString("utf8"), /profile="agy-native-readonly\/v1"/);
    assert.match(composed.toString("utf8"), /Use only Antigravity native file listing, file reading, and code-search tools/);
    assert.match(composed.toString("utf8"), /Do not request or invoke terminal, command, shell/);
    const offset = composed.indexOf(original);
    assert.notEqual(offset, -1);
    assert.deepEqual(composed.subarray(offset, offset + original.length), original);
  }
  for (const options of [
    { vendor: "agy", operation: "text", mode: "default" },
    { vendor: "codex", operation: "text", mode: "review" },
    { vendor: "claude", operation: "text", mode: "review" },
  ]) {
    assert.strictEqual(composeVendorInput(options, original), original);
    assert.equal(effectiveInputProfile(options), "none");
  }
});

test("codex omits --skip-git-repo-check inside a git work tree", () => {
  const inTree = buildVendorArgv({ vendor: "codex", operation: "text", model: "m", effort: "high", inputs: [], isGitRepo: true });
  assert.equal(inTree.includes("--skip-git-repo-check"), false);
  assert.deepEqual(inTree, ["exec", "-m", "m", "-c", "model_reasoning_effort=\"high\"", "-"]);
});

function modelCache(entries, raw) {
  const home = makeTempDir("second-opinion-model-cache-");
  writeFileSync(
    join(home, "models_cache.json"),
    raw ?? JSON.stringify({ models: entries.map((entry) => typeof entry === "string" ? { slug: entry } : entry) }),
  );
  return home;
}

test("model@effort shorthand splits only a recognized final suffix when effort is absent", () => {
  assert.deepEqual(splitModelEffort("luna@high", undefined), { model: "luna", effort: "high" });
  assert.deepEqual(splitModelEffort("future@family@xhigh", undefined), { model: "future@family", effort: "xhigh" });
  assert.deepEqual(splitModelEffort("5.6 sol@ultra", undefined), { model: "5.6 sol", effort: "ultra" });
  assert.deepEqual(splitModelEffort("5.5@maximum", undefined), { model: "5.5", effort: "max" });
  assert.deepEqual(splitModelEffort("opus@very-high", undefined), { model: "opus", effort: "xhigh" });
  assert.deepEqual(splitModelEffort("opus@very_high", undefined), { model: "opus", effort: "xhigh" });
  assert.deepEqual(splitModelEffort("opus@minimal", undefined), { model: "opus@minimal", effort: undefined });
  assert.deepEqual(splitModelEffort("luna@turbo", undefined), { model: "luna@turbo", effort: undefined });
  assert.deepEqual(splitModelEffort("luna@high", "medium"), { model: "luna@high", effort: "medium" });
});

test("Codex model aliases resolve through exact or unique cache matches and otherwise preserve input", () => {
  const unique = modelCache(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.equal(resolveCodexModelAlias("gpt-5.6-luna", { CODEX_HOME: unique }), "gpt-5.6-luna");
  assert.equal(resolveCodexModelAlias("GPT-5.6-LUNA", { CODEX_HOME: unique }), "gpt-5.6-luna");
  assert.equal(resolveCodexModelAlias("gpt 5.6 luna", { CODEX_HOME: unique }), "gpt-5.6-luna");
  assert.equal(resolveCodexModelAlias("5.6 sol", { CODEX_HOME: unique }), "gpt-5.6-sol");
  assert.equal(resolveCodexModelAlias("luna", { CODEX_HOME: unique }), "gpt-5.6-luna");
  assert.equal(resolveCodexModelAlias("sol", { CODEX_HOME: unique }), "gpt-5.6-sol");
  assert.equal(resolveCodexModelAlias("unknown", { CODEX_HOME: unique }), "unknown");

  const ambiguous = modelCache(["gpt-5.6-luna", "vendor-preview-luna"]);
  assert.equal(resolveCodexModelAlias("luna", { CODEX_HOME: ambiguous }), "luna");

  const malformed = modelCache([], "{not-json");
  assert.equal(resolveCodexModelAlias("luna", { CODEX_HOME: malformed }), "luna");
  assert.equal(resolveCodexModelAlias("luna", { CODEX_HOME: join(root, "missing-model-cache") }), "luna");
});

test("omitting --vendor ranks exact catalog names over inferred families and canonicalizes the executable model", () => {
  const catalogs = {
    codex: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"],
    agy: ["gemini-3.6-flash-high", "claude-opus-4-6-thinking", "claude-sonnet-4-6"],
    claude: [
      { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable 5" },
      { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus 5" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5" },
    ],
  };
  assert.equal(resolveVendorForModel("luna", { modelCatalogs: catalogs }), "codex");
  assert.deepEqual(resolveModelRoute("terra", { modelCatalogs: catalogs }), { vendor: "codex", model: "gpt-5.6-terra" });
  assert.equal(resolveVendorForModel("fable", { modelCatalogs: catalogs }), "claude");
  assert.deepEqual(resolveModelRoute("fable", { modelCatalogs: catalogs }), { vendor: "claude", model: "claude-fable-5" });
  assert.equal(resolveVendorForModel("gemini-3.6-flash-high", { modelCatalogs: catalogs }), "agy");
  assert.deepEqual(resolveModelRoute("opus", { modelCatalogs: catalogs }), { vendor: "claude", model: "opus" });
  assert.deepEqual(resolveModelRoute("opus 5", { modelCatalogs: catalogs }), { vendor: "claude", model: "claude-opus-5" });
  assert.deepEqual(resolveModelRoute("opus 4.8", { modelCatalogs: catalogs }), { vendor: "claude", model: "claude-opus-4-8" });
  assert.deepEqual(resolveModelRoute("opus 4.7", { modelCatalogs: catalogs }), { vendor: "claude", model: "claude-opus-4-7" });
  assert.deepEqual(resolveModelRoute("opus 4.6", { modelCatalogs: catalogs }), { vendor: "agy", model: "claude-opus-4-6-thinking" });
  assert.deepEqual(resolveModelRoute("Claude Opus 4.6 (Thinking)", { modelCatalogs: catalogs }), { vendor: "agy", model: "claude-opus-4-6-thinking" });
  assert.deepEqual(resolveModelRoute("sonnet 4.6", { modelCatalogs: catalogs }), { vendor: "agy", model: "claude-sonnet-4-6" });
  assert.deepEqual(resolveModelRoute("Claude Code opus 4.6", { modelCatalogs: catalogs }), { vendor: "claude", model: "claude-opus-4-6" });
  assert.deepEqual(resolveModelRoute("gpt 5.5", { modelCatalogs: catalogs }), { vendor: "codex", model: "gpt-5.5" });
  assert.deepEqual(resolveModelRoute("5.5", { modelCatalogs: catalogs }), { vendor: "codex", model: "gpt-5.5" });
  assert.throws(() => resolveModelRoute("opus terra", { modelCatalogs: catalogs }), /unknown model/);
  assert.throws(() => resolveVendorForModel("unknown", { modelCatalogs: catalogs }), /unknown model/);

  const auto = parseCli([
    "--operation", "text", "--brief", brief, "--model", "fable@high",
    "--out", join(root, "auto-claude.out"), "--err", join(root, "auto-claude.err"),
  ], root, { modelCatalogs: catalogs });
  assert.equal(auto.vendor, "claude");
  assert.equal(auto.model, "claude-fable-5");
  assert.equal(auto.effort, "high");

  const explicit = parseCli([
    "--vendor", "codex", "--operation", "text", "--brief", brief, "--model", "fable",
  ], root, { spawnSync: () => { throw new Error("explicit vendor must not discover catalogs"); } });
  assert.equal(explicit.vendor, "codex", "an explicit vendor must win over model discovery");
});

function claudeCatalogOutput(models = [{ value: "opus", resolvedModel: "claude-opus-5[1m]", displayName: "Opus 5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }]) {
  return `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "catalog", response: { models, account: { email: "must-not-be-cached@example.test" } } } })}\n`;
}

function liveCatalogFake(command) {
  return command === "agy"
    ? { status: 0, stdout: "gemini-3.6-flash-high\nclaude-opus-4-6-thinking\n", stderr: "" }
    : { status: 0, stdout: claudeCatalogOutput(), stderr: "" };
}

test("automatic routing exercises provider metadata parsers and rejects incomplete discovery", () => {
  const home = modelCache(["gpt-5.6-luna"]);
  const cachePath = join(makeTempDir("second-opinion-route-cache-"), "catalog.json");
  const invocations = [];
  const deps = { env: { CODEX_HOME: home }, cachePath, spawnSync: (command, args, options) => {
    invocations.push({ command, args, input: options.input, timeout: options.timeout, killSignal: options.killSignal, maxBuffer: options.maxBuffer });
    return liveCatalogFake(command);
  } };
  assert.equal(resolveVendorForModel("opus", deps), "claude");
  assert.deepEqual(resolveModelRoute("opus 4.8", deps), { vendor: "claude", model: "claude-opus-4-8" });
  const claudeInvocation = invocations.find((row) => row.command === "claude");
  assert.ok(claudeInvocation);
  assert.equal(claudeInvocation.args.includes("--help"), false);
  assert.equal(claudeInvocation.args.includes("-p"), false, "initialize control protocol is intentionally not print mode");
  assert.ok(claudeInvocation.args.includes("stream-json"));
  assert.match(claudeInvocation.input, /"subtype":"initialize"/);
  assert.deepEqual({ timeout: claudeInvocation.timeout, killSignal: claudeInvocation.killSignal, maxBuffer: claudeInvocation.maxBuffer }, { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(invocations.every((row) => row.command !== "claude" || row.input.endsWith("\n")), true);
  const cachedText = readFileSync(cachePath, "utf8");
  assert.doesNotMatch(cachedText, /must-not-be-cached|account|email/);

  const failedClaude = (command) => command === "agy"
    ? liveCatalogFake(command)
    : { status: 1, stdout: "", stderr: "help failed" };
  assert.throws(
    () => resolveVendorForModel("opus", { env: { CODEX_HOME: home }, cachePath: join(makeTempDir("second-opinion-failed-cache-"), "catalog.json"), spawnSync: failedClaude }),
    /model catalog unavailable.*claude.*pass --vendor explicitly/,
  );
  assert.throws(
    () => resolveVendorForModel("fable", {
      env: { CODEX_HOME: home },
      cachePath: join(makeTempDir("second-opinion-empty-cache-"), "catalog.json"),
      spawnSync: (command) => ({ status: 0, stdout: command === "agy" ? "Display Model (High)" : "unparseable", stderr: "" }),
    }),
    /model catalog unavailable.*agy, claude/,
  );
});

test("catalog cache avoids provider calls for 24h, refreshes a fresh miss once, and keeps last-known-good data", () => {
  const home = modelCache(["gpt-5.6-luna"]);
  const cachePath = join(makeTempDir("second-opinion-cache-policy-"), "catalog.json");
  const now = 2_000_000_000_000;
  const seed = {
    schemaVersion: 1,
    checkedAt: now,
    degraded: false,
    vendors: {
      codex: { available: true, models: [{ canonical: "gpt-5.6-luna", aliases: ["gpt-5.6-luna", "luna"], efforts: ["high"] }] },
      agy: { available: true, models: [{ canonical: "gemini-3.6-flash-high", aliases: ["gemini-3.6-flash-high"], efforts: [] }] },
      claude: { available: true, models: [{ canonical: "claude-opus-5", aliases: ["opus", "Opus 5"], efforts: ["high"], family: "opus", latestAlias: "opus" }] },
    },
  };
  writeFileSync(cachePath, JSON.stringify(seed));
  let calls = 0;
  assert.equal(resolveVendorForModel("opus", { env: { CODEX_HOME: home }, cachePath, now: () => now + 1, spawnSync: () => { calls += 1; throw new Error("must not run"); } }), "claude");
  assert.equal(calls, 0, "a fresh hit makes zero provider process calls");

  const refresh = (command) => {
    calls += 1;
    if (command === "agy") return { status: 0, stdout: "gemini-3.6-flash-high\n", stderr: "" };
    return { status: 0, stdout: claudeCatalogOutput([{ value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus 5" }, { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable 5" }]), stderr: "" };
  };
  assert.equal(resolveVendorForModel("fable", { env: { CODEX_HOME: home }, cachePath, now: () => now + 2, spawnSync: refresh }), "claude");
  assert.equal(calls, 2, "a fresh miss performs one AGY and one Claude metadata refresh");

  const staleTime = now + (25 * 60 * 60 * 1000);
  const failed = () => { calls += 1; return { status: 1, stdout: "", stderr: "offline" }; };
  assert.equal(resolveVendorForModel("opus", { env: { CODEX_HOME: home }, cachePath, now: () => staleTime, spawnSync: failed }), "claude");
  assert.equal(calls, 4, "a stale refresh attempts metadata once per process-backed provider");
  assert.equal(resolveVendorForModel("opus", { env: { CODEX_HOME: home }, cachePath, now: () => staleTime + (4 * 60 * 1000), spawnSync: failed }), "claude");
  assert.equal(calls, 4, "a degraded last-known-good cache suppresses retries for five minutes");
  assert.equal(resolveVendorForModel("opus", { env: { CODEX_HOME: home }, cachePath, now: () => staleTime + (6 * 60 * 1000), spawnSync: failed }), "claude");
  assert.equal(calls, 6, "a degraded cache retries provider metadata after five minutes");
  assert.throws(
    () => resolveVendorForModel("opus", { env: { CODEX_HOME: join(root, "different-missing-codex-home") }, cachePath, now: () => staleTime + (7 * 60 * 1000), spawnSync: failed }),
    /model catalog unavailable.*codex/,
    "unified cache must not leak Codex models across CODEX_HOME values",
  );
});

test("an incompatible fresh Claude cache refreshes, while a known provider outage stays negatively cached", () => {
  const home = modelCache(["gpt-5.6-luna"]);
  const cachePath = join(makeTempDir("second-opinion-cache-migration-"), "catalog.json");
  const now = 2_100_000_000_000;
  const vendors = {
    codex: { available: true, models: [{ canonical: "gpt-5.6-luna", aliases: ["luna"], efforts: ["high"] }] },
    agy: { available: true, models: [{ canonical: "gemini-3.6-flash-high", aliases: ["gemini-3.6-flash-high"], efforts: [] }] },
    claude: { available: true, models: [{ canonical: "claude-opus-5", aliases: ["opus"], efforts: ["high"], family: "opus" }] },
  };
  writeFileSync(cachePath, JSON.stringify({ schemaVersion: 1, checkedAt: now, degraded: false, vendors }));
  let calls = 0;
  const refresh = (command) => {
    calls += 1;
    return command === "agy"
      ? { status: 0, stdout: "gemini-3.6-flash-high\n", stderr: "" }
      : { status: 0, stdout: claudeCatalogOutput(), stderr: "" };
  };
  assert.deepEqual(resolveModelRoute("opus", { env: { CODEX_HOME: home }, cachePath, now: () => now + 1, spawnSync: refresh }), { vendor: "claude", model: "opus" });
  assert.equal(calls, 2, "missing alias provenance invalidates an otherwise fresh development cache");

  const unavailable = JSON.parse(readFileSync(cachePath, "utf8"));
  unavailable.checkedAt = now + 2;
  unavailable.degraded = true;
  unavailable.vendors.agy = { available: false, models: [] };
  writeFileSync(cachePath, JSON.stringify(unavailable));
  calls = 0;
  assert.throws(
    () => resolveVendorForModel("opus", { env: { CODEX_HOME: home }, cachePath, now: () => now + 3, spawnSync: () => { calls += 1; throw new Error("must stay cached"); } }),
    /model catalog unavailable.*agy/,
  );
  assert.equal(calls, 0, "a known outage is cached for the five-minute degraded TTL");
});

test("Codex accepts current max/ultra efforts and UI effort labels normalize to CLI values", () => {
  for (const [provided, expected] of [["light", "low"], ["very-high", "xhigh"], ["maximum", "max"], ["ultra", "ultra"]]) {
    const parsed = parseCli(["--vendor", "codex", "--operation", "text", "--brief", brief, "--model", "gpt-5.6-sol", "--effort", provided], root);
    assert.equal(parsed.effort, expected);
  }
  assert.match(usageText(), /cached for 24h.*model-catalog-v1\.json/s);
  assert.match(usageText(), /fresh-cache miss refreshes once/);

  const catalogs = {
    codex: [{ slug: "gpt-future", supported_reasoning_levels: [{ effort: "low" }] }],
    agy: ["gemini-3.6-flash-high"],
    claude: [{ value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus 5", supportedEffortLevels: ["high"] }],
  };
  assert.throws(
    () => parseCli(["--operation", "text", "--brief", brief, "--model", "gpt-future", "--effort", "ultra"], root, { modelCatalogs: catalogs }),
    /codex accepts low/,
    "automatic routing should honor model-specific catalog effort levels",
  );
});

test("automatic routing validates the canonical catalog model before building vendor argv", () => {
  const catalogs = {
    codex: [{ canonical: "-unsafe", aliases: ["safe-name"], efforts: [] }],
    agy: ["gemini-3.6-flash-high"],
    claude: ["opus"],
  };
  assert.throws(
    () => parseCli(["--operation", "text", "--brief", brief, "--model", "safe-name"], root, { modelCatalogs: catalogs }),
    /--model must be non-empty/,
  );
});

test("Codex CLI dry-run separates requested shorthand from the normalized executable model", async () => {
  const home = modelCache(["gpt-5.6-luna", "gpt-5.6-sol"]);
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const status = await executeCli(
    ["--vendor", "codex", "--operation", "text", "--mode", "review", "--brief", brief, "--cwd", root, "--model", "luna@high", "--dry-run"],
    { cwd: root, stdout: stdout.stream, stderr: stderr.stream, env: { CODEX_HOME: home } },
  );
  assert.equal(status, 0, stderr.value());
  const value = JSON.parse(stdout.value());
  assert.equal(value.modelRequested, "luna@high");
  assert.equal(value.model, "gpt-5.6-luna");
  assert.deepEqual(value.argv, ["exec", "review", "--skip-git-repo-check", "-m", "gpt-5.6-luna", "-c", "model_reasoning_effort=\"high\"", "-"]);

  const explicit = parseCli(
    ["--vendor", "codex", "--operation", "text", "--brief", brief, "--model", "luna@high", "--effort", "xhigh"],
    root,
  );
  assert.equal(explicit.modelRequested, "luna@high");
  assert.equal(explicit.model, "luna@high");
  assert.equal(explicit.effort, "xhigh");
});

test("seven CLI dry-runs match literal fixtures and use bare executable names", async () => {
  for (const fixture of FIXTURES) {
    const args = ["--vendor", fixture.vendor, "--operation", fixture.operation, "--brief", brief, "--cwd", fixture.cwd, "--model", fixture.model, "--dry-run"];
    if (fixture.effort) args.push("--effort", fixture.effort);
    if (fixture.timeout) args.push("--timeout", String(fixture.timeout));
    if (fixture.vendor === "claude") args.push("--out", join(root, "claude-dry.out"), "--err", join(root, "claude-dry.err"));
    for (const input of fixture.inputs) args.push("--input", input);
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const status = await executeCli(args, { cwd: root, stdout: stdout.stream, stderr: stderr.stream });
    assert.equal(status, 0, stderr.value());
    const value = JSON.parse(stdout.value());
    assert.equal(value.executable, fixture.vendor);
    assert.equal(value.inputProfile, "none");
    assert.deepEqual(value.argv, fixture.argv);
  }
});

test("explicit mode CLI dry-runs expose requested and effective modes", async () => {
  for (const fixture of MODE_FIXTURES) {
    const args = [
      "--vendor", fixture.vendor,
      "--operation", fixture.operation,
      "--mode", fixture.mode,
      "--brief", brief,
      "--cwd", fixture.cwd,
      "--model", fixture.model,
      "--dry-run",
    ];
    if (fixture.effort) args.push("--effort", fixture.effort);
    if (fixture.timeout) args.push("--timeout", String(fixture.timeout));
    if (fixture.vendor === "claude") args.push("--out", join(root, `claude-${fixture.mode}.out`), "--err", join(root, `claude-${fixture.mode}.err`));
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const status = await executeCli(args, { cwd: root, stdout: stdout.stream, stderr: stderr.stream });
    assert.equal(status, 0, stderr.value());
    const value = JSON.parse(stdout.value());
    assert.equal(value.requestedMode, fixture.mode);
    assert.equal(value.effectiveMode, fixture.effectiveMode);
    assert.equal(value.inputProfile, fixture.inputProfile);
    assert.deepEqual(value.argv, fixture.argv);
  }
});

// A caller that guesses a flag wrong should recover from the error itself, not
// by reading this source. Measured: a caller passed agy's native --add-dir,
// got a bare "unknown argument", and went reading SINGLE_OPTIONS to find --cwd.
test("help is served without arguments, on --help, and inside the unknown-argument error", async () => {
  const listed = [
    "codex", "agy", "claude", "antigravity", "--cwd", "--brief", "--dry-run",
    "installed_plugins.json", "available-skills catalog", "Do not flatten", "not proof of absence",
  ];

  for (const args of [[], ["--help"], ["-h"]]) {
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const status = await executeCli(args, { cwd: root, stdout: stdout.stream, stderr: stderr.stream });
    assert.equal(status, 0, `${JSON.stringify(args)} must succeed: ${stderr.value()}`);
    for (const token of listed) assert.ok(stdout.value().includes(token), `${JSON.stringify(args)} usage missing ${token}`);
    assert.doesNotMatch(stdout.value(), /resolving its current\s+version rather than a fixed one/);
  }

  // A help token sitting in a VALUE position is not a help request. Scanning the
  // whole argv made `--model help` print usage and exit 0 without ever calling
  // the vendor — a silent skip. Caught in review before release; keep it caught.
  // A plain "help" is a legal model string, so the call must actually dispatch.
  const dispatched = memoryWriter();
  const dispatchStatus = await executeCli(
    ["--vendor", "agy", "--operation", "text", "--brief", brief, "--cwd", root, "--model", "help", "--dry-run"],
    { cwd: root, stdout: dispatched.stream, stderr: memoryWriter().stream },
  );
  assert.equal(dispatchStatus, 0, "--model help should dispatch, not print help");
  const emitted = JSON.parse(dispatched.value());
  assert.equal(emitted.vendor, "agy");
  assert.ok(emitted.argv.includes("help"), "--model help must reach the vendor argv");

  // "-h"/"--help" as a value stay rejected by the existing model validation
  // (leading "-" is unsafe). The point here is the failure mode: they must be
  // refused, never answered with usage on stdout.
  for (const value of ["-h", "--help"]) {
    const stdout = memoryWriter();
    const status = await executeCli(
      ["--vendor", "agy", "--operation", "text", "--brief", brief, "--cwd", root, "--model", value, "--dry-run"],
      { cwd: root, stdout: stdout.stream, stderr: memoryWriter().stream },
    );
    assert.equal(status, 2, `--model ${value} should be rejected by validation`);
    assert.equal(stdout.value(), "", `--model ${value} must not emit usage to stdout`);
  }

  // The invariant is "any option's value position", not just --model. --out has
  // no leading-dash rule, so "-h" there is a legal path and the call must run.
  const outValue = memoryWriter();
  const outStatus = await executeCli(
    ["--vendor", "agy", "--operation", "text", "--brief", brief, "--cwd", root, "--out", "-h", "--dry-run"],
    { cwd: root, stdout: outValue.stream, stderr: memoryWriter().stream },
  );
  assert.equal(outStatus, 0, "--out -h should dispatch, not print help");
  assert.equal(JSON.parse(outValue.value()).vendor, "agy", "--out -h produced usage instead of a dry-run");

  // Unknown flag: still exit 2, but the message carries the same usage text.
  const stderr = memoryWriter();
  const status = await executeCli(
    ["--vendor", "agy", "--operation", "text", "--brief", brief, "--add-dir", root],
    { cwd: root, stderr: stderr.stream },
  );
  assert.equal(status, 2);
  assert.ok(stderr.value().includes("unknown argument: --add-dir"));
  for (const token of listed) assert.ok(stderr.value().includes(token), `error usage missing ${token}`);
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
    ["--vendor", "agy", "--operation", "text", "--brief", brief, "--expect-output", "TOKEN"],
    ["--vendor", "agy", "--operation", "text", "--brief", brief, "--out", join(root, "expect.out"), "--expect-output", "bad token"],
    ["--vendor", "claude", "--operation", "text", "--brief", brief, "--effort", "high", "--out", join(root, "c.out"), "--err", join(root, "c.err")],
    ["--vendor", "claude", "--operation", "text", "--brief", brief, "--model", "opus", "--out", join(root, "c.out"), "--err", join(root, "c.err")],
    ["--vendor", "claude", "--operation", "text", "--brief", brief, "--model", "opus", "--effort", "high", "--err", join(root, "c.err")],
    ["--vendor", "claude", "--operation", "text", "--brief", brief, "--model", "opus", "--effort", "high", "--out", join(root, "c.out")],
    ["--vendor", "claude", "--operation", "image-generate", "--brief", brief, "--model", "opus", "--effort", "high", "--out", join(root, "c.out"), "--err", join(root, "c.err")],
    ["--vendor", "agy", "--operation", "text", "--mode", "default", "--brief", brief],
    ["--vendor", "agy", "--operation", "text", "--mode", "unsafe", "--brief", brief],
    ["--vendor", "agy", "--operation", "text", "--mode", "review", "--mode", "plan", "--brief", brief],
    ["--vendor", "agy", "--operation", "image-analyze", "--mode", "review", "--brief", brief, "--input", input1],
    ["--vendor", "codex", "--operation", "text", "--mode", "plan", "--brief", brief],
  ];
  for (const args of cases) {
    const stderr = memoryWriter();
    const status = await executeCli(args, { cwd: root, stderr: stderr.stream });
    assert.equal(status, 2, `${JSON.stringify(args)}\n${stderr.value()}`);
  }
});

function claudeResult({
  model = "claude-opus-4-8[1m]",
  result = "P0/P1: NONE",
  isError = false,
  auxiliaryModel = null,
  auxiliaryOutputTokens = 0,
  omitOptionalUsage = false,
  omitContextWindow = false,
} = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: isError,
    result,
    session_id: "12345678-1234-1234-1234-123456789abc",
    duration_ms: 1234,
    duration_api_ms: 1200,
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 2,
      ...(!omitOptionalUsage ? { cache_creation_input_tokens: 100, cache_read_input_tokens: 30 } : {}),
      output_tokens: 40,
    },
    modelUsage: {
      [model]: {
        inputTokens: 2,
        outputTokens: 40,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 100,
        costUSD: 0.25,
        ...(!omitContextWindow ? { contextWindow: 1000000 } : {}),
      },
      ...(auxiliaryModel ? {
        [auxiliaryModel]: {
          inputTokens: 0,
          outputTokens: auxiliaryOutputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
          contextWindow: 200000,
        },
      } : {}),
    },
  });
}

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

test("direct Claude run requires model, effort, and evidence paths before spawn", async () => {
  const complete = {
    ...FIXTURES.at(-1),
    brief,
    cwd: root,
    out: join(root, "direct-claude.out"),
    err: join(root, "direct-claude.err"),
    timeout: 2,
    dryRun: false,
  };
  for (const missing of ["model", "effort", "out", "err"]) {
    let spawned = false;
    const stderr = memoryWriter();
    const options = { ...complete };
    delete options[missing];
    const code = await run(options, {
      spawn: () => { spawned = true; throw new Error("must not spawn"); },
      stderr: stderr.stream,
      env: {},
    });
    assert.equal(code, 2, missing);
    assert.equal(spawned, false, missing);
    assert.match(stderr.value(), /requires model, effort, out, and err/, missing);
  }
});

test("Claude host signal does not change broker execution or receipt", async () => {
  const receipt = join(root, "claude-host-signal.jsonl");
  const out = join(root, "claude-host-signal.out");
  const err = join(root, "claude-host-signal.err");
  let spawned = false;
  let childEnv;
  const spawnFake = (_executable, _argv, spawnOptions) => {
    spawned = true;
    childEnv = spawnOptions.env;
    return fakeChild((child) => {
      child.stdin.on("end", () => {
        child.stdout.end(claudeResult({ auxiliaryModel: "claude-haiku-4-5" }));
        child.stderr.end();
        queueMicrotask(() => child.emit("close", 0, null));
      });
      child.stdin.resume();
    });
  };
  const fixture = {
    ...FIXTURES.at(-1),
    brief,
    cwd: root,
    out,
    err,
    timeout: 2,
    dryRun: false,
  };
  const code = await run(fixture, {
    spawn: spawnFake,
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: receipt, CLAUDECODE: "1" },
  });
  assert.equal(code, 0);
  assert.equal(spawned, true);
  assert.equal(Object.keys(childEnv).some((key) => key.toUpperCase() === "CLAUDECODE"), false);
  assert.equal(Object.keys(childEnv).some((key) => key.toUpperCase() === "SECOND_OPINION_RECEIPT"), false);
  const [row] = receiptLines(receipt);
  assert.equal(row.vendor, "claude");
  assert.equal(row.invoked, true);
  assert.equal(row.exit, 0);
});

test("Claude result binds the observed model and usage into the existing receipt", async () => {
  const receipt = join(root, "claude-valid.jsonl");
  const out = join(root, "claude-valid.out");
  const err = join(root, "claude-valid.err");
  const spawnFake = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end(claudeResult({ auxiliaryModel: "claude-haiku-4-5" }));
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  let code;
  await withReceipt(receipt, async () => {
    code = await run({ ...FIXTURES.at(-1), brief, cwd: root, out, err, expectOutput: "NONE", timeout: 2, dryRun: false }, {
      spawn: spawnFake, stderr: memoryWriter().stream, env: { SECOND_OPINION_RECEIPT: receipt },
    });
  });
  assert.equal(code, 0);
  const [row] = receiptLines(receipt);
  assert.equal(row.exit, 0);
  assert.equal(row.outputCheckStatus, "matched");
  assert.equal(row.vendorUsageStatus, "ok");
  assert.deepEqual(row.vendorUsage, {
    source: "claude-result-json",
    actualModels: ["claude-opus-4-8", "claude-haiku-4-5"],
    inputTokens: 2,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 30,
    outputTokens: 40,
    totalCostUsd: 0.25,
    contextWindow: 1000000,
  });
});

test("Claude model binding accepts a lower-output safe-mode classifier but rejects an unexpected dominant model", async () => {
  const validReceipt = join(root, "claude-safe-mode-classifier-valid.jsonl");
  const invalidReceipt = join(root, "claude-safe-mode-classifier-invalid.jsonl");
  const validOut = join(root, "claude-safe-mode-classifier-valid.out");
  const invalidOut = join(root, "claude-safe-mode-classifier-invalid.out");
  const validErr = join(root, "claude-safe-mode-classifier-valid.err");
  const invalidErr = join(root, "claude-safe-mode-classifier-invalid.err");
  const spawnResult = (result) => () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end(result);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  const base = {
    vendor: "claude", operation: "text", brief, cwd: root, model: "opus", effort: "high",
    timeout: 2, killGraceMs: 10, reapGraceMs: 10,
  };
  const valid = await run({ ...base, out: validOut, err: validErr }, {
    spawn: spawnResult(claudeResult({ auxiliaryModel: "claude-haiku-4-5", auxiliaryOutputTokens: 18 })),
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: validReceipt },
  });
  assert.equal(valid, 0);
  assert.equal(receiptLines(validReceipt).at(-1).vendorUsageStatus, "ok");

  const invalid = await run({ ...base, out: invalidOut, err: invalidErr }, {
    spawn: spawnResult(claudeResult({
      model: "claude-opus-4-8",
      auxiliaryModel: "claude-haiku-4-5",
      auxiliaryOutputTokens: 80,
    })),
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: invalidReceipt },
  });
  assert.equal(invalid, 4);
  assert.equal(receiptLines(invalidReceipt).at(-1).vendorUsageStatus, "model-mismatch");
});

test("Claude model binding accepts future aliases without a hardcoded family list", async () => {
  const receipt = join(root, "claude-fable-alias.jsonl");
  const out = join(root, "claude-fable-alias.out");
  const err = join(root, "claude-fable-alias.err");
  const spawnFake = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end(claudeResult({ model: "claude-fable-5" }));
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  const status = await run({
    vendor: "claude", operation: "text", brief, cwd: root, model: "fable", effort: "high",
    out, err, timeout: 2, killGraceMs: 10, reapGraceMs: 10,
  }, {
    spawn: spawnFake,
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: receipt },
  });
  assert.equal(status, 0);
  assert.equal(receiptLines(receipt).at(-1).vendorUsageStatus, "ok");
});

test("Claude canonical model binding accepts a provider date suffix", async () => {
  const receipt = join(root, "claude-canonical-date-suffix.jsonl");
  const out = join(root, "claude-canonical-date-suffix.out");
  const err = join(root, "claude-canonical-date-suffix.err");
  const spawnFake = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end(claudeResult({ model: "claude-opus-4-8-20260401" }));
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  const status = await run({
    vendor: "claude", operation: "text", brief, cwd: root, model: "claude-opus-4-8", effort: "high",
    out, err, timeout: 2, killGraceMs: 10, reapGraceMs: 10,
  }, {
    spawn: spawnFake,
    stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: receipt },
  });
  assert.equal(status, 0);
  assert.equal(receiptLines(receipt).at(-1).vendorUsageStatus, "ok");
});

test("Claude receipt tolerates absent optional cache and context fields without weakening model binding", async () => {
  const receipt = join(root, "claude-optional-usage.jsonl");
  const out = join(root, "claude-optional-usage.out");
  const err = join(root, "claude-optional-usage.err");
  const spawnFake = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end(claudeResult({
        model: "\u001b[1mclaude-opus-4-8[0m]",
        omitOptionalUsage: true,
        omitContextWindow: true,
      }));
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  let code;
  await withReceipt(receipt, async () => {
    code = await run({ ...FIXTURES.at(-1), brief, cwd: root, out, err, timeout: 2, dryRun: false }, {
      spawn: spawnFake, stderr: memoryWriter().stream, env: { SECOND_OPINION_RECEIPT: receipt },
    });
  });
  assert.equal(code, 0);
  const [row] = receiptLines(receipt);
  assert.deepEqual(row.vendorUsage.actualModels, ["claude-opus-4-8"]);
  assert.equal(row.vendorUsage.cacheCreationInputTokens, 0);
  assert.equal(row.vendorUsage.cacheReadInputTokens, 0);
  assert.equal(row.vendorUsage.contextWindow, null);
});

test("Claude empty, invalid, errored, or wrong-model output fails closed with raw output preserved", async () => {
  const cases = [
    ["empty", ""],
    ["invalid-json", "not json"],
    ["empty-result", claudeResult({ result: "" })],
    ["vendor-error", claudeResult({ isError: true })],
    ["wrong-model", claudeResult({ model: "claude-sonnet-5" })],
  ];
  for (const [name, raw] of cases) {
    const receipt = join(root, `claude-${name}.jsonl`);
    const out = join(root, `claude-${name}.out`);
    const err = join(root, `claude-${name}.err`);
    const parent = memoryWriter();
    const spawnFake = () => fakeChild((child) => {
      child.stdin.on("end", () => {
        child.stdout.end(raw);
        child.stderr.end();
        queueMicrotask(() => child.emit("close", 0, null));
      });
      child.stdin.resume();
    });
    let code;
    await withReceipt(receipt, async () => {
      code = await run({ ...FIXTURES.at(-1), brief, cwd: root, out, err, timeout: 2, dryRun: false }, {
        spawn: spawnFake, stderr: parent.stream, env: { SECOND_OPINION_RECEIPT: receipt },
      });
    });
    assert.equal(code, 4, name);
    await new Promise((done) => setTimeout(done, 10));
    assert.equal(readFileSync(out, "utf8"), raw, name);
    assert.match(parent.value(), /Claude output validation failed/, name);
    assert.equal(receiptLines(receipt)[0].exit, 4, name);
    assert.notEqual(receiptLines(receipt)[0].vendorUsageStatus, "ok", name);
  }
});

test("explicit mode empty output fails closed without changing default empty-output compatibility", async () => {
  const cases = [
    ["review", 4, /explicit mode returned empty output/],
    ["default", 0, null],
  ];
  for (const [mode, expectedCode, expectedError] of cases) {
    const receipt = join(root, `agy-${mode}-empty.jsonl`);
    const out = join(root, `agy-${mode}-empty.out`);
    const err = join(root, `agy-${mode}-empty.err`);
    const parent = memoryWriter();
    const spawnFake = () => fakeChild((child) => {
      child.stdin.on("end", () => {
        child.stdout.end();
        child.stderr.end();
        queueMicrotask(() => child.emit("close", 0, null));
      });
      child.stdin.resume();
    });
    const code = await run({
      ...FIXTURES[3],
      mode,
      brief,
      cwd: root,
      out,
      err,
      timeout: 2,
      dryRun: false,
    }, {
      spawn: spawnFake,
      stderr: parent.stream,
      env: { SECOND_OPINION_RECEIPT: receipt },
    });
    assert.equal(code, expectedCode, mode);
    assert.equal(receiptLines(receipt)[0].exit, expectedCode, mode);
    assert.equal(receiptLines(receipt)[0].inputProfile, mode === "default" ? "none" : AGY_NATIVE_READONLY_PROFILE, mode);
    if (expectedError) assert.match(parent.value(), expectedError, mode);
    else assert.equal(parent.value().includes("explicit mode returned empty output"), false, mode);
  }
});

test("run sends the AGY native-readonly profile plus the unmodified original brief in explicit review mode", async () => {
  let stdin = Buffer.alloc(0);
  const spawnFake = () => fakeChild((child) => {
    const chunks = [];
    child.stdin.on("data", (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    child.stdin.on("end", () => {
      stdin = Buffer.concat(chunks);
      child.stdout.end("READY\n");
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
  });
  const code = await run({
    ...MODE_FIXTURES[1],
    brief,
    cwd: root,
    timeout: 2,
    dryRun: false,
  }, {
    spawn: spawnFake,
    stdout: memoryWriter().stream,
    stderr: memoryWriter().stream,
  });
  assert.equal(code, 0);
  const original = readFileSync(brief);
  assert.match(stdin.toString("utf8"), /agy-native-readonly\/v1/);
  const offset = stdin.indexOf(original);
  assert.notEqual(offset, -1);
  assert.deepEqual(stdin.subarray(offset, offset + original.length), original);
});

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
    assert.deepEqual(Object.keys(row).sort(), ["cwd", "durationSec", "effectiveMode", "effort", "errPath", "exit", "inputProfile", "invoked", "model", "modelRequested", "operation", "outPath", "outputCheckStatus", "pid", "requestedMode", "schemaVersion", "ts", "vendor", "vendorUsage", "vendorUsageStatus"].sort());
    assert.equal(row.schemaVersion, 1);
    assert.equal(row.vendor, "codex");
    assert.equal(row.operation, "text");
    assert.equal(row.requestedMode, "default");
    assert.equal(row.effectiveMode, "default");
    assert.equal(row.inputProfile, "none");
    assert.equal(row.modelRequested, FIXTURES[0].model);
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
    assert.equal(row.outputCheckStatus, "not-requested");
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
  assert.equal(row.modelRequested, null);
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
  const result = spawnSync(process.execPath, [join(scriptsDirectory, "dispatch.mjs"), "--vendor", "codex", "--operation", "text", "--brief", brief], {
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

test("--expect-output matches across chunks and fails closed without changing raw output", async () => {
  const token = "TOKEN_0123456789abcdef";
  const matchedOut = join(root, "expect-matched.out");
  const missingOut = join(root, "expect-missing.out");
  const matchedReceipt = join(root, "expect-output-matched.jsonl");
  const missingReceipt = join(root, "expect-output-missing.jsonl");
  const seen = [];
  const matchedSpawn = (_executable, argv) => {
    seen.push(argv);
    return fakeChild((child) => {
      child.stdin.on("data", (chunk) => seen.push(chunk.toString()));
      child.stdin.on("end", () => {
        child.stdout.write("prefix TOKEN_0123");
        child.stdout.end("456789abcdef suffix");
        queueMicrotask(() => child.emit("close", 0, null));
      });
    });
  };
  const missingSpawn = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end("raw vendor output without challenge\n");
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  assert.equal(await run({ ...FIXTURES[3], brief, cwd: root, timeout: 2, out: matchedOut, expectOutput: token, dryRun: false }, {
    spawn: matchedSpawn, stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: matchedReceipt },
  }), 0);
  assert.equal(await run({ ...FIXTURES[3], brief, cwd: root, timeout: 2, out: missingOut, expectOutput: token, dryRun: false }, {
    spawn: missingSpawn, stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: missingReceipt },
  }), 4);
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual([
    ...receiptLines(matchedReceipt),
    ...receiptLines(missingReceipt),
  ].map((row) => [row.exit, row.outputCheckStatus]), [[0, "matched"], [4, "missing"]]);
  assert.equal(readFileSync(missingOut, "utf8"), "raw vendor output without challenge\n");
  assert.equal(JSON.stringify(seen).includes(token), false);
  assert.equal(readFileSync(matchedReceipt, "utf8").includes(token), false);
  assert.equal(readFileSync(missingReceipt, "utf8").includes(token), false);

  const planWorkflowOut = join(root, "claude-plan-workflow.out");
  const planWorkflowErr = join(root, "claude-plan-workflow.err");
  const planWorkflowReceipt = join(root, "claude-plan-workflow.jsonl");
  const planWorkflowSpawn = () => fakeChild((child) => {
    child.stdin.on("end", () => {
      child.stdout.end(claudeResult({ result: "Plan workflow is ready; use ExitPlanMode to continue." }));
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
    child.stdin.resume();
  });
  assert.equal(await run({ ...MODE_FIXTURES[2], brief, cwd: root, out: planWorkflowOut, err: planWorkflowErr, expectOutput: token, timeout: 2, dryRun: false }, {
    spawn: planWorkflowSpawn, stderr: memoryWriter().stream,
    env: { SECOND_OPINION_RECEIPT: planWorkflowReceipt },
  }), 4);
  assert.equal(readFileSync(planWorkflowOut, "utf8").includes("ExitPlanMode"), true);
  assert.deepEqual(receiptLines(planWorkflowReceipt).map((row) => [row.requestedMode, row.effectiveMode, row.exit, row.outputCheckStatus]), [["plan", "plan", 4, "missing"]]);
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
  assert.equal(relative(row.outPath, out), "");
  assert.equal(relative(row.errPath, err), "");
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
