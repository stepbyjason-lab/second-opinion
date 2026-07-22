# second-opinion

**English** | [한국어](./README.ko.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green) ![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-blue) ![Version](https://img.shields.io/badge/version-0.8.2-informational)

**Use other AI vendors from inside Claude Code — in plain language.**
Second opinions, task offloading, and vendor capabilities like image generation.

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
| Codex sandbox **can't read files on Windows** | excerpts content into the brief instead of asking it to read files |
| Image generation: agy **ignores where you asked it to save** (uses its own scratch dir), codex needs a **write-enabled sandbox** and its Windows copy step can fail | knows each vendor's real artifact location, verifies the file actually exists, and moves it where you wanted — a vendor saying "saved" is not treated as success |
| "No issues found" is a weak signal (Gemini especially leans false-negative) | always relayed as "didn't find problems ≠ no problems" |

- **Execution receipts** — after every vendor call the skill states what was
  actually observed: the vendor and model requested, the real backend if known,
  exit/timeout status, and any fallback or downgrade. Requesting a model is not
  the same as running it, and a silently-ignored model label shows up here.

  For callers that need this machine-readable, set `SECOND_OPINION_RECEIPT` to a
  file path and each dispatch appends one JSON line — vendor, operation, model,
  effort, exit code, duration, and whether the process actually spawned. Codex
  calls also carry measured token usage read from Codex's own session log
  (input, cached input, output, reasoning, total, context window, quota used).
  Off by default; when unset, nothing is written.

  Comparing model cost? Use `(inputTokens - cachedInputTokens) + outputTokens`.
  Do not add `reasoningOutputTokens` — it is already part of `outputTokens`.

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

Having only one of the two is fine — that vendor works, the other is skipped.

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

Triggers are natural language, not keywords — any language Claude understands works.

## Data boundary — read this

**Everything placed in the brief is sent, verbatim, to an external vendor
(OpenAI / Google).** The skill is instructed to keep secrets, credentials, and raw
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
