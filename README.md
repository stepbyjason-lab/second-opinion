# second-opinion

**English** | [한국어](./README.ko.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green) ![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-blue) ![Version](https://img.shields.io/badge/version-0.9.12-informational)

**Use other AI vendors from inside Claude Code — in plain language.**
Second opinions, task offloading, and vendor capabilities like image generation.
Subscription vendors: Codex, Antigravity, Claude, and Grok (SuperGrok OAuth).

> "Have Codex review this auth logic."
> "Ask Gemini to poke holes in this plan."
> "Have Codex generate an image of the logo concept."
> "I'm low on Claude quota — offload this translation to Gemini."

No slash commands to memorize. No context switching. You say it, Claude routes it.

Three ways people use it:

1. **Opinions** — cross-vendor reviews that break through shared blind spots (the flagship use, and the origin of the name)
2. **Capacity** — offload work to a vendor's quota when you choose to (the skill never decides this for you)
3. **Capabilities** — vendor-specific features; image generation is field-verified on both vendors

## Why cross-vendor?

Stack ten reviewers from the same vendor and they still share the same blind spots.
A model reviewing its own vendor's output systematically under-reports defects.
Switching vendors is a different *axis* of verification than adding more lenses —
and this skill opens that axis with one sentence.

This isn't theory. In the multi-round review methodology project this skill was
extracted from:

- A defect that **five parallel Claude review lenses all missed** was caught by an
  external-vendor review.
- A Gemini breadth review caught **real P0-class defects two rounds in a row**
  (an allowlist bypass, a slot-contamination latch).

## What you get

### Unified generation API

Consumer projects can call `dispatch.mjs --request-json <file> --response-json <file>`.
That request keeps `system` and `user` in separate JSON fields and names only the
requested provider/model. The dispatcher never changes provider: it applies bounded
same-provider retries only (`max_retries` defaults to 5, range 0–16), with 2-second
exponential backoff capped at 60 seconds and full jitter. Without `Retry-After`, each
wait is sampled from zero through the planned backoff; with it, the scheduling value
(capped at 3600 seconds) is the lower bound and the upper bound is the larger of the
plan and that lower bound. The received header string is still recorded unchanged.
`silence_timeout_seconds` is the payload-silence threshold (default 600, range 1–3600).
Transport heartbeats, SSE comments, empty `data:` fields, and whitespace do not reset it;
any other non-empty payload does. Legacy `connect_timeout_seconds` and
`read_timeout_seconds` remain accepted as silence-threshold aliases, with the larger
value used when both are present. An explicit `silence_timeout_seconds` takes precedence.
`timeout_seconds` is optional: when supplied it is the caller's total elapsed-time
deadline, and when omitted there is no caller total-time cap. The dispatcher retains a
60-minute (3600-second) cost backstop, excluding retry sleeps from that cost clock.
Only successfully parsed JSON/SSE whose text exists as a string but is empty is a
transient vendor failure and is retried. Missing or non-string text (including
`content: null`) and malformed JSON/SSE remain permanent invalid responses.
Cross-provider routing and budgets belong to the caller; a request containing `budget`
is rejected. Every API attempt receives the unchanged `max_completion_tokens` value.
The response reports the requested `provider`/`model`, `model_reported`, normalized
`usage`, raw provider stop signals, and `attempts`; there is no `fallback_chain`.
HTTP responses may succeed with `usage: null` when their reported model supplies
attribution; subscription adapters still fail closed when usage is their only
attribution channel. An HTTP-reported model must exactly match the request.
Streaming publishes only the accepted attempt and caps accepted pre-publication content
at 16 MiB (with the existing 8 MiB incomplete-frame and 64 MiB total-stream guards).
Provider base overrides must stay on the provider's trusted HTTPS origin and redirects
are rejected. The response target is atomically replaced and cannot alias the request,
provider env file, or either receipt sink. Both HTTP and subscription generation write
configured raw and closed-portable receipts. HTTP failure responses and raw receipts
record `retryAfter` as `{ observed, value }`: `value` preserves the received
`Retry-After` string, `null` with `observed: true` means the header was absent, and
`observed: false` means no response headers were observed.

Consumers that froze the 0.9.8 failure vocabulary as a constant must update that
integration. `no-output-timeout` is unchanged, but payload-silence failures now report
`failureActor: "vendor"`; only an explicit caller deadline reports `"caller"`, while the
3600-second cost backstop reports `"dispatcher"`. Retry waits are also intentionally
different from call to call.

A very low `max_completion_tokens` can leave no text and exhaust same-provider retries
(observed with Zhipu at 16 tokens). On `gemini-2.5-flash`, thinking tokens consumed the
16-token completion budget before visible text was produced. A subscription empty-output retry launches the CLI again, for up to
`1 + max_retries` processes (six with the default), so lower `max_retries` when repeated
CLI launches are not worth that diagnostic cost.

- **Natural-language triggers** — "review this with Codex", "ask Gemini",
  "get a second opinion", "cross-check this with another AI". Korean triggers work too.
- **Automatic vendor routing** when you don't name one:

| Task | Routed to | Why |
|---|---|---|
| Code review, technical audit, "find what I missed" | **Codex** (GPT) | strongest at thorough audits |
| Fast multi-angle checks, document review, high-volume calls | **Antigravity** (Gemini) | cheap, parallelizable |
| Decisions that really matter | **both in parallel**, then compared | cross-confirmation |

- **Field-tested gotchas, built in.** Every row below was hit in real usage. The
  skill routes around them so you don't have to:

| Gotcha (all observed in the field) | How the skill handles it |
|---|---|
| `agy -p "<text>"` **hangs forever** if stdin isn't closed, and argv caps the brief at **30,000 chars** | feeds the brief via stdin (`-p - < brief.txt`) — no hang, 105KB verified |
| `--model` accepts both the display label (`"Gemini 3.1 Pro (High)"`) and the canonical slug from `agy models` (`gemini-3.1-pro-high`); `agy models` prints slugs while the picker shows labels. An unknown/malformed name is **rejected loudly (exit 1)** with an available-models list — not silently downgraded (older agy versions did downgrade) | copies the exact string from either source and checks the exit code |
| AGY can keep using a previous host project even when the subprocess and receipt use a temporary `cwd` | binds every AGY call to the requested workspace with `--add-dir`; callers can add `--expect-output` for a hidden-token read check |
| AGY headless plan auto-denies shell commands, so a review brief asking for `git diff` can return exit 0 with no review | explicit AGY plan/review automatically composes the `agy-native-readonly/v1` input profile, using native read/list/search; empty output still fails closed |
| A caller passes `terra`, `gpt 5.5`, or `5.6 sol@ultra`, but Codex CLI needs its current canonical slug | normalizes case/separators and UI effort labels, then resolves the live Codex cache (`terra` → `gpt-5.6-terra`); the selected model's advertised effort levels are enforced (`low` through `ultra` where supported) |
| The caller knows `opus`, `opus 4.8`, or `fable` but not which vendor owns it | compares cache-first Codex, AGY, and Claude metadata. Bare provider-advertised `opus` stays Claude's latest alias; display-derived `fable` becomes `claude-fable-5`; versioned families come from current metadata rather than a fixed list |
| `opus 4.6` and `sonnet 4.6` exist in both Claude Code and AGY | an exact AGY catalog entry wins over Claude's inferred family/version route; use `Claude Code opus 4.6` (only with omitted `--vendor`) or explicit `--vendor claude --model claude-opus-4-6` to select Claude |
| Provider catalog checks on every call would waste startup and network time | caches model-only metadata for 24 hours at `~/.second-opinion/model-catalog-v1.json`; a fresh miss refreshes once, and refresh failure keeps last-known-good data with a five-minute retry. The already-local Codex cache is re-read for the active `CODEX_HOME` |
| Codex sandbox **can't read files on Windows** | excerpts content into the brief instead of asking it to read files |
| Image generation: agy **ignores where you asked it to save** (uses its own scratch dir), codex needs a **write-enabled sandbox** and its Windows copy step can fail | knows each vendor's real artifact location, verifies the file actually exists, and moves it where you wanted — a vendor saying "saved" is not treated as success |
| "No issues found" is a weak signal (Gemini especially leans false-negative) | always relayed as "didn't find problems ≠ no problems" |
| Grok `--tools` with every name unknown fail-open; Grok also loads Claude/Cursor harness config by default | plan/review use `--permission-mode plan` as a floor and force isolation env: Claude 6 + Cursor 6 + `GROK_CODEX_SESSIONS_ENABLED`. Project-root `CLAUDE.md` can still load |
| Grok review examples that omit reasoning effort silently use the vendor default | the standard review example explicitly uses `--effort medium` for cost/quality balance; dispatch forwards it unchanged and the receipt retains `effortRequested` |
| A Grok/AGY review must inspect the exact current diff in a linked Git worktree | their explicit review modes have no git shell and the worktree `.git` can be a file; put the changed-file list and full unified diff in the brief rather than asking the vendor to discover Git metadata |

- **Execution receipts** — after every vendor call the skill states what was
  actually observed: the vendor and model requested, the real backend if known,
  exit/timeout status, and any rejected substitution. Requesting a model is not
  the same as running it, and a silently-ignored model label shows up here.

  For callers that need this machine-readable, set `SECOND_OPINION_RECEIPT` to a
  file path and each dispatch appends one JSON line — vendor, operation,
  `modelRequested`, normalized `model`,
  effort, exit code, duration, and whether the process actually spawned. Codex
  calls also carry measured token usage read from Codex's own session log
  (input, cached input, output, reasoning, total, context window, quota used).
  Optional `--expect-output <ASCII token, max 1024 chars>` may be repeated up to seven times.
  Every token is checked literally in stdout; any missing token returns exit 4,
  names every missing token on stderr, and preserves the raw output file.
  `outputCheckStatus` remains the aggregate compatibility value. Both receipts
  always include `outputChecks`: ordered `{ token, status }` records for requested
  tokens, or `null` when no output check was requested.
  Because those records retain literal tokens, never place either receipt sink under
  a vendor-readable `--cwd` or reuse it as a later vendor input: a replay could falsely satisfy a check.

  The raw receipt deliberately keeps `cwd`, `outPath`, `errPath`, and `pid` for
  reproduction, so keep it outside every repository. Independently set
  `SECOND_OPINION_PORTABLE_RECEIPT` for a cumulative portable JSONL sink. Its closed
  typed emitter excludes dispatcher-owned locator fields instead of filtering raw
  rows. Free-form vendor vocabulary can still contain sensitive text, so review the
  content before public sharing. Receipt resolution is environment first, then the
  `receipt` and `portableReceipt` keys in `~/.second-opinion/config.json`, then no
  sink. Missing or malformed config is ignored, no default path is invented, and the
  dispatcher does not enforce a drive policy. Resolved paths still pass the existing
  input/output collision guards.

  Every row records `transport` (`cli` or `api`), with `vendor` populated only for CLI
  and `provider` only for API. Raw CLI rows record the measured, credential-redacted
  `argv` and resolved `executable`; API rows use `null` because no process exists.
  Receipts place `modelReported`, `effortRequested`, `truncatedSuspected`, raw stop
  signals, `promptSource`, and measured `promptBytes` beside the existing normalized
  values. `lensId` records the caller's opaque `--lens-id` or
  JSON `lens_id` unchanged and is `null` when omitted. Attempts, actual waits, the
  successful attempt, completion-limit application, and failure class/actor/remedy are
  recorded. The failure vocabulary also distinguishes `oversized-response`,
  `invalid-response`, `attribution-unavailable`, `model-unavailable`, and
  `payload-incompatible`; the existing `usage-unavailable` label remains accepted.

  Each completed dispatch independently attempts one append to every configured
  sink. Receipt I/O is fail-open: portable failure emits a fixed path-free warning
  and neither sink can change the other sink or the dispatch exit. Normalized
  same-target paths, and existing files with equal file identity, are rejected with
  exit 2 before spawn as ordinary misconfiguration protection, not a security
  boundary. The exit set remains `0`, `2`, `3`, `4`, and `124`. `ts` is only a
  timestamp, not a correlation key; there is no cross-file atomicity, equal-count,
  ordering, or row-pairing guarantee, and a dispatch is not promised to write two rows.
  The `--vendor claude` channel uses the same dispatcher without the
  obsolete 280-second shell timeout. The dispatcher uses a 60-minute (3600-second)
  cost backstop by default, not a normal review deadline. Never give a review a
  short `--timeout` such as 300 seconds: reviews can exceed 30 minutes.
  Run long calls in the background, observe job liveness and
  `--err` progress, then accept findings only after a completed output and receipt.
  Claude result JSON binds the observed model
  family, token usage, and cost into `vendorUsage`; empty, malformed, or
  wrong-model output returns exit 4. The Claude child runs in `--safe-mode`, so
  project instructions, hooks, plugins, and MCP servers cannot override the inline
  review brief. `--safe-mode` is configuration isolation, not a filesystem
  sandbox — it coexists with full tool access and stays on in every mode.
  The dispatcher operates as a neutral broker and does not
  hard-block same-vendor calls; it removes the parent-only `CLAUDECODE` marker
  from the child environment so an intentional nested invocation can start.
  Review independence is evaluated by caller methodologies against recorded receipts.
  Off by default; when unset, nothing is written.

  Callers may explicitly add `--mode plan` or `--mode review` to text dispatches.
  These modes keep the same real project cwd; they do not create a sandbox,
  worktree, snapshot, or reduced review packet. For Claude, plan/review identities
  remain distinct in the receipt but both use only the closed `Read,Glob,Grep` tool
  allowlist—without native plan workflow.

  **How much a mode actually restricts depends on the vendor, and for Codex it
  restricts nothing.** Claude removes the write tools through its `--tools`
  allowlist and AGY through native plan plus a read-only input profile, but the
  Codex CLI has no such layer — its only way to narrow permissions is the sandbox
  (`-s read-only`), which this project does not use. Codex's `exec review` selects
  a review workflow, not a permission level (`codex exec review --help` offers only
  target selectors like `--uncommitted` and `--base`). Measured: a `--mode review`
  Codex call still recorded `sandbox: danger-full-access`, which comes from
  `~/.codex/config.toml`, not from the mode. For Codex reviews, the brief's own
  prohibitions are the only thing keeping files untouched — do not count
  `--mode review` as a safety mechanism there.
  Grok plan/review is stronger than Codex: `--permission-mode plan` plus a closed
  `--tools` allowlist. Unknown tool names fail-open, so `plan` is the floor.
  Omitting `--mode` preserves the existing default call, which for Claude is the
  **full-access** one: all built-in tools plus non-interactive execution, in the
  caller's real cwd. Read-only comes only from an explicit `--mode plan|review`;
  the permission split is flags alone, never an isolation primitive.
  Receipts record `requestedMode`, `effectiveMode`, and `inputProfile`. Explicit modes
  fail closed with exit 4 on empty output. AGY explicit plan/review automatically
  applies the `agy-native-readonly/v1` input profile so an ordinary brief that mentions
  `git diff` is handled with native read/list/search instead of a headless shell command.

  Comparing model cost from a **CLI receipt**? Use
  `(inputTokens - cachedInputTokens) + outputTokens`. Do not add
  `reasoningOutputTokens` — it is already part of `outputTokens`. API providers do not
  report cached-input usage (`cachedInputTokens` is absent in raw usage or `null` in the
  portable shape), so do not copy this formula there or cached input may be charged twice.

## Requirements

- **Claude Code** (the host that runs the skill)
- **Codex CLI** — `npm install -g @openai/codex`, then `codex login`
  (ChatGPT account or API key)
- **Antigravity CLI (`agy`)** — Windows PowerShell:
  `irm https://antigravity.google/cli/install.ps1 | iex`
  (macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash` /
  Windows CMD: `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd`),
  then sign in with a Google account.
  **v1.0.15 or later required** — earlier versions silently drop output in
  non-TTY contexts on Windows (fixed upstream).
- **Grok CLI** — Windows PowerShell: `irm https://x.ai/cli/install.ps1 | iex`,
  then `grok login` (SuperGrok OAuth). Text only; image operations are rejected.

Having only one of the two is fine — that vendor works, the other is skipped.
Grok is optional the same way.

### API providers (generation path only) — optional

The CLI vendors above need no keys; each CLI carries its own auth. Keys matter only
for the **API transport** of `--request-json`, which contacts one HTTP provider
directly. Six are supported:

| Provider | Key variable | Default base URL |
|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| NVIDIA NIM | `NVIDIA_NIM_API_KEY` | `https://integrate.api.nvidia.com/v1` |
| Gemini (AI Studio) | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta` |
| Mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` |
| GitHub Models | `GITHUB_MODELS_API_KEY` | `https://models.github.ai/inference` |
| Zhipu (Z.ai / GLM) | `ZHIPU_API_KEY` | `https://api.z.ai/api/paas/v4` |

Each provider also accepts `<PROVIDER>_BASE_URL`. The model always comes from the request
JSON. A base override must stay on that provider's trusted HTTPS origin; anything else
is rejected before the request leaves.

For a one-shot provider diagnostic, prepare a JSON file with
`{ "schema_version": 1, "providers": [{ "provider": "...", "model": "..." }], "env_file": "..." }`
and run `node plugins/second-opinion/scripts/provider-probe.mjs --targets-json <file>`.
It sends one 64-token, zero-retry request per listed provider through the existing
`--request-json` path and prints provider, model, status, duration, and `failureClass`.
It does not cache results or select a replacement model; ordinary configured receipts
are the only durable evidence.

```bash
cp .env.local.sample .env.local   # then fill in only the providers you use
```

**The dispatcher never reads `.env.local` on its own.** You pass the path as
`env_file` inside the request JSON, and it is read at that moment. Key *values* never
appear in argv, receipts, logs, errors, or documentation — adapters declare variable
*names* only. `.env.local` is git-ignored by the shipped `.gitignore`; only the
`.sample` template is tracked.

Fill in only what you need. Naming a provider whose key is absent fails with
`auth-failed`/`user` — the dispatcher does not fall back to another provider, by design.

## Install

### A. As a plugin (recommended)

```
/plugin marketplace add stepbyjason-lab/second-opinion
/plugin install second-opinion@second-opinion
```

### B. CLI (headless / scripted)

```bash
claude -p "/plugin marketplace add stepbyjason-lab/second-opinion"
claude plugin install second-opinion@second-opinion
```

`claude plugin install` doesn't appear in `claude plugin --help`, but it works
(verified on Claude Code for Windows, 2026-07). Useful when you can't open the
interactive `/plugin` dialog.

For non-Claude hosts, use the exact skill path supplied by that host's
available-skills catalog. Join its root alias and relative path literally;
repeated marketplace/plugin names in the cache are normal. Do not flatten the
path or reconstruct a version directory. On Windows PowerShell 5.1, verify the
exact path with `Test-Path -LiteralPath`; an empty
`rg --files ... | rg '...$'` result is not proof that the skill is absent.

### C. Manual copy

```bash
git clone https://github.com/stepbyjason-lab/second-opinion
cp -r second-opinion/plugins/second-opinion/skills/second-opinion ~/.claude/skills/
```

## Usage

In any Claude Code session after install:

```
Have Codex review this auth logic before I ship it.
```
```
Ask Gemini to review the spec I just wrote — focus on logical gaps.
```
```
This architecture decision is a big one. Get opinions from both Codex and
Antigravity, then show me where they disagree.
```
```
Have Grok review this too.
```

For Madi's usual review pass, state the target, required evidence, and no-edit
rule together:

```
Run a Madi review of this change with Codex. Inspect the current worktree, report
numbered P0–P3 findings with file/line evidence, do not edit files, and return
the execution receipt.
```

For an independent second pass, keep the same brief and target, name a different
vendor, and ask to compare the two sets of findings only after both receipts are
available.

For a Grok or Antigravity review of the current diff in a linked Git worktree,
the brief must include the complete changed-file list and unified diff. Their
explicit review modes have no `git diff`; do not ask them to inspect `.git`, the
parent repository, or arbitrary scratch directories to reconstruct the target.

Triggers are natural language, not keywords — any language Claude understands works.

## Data boundary — read this

**Everything placed in the brief is sent, verbatim, to an external vendor
(OpenAI / Google / xAI).** The skill is instructed to keep secrets, credentials, and raw
repo dumps out of the brief, but the final responsibility is yours. On sensitive
codebases, check what's being excerpted before it goes out.

## Honest limitations

- Uses each vendor CLI's **local auth state** as-is. If your login expired, the
  call fails and the skill reports the failure as a failure — no fake success.
  And if you asked for a vendor **by name**, the skill walks you through
  install/login and offers to retry — it never silently swaps in a different
  reviewer (substitution only with your consent).
- Calls consume quota on your own subscription with each vendor.
- No session handoff or background-job orchestration. For that, install
  [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
  (official, Apache-2.0) alongside — the two don't conflict.
- Field-verified on Windows (Git Bash) — including image generation. macOS/Linux
  use the same command structure but are untested as of this release.

## License

[MIT](./LICENSE)
