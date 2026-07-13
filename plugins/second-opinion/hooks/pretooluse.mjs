import { detectDirectInference } from "../scripts/vendor-policy.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

export function evaluateHook(payload) {
  const vendor = detectDirectInference(payload?.tool_input?.command);
  if (vendor) {
    return { code: 2, message: `Direct ${vendor} inference call is blocked by second-opinion (mechanical routing).\nUse the dispatcher instead:\n  node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch.mjs" --vendor ${vendor} --operation text --brief <file>\nManagement commands (--version, login, models) are not blocked.\n` };
  }
  return { code: 0, message: "" };
}

export function evaluateHookInput(value) {
  try { return evaluateHook(JSON.parse(value)); }
  catch { return { code: 0, message: "" }; }
}

async function main() {
  const result = evaluateHookInput(await readStdin());
  if (result.message) process.stderr.write(result.message);
  process.exitCode = result.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
