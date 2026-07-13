import { detectDirectInference } from "../scripts/vendor-policy.mjs";
import { realpathSync } from "node:fs";
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
