// One-shot provider diagnostics. The probe deliberately reuses the public
// --request-json path, retains no results, and never selects a replacement model.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executeGenerationCli } from "./generation-dispatch.mjs";

const PROBE_SCHEMA_VERSION = 1;
const PROBE_MAX_COMPLETION_TOKENS = 64;
const PROBE_TIMEOUT_SECONDS = 120;

function usageText() {
  return [
    "Usage: node provider-probe.mjs --targets-json <file>",
    "",
    "The file is { schema_version: 1, providers: [{ provider, model }], env_file? }.",
    "Each configured provider receives one 64-token, zero-retry request through",
    "dispatch.mjs --request-json semantics. Results are printed and not retained.",
  ].join("\n");
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string`);
  }
  return value;
}

export function validateProbeConfig(raw, baseDirectory = process.cwd()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema_version !== PROBE_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${PROBE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.providers) || raw.providers.length === 0) throw new Error("providers must be a non-empty array");
  const providers = raw.providers.map((target, index) => ({
    provider: requiredString(target?.provider, `providers[${index}].provider`),
    model: requiredString(target?.model, `providers[${index}].model`),
  }));
  return {
    providers,
    envFile: raw.env_file == null ? null : resolve(baseDirectory, requiredString(raw.env_file, "env_file")),
  };
}

export async function runProviderProbe(config, deps = {}) {
  const execute = deps.executeGenerationCli ?? executeGenerationCli;
  const now = deps.now ?? Date.now;
  const rows = [];
  for (const target of config.providers) {
    const root = mkdtempSync(join(tmpdir(), "second-opinion-provider-probe-"));
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    const request = {
      schema_version: 1,
      operation: "generate",
      provider: target.provider,
      model: target.model,
      user: "Reply with OK.",
      max_completion_tokens: PROBE_MAX_COMPLETION_TOKENS,
      max_retries: 0,
      timeout_seconds: PROBE_TIMEOUT_SECONDS,
      ...(config.envFile ? { env_file: config.envFile } : {}),
    };
    const startedAt = now();
    try {
      writeFileSync(requestPath, JSON.stringify(request), "utf8");
      const exit = await execute(["--request-json", requestPath, "--response-json", responsePath], {
        ...(deps.generationDeps ?? {}),
        env: deps.env ?? process.env,
        stderr: deps.stderr ?? process.stderr,
      });
      let response = {};
      try { response = JSON.parse(readFileSync(responsePath, "utf8")); } catch { /* exit remains authoritative */ }
      const durationMs = Math.max(0, now() - startedAt);
      const status = exit === 0 ? "ok" : (Number.isInteger(response.statusCode) ? `http-${response.statusCode}` : `exit-${exit}`);
      rows.push({
        provider: target.provider,
        model: target.model,
        status,
        durationMs,
        failureClass: exit === 0 ? null : (response.failureClass ?? "unclassified"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return rows;
}

export function formatProbeTable(rows) {
  const lines = [
    "| provider | model | status | durationMs | failureClass |",
    "|---|---|---:|---:|---|",
  ];
  for (const row of rows) {
    lines.push(`| ${row.provider} | ${row.model} | ${row.status} | ${row.durationMs} | ${row.failureClass ?? "-"} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    process.stdout.write(`${usageText()}\n`);
    return 0;
  }
  if (argv.length !== 2 || argv[0] !== "--targets-json") {
    process.stderr.write(`${usageText()}\n`);
    return 2;
  }
  try {
    const targetPath = resolve(argv[1]);
    const config = validateProbeConfig(JSON.parse(readFileSync(targetPath, "utf8")), dirname(targetPath));
    process.stdout.write(formatProbeTable(await runProviderProbe(config)));
    return 0;
  } catch (error) {
    process.stderr.write(`provider probe failed: ${error?.message ?? "unknown error"}\n`);
    return 2;
  }
}

function invokedAsMain() {
  try { return resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (invokedAsMain()) main().then((code) => { process.exitCode = code; });
