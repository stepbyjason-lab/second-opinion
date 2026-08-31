// Portable receipts are assembled only from the closed, typed arguments below.
// They are not derived by copying or filtering the private receipt. Dispatcher-
// owned locator fields therefore have no input seam here. Free-form vendor
// vocabulary can still contain sensitive text and needs review before sharing.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { AGY_NATIVE_READONLY_PROFILE, DISPATCH_MODES, OPERATIONS, VENDORS } from "./vendor-policy.mjs";

// Shared parser/help/portable boundary prevents divergent acceptance. The token
// length limit is exported for the same reason the count is: the parser rejects
// what exceeds it, so a divergent copy would silently drop whole portable rows.
export const MAX_FREE_STRING = 1024;
export const MAX_EXPECT_OUTPUTS = 12;
// The declared section count may exceed the registration ceiling: declaring more
// than were registered is exactly the partial-registration case this records.
export const MAX_EXPECT_TOTAL = 1000;
const MODES = new Set([...DISPATCH_MODES, "invalid"]);
const PROFILES = new Set(["none", AGY_NATIVE_READONLY_PROFILE, "invalid"]);
const TRANSPORTS = new Set(["cli", "api"]);
const USAGE_SOURCES = new Set(["codex-rollout", "claude-result-json", "grok-result-json", "api-response"]);
const USAGE_STATUSES = new Set([
  "not-invoked", "ok", "unsupported-vendor", "no-err-file", "no-session-id", "read-failed", "not-regular-file", "file-too-large",
  "no-rollout-file", "ambiguous-rollout-file", "no-token-count", "invalid-token-fields", "output-too-large", "empty-output", "invalid-json",
  "vendor-reported-error", "not-reported", "empty-result", "missing-model-usage", "model-mismatch",
]);
const OUTPUT_STATUSES = new Set(["not-requested", "not-evaluated", "matched", "missing"]);
const FAILURE_CLASSES = new Set([
  "bad-invocation", "unknown-vendor", "vendor-discovery-unavailable", "vendor-unknown", "vendor-ambiguous",
  "unsupported-capability", "model-unknown", "model-ambiguous", "auth-failed", "executable-not-found",
  "vendor-state-corrupt", "rate-limited", "vendor-error", "no-output-timeout", "vendor-internal-timeout",
  "oversized-response", "invalid-response", "usage-unavailable", "attribution-unavailable",
  "model-unavailable", "payload-incompatible", "unclassified",
]);
const FAILURE_ACTORS = new Set(["dispatcher", "caller", "user", "vendor"]);
const COMPLETION_STATUSES = new Set(["not-applicable-cli", "applied-unchanged"]);
const USAGE_KEYS = new Set([
  "source", "actualModels", "inputTokens", "cachedInputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens",
  "reasoningOutputTokens", "totalTokens", "totalCostUsd", "contextWindow", "quotaUsedPercent",
]);

export class PortableReceiptError extends Error {
  constructor(code) {
    super("portable receipt unavailable");
    this.name = "PortableReceiptError";
    this.code = code;
  }
}

function invalid() { throw new PortableReceiptError("INVALID_RECORD"); }
function expectedTotalValue(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXPECT_TOTAL) invalid();
  return value;
}
function string(value, { nullable = false, max = MAX_FREE_STRING } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function label(value, allowed) {
  const result = string(value, { max: 64 });
  if (!allowed.has(result)) invalid();
  return result;
}
function finite(value, { nullable = false, maximum = Number.MAX_VALUE } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isFinite(value) || value < 0 || value > maximum) invalid();
  return value;
}
function boolean(value) {
  if (typeof value !== "boolean") invalid();
  return value;
}
function integer(value, { nullable = false, maximum = 0xffff_ffff } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}
function providerLabel(value) {
  const result = string(value, { max: 64 });
  if (!/^[a-z0-9_]+$/.test(result)) invalid();
  return result;
}
function completionLimit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (Object.keys(value).some((key) => !new Set(["requested", "status"]).has(key))) invalid();
  return {
    requested: finite(value.requested, { nullable: true, maximum: 1_000_000 }),
    status: label(value.status, COMPLETION_STATUSES),
  };
}
function usageRecord(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (Object.keys(value).some((key) => !USAGE_KEYS.has(key))) invalid();
  const actualModels = value.actualModels === undefined || value.actualModels === null ? null : value.actualModels;
  if (actualModels !== null && (!Array.isArray(actualModels) || actualModels.length === 0 || actualModels.length > 16)) invalid();
  return {
    source: label(value.source, USAGE_SOURCES),
    actualModels: actualModels === null ? null : actualModels.map((model) => string(model)),
    inputTokens: finite(value.inputTokens, { nullable: true }),
    cachedInputTokens: finite(value.cachedInputTokens, { nullable: true }),
    cacheCreationInputTokens: finite(value.cacheCreationInputTokens, { nullable: true }),
    cacheReadInputTokens: finite(value.cacheReadInputTokens, { nullable: true }),
    outputTokens: finite(value.outputTokens, { nullable: true }),
    reasoningOutputTokens: finite(value.reasoningOutputTokens, { nullable: true }),
    totalTokens: finite(value.totalTokens, { nullable: true }),
    totalCostUsd: finite(value.totalCostUsd, { nullable: true }),
    contextWindow: finite(value.contextWindow, { nullable: true }),
    quotaUsedPercent: finite(value.quotaUsedPercent, { nullable: true }),
  };
}

function outputChecks(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EXPECT_OUTPUTS) invalid();
  return value.map((check) => {
    if (!check || typeof check !== "object" || Array.isArray(check) || Object.keys(check).some((key) => !["token", "status"].includes(key))) invalid();
    return { token: string(check.token), status: label(check.status, new Set(["matched", "missing"])) };
  });
}

function executionEvidence(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const allowed = new Set([
    "modelReported", "effortRequested", "truncatedSuspected", "promptSource", "promptBytes",
    "finish_reason", "finishReason", "incomplete_details",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  const modelReported = label(value.modelReported ?? "none", new Set(["observed", "none"]));
  const incomplete = value.incomplete_details;
  if (incomplete !== null && incomplete !== undefined) {
    if (!incomplete || typeof incomplete !== "object" || Array.isArray(incomplete)
      || Object.keys(incomplete).some((key) => key !== "reason")) invalid();
  }
  return {
    modelReported,
    effortRequested: string(value.effortRequested, { nullable: true, max: 64 }),
    truncatedSuspected: value.truncatedSuspected === null || value.truncatedSuspected === undefined
      ? null
      : boolean(value.truncatedSuspected),
    promptSource: string(value.promptSource, { nullable: true }),
    promptBytes: integer(value.promptBytes, { nullable: true }),
    finish_reason: string(value.finish_reason, { nullable: true, max: 128 }),
    finishReason: string(value.finishReason, { nullable: true, max: 128 }),
    incomplete_details: incomplete == null ? null : { reason: string(incomplete.reason, { max: 128 }) },
  };
}

export function preparePortableUsage(value, status) {
  try {
    return { usage: usageRecord(value), status: label(status, USAGE_STATUSES) };
  } catch (error) {
    if (error instanceof PortableReceiptError) return { usage: null, status: "invalid-token-fields" };
    throw error;
  }
}

/**
 * Closed portable receipt emitter. Positional inputs keep the accepted argument
 * set explicit; the returned object is reconstructed key by key.
 */
export function buildPortableReceipt(
  ts,
  vendor,
  operation,
  requestedMode,
  effectiveMode,
  inputProfile,
  modelRequested,
  model,
  effort,
  exit,
  durationSec,
  invoked,
  stdoutDeclared,
  stderrDeclared,
  vendorUsage,
  vendorUsageStatus,
  outputCheckStatus,
  transport = "cli",
  provider = null,
  lensId = null,
  attempts = invoked ? 1 : 0,
  successfulAttempt = invoked && exit === 0 ? 1 : null,
  attemptWaitsMs = invoked ? [0] : [],
  completionTokenLimit = { requested: null, status: "not-applicable-cli" },
  failureClass = null,
  failureActor = null,
  remedy = null,
  evidence = {},
  outputChecksValue = null,
  expectedTotal = null,
) {
  const timestamp = string(ts, { max: 32 });
  try { if (new Date(timestamp).toISOString() !== timestamp) invalid(); } catch { invalid(); }
  const exitValue = exit === "timeout" ? "timeout" : exit;
  if (exitValue !== "timeout" && (!Number.isInteger(exitValue) || exitValue < 0 || exitValue > 0xffff_ffff)) invalid();
  const transportValue = label(transport, TRANSPORTS);
  const vendorValue = transportValue === "cli" ? label(vendor, new Set(VENDORS)) : null;
  const providerValue = transportValue === "api" ? providerLabel(provider) : null;
  const operationValue = transportValue === "api" ? label(operation, new Set(["generate"])) : label(operation, new Set(OPERATIONS));
  const attemptsValue = integer(attempts, { maximum: 17 });
  const successfulAttemptValue = integer(successfulAttempt, { nullable: true, maximum: 17 });
  if (successfulAttemptValue !== null && (successfulAttemptValue < 1 || successfulAttemptValue > attemptsValue)) invalid();
  if (!Array.isArray(attemptWaitsMs) || attemptWaitsMs.length !== attemptsValue) invalid();
  const waitValues = attemptWaitsMs.map((value) => finite(value, { maximum: 3_600_000 }));
  if ((failureClass === null) !== (failureActor === null) || (failureClass === null) !== (remedy === null)) invalid();
  const observed = executionEvidence(evidence);
  return {
    schemaVersion: 2,
    receiptKind: "portable",
    ts: timestamp,
    transport: transportValue,
    vendor: vendorValue,
    provider: providerValue,
    operation: operationValue,
    requestedMode: label(requestedMode, MODES),
    effectiveMode: label(effectiveMode, MODES),
    inputProfile: label(inputProfile, PROFILES),
    modelRequested: string(modelRequested, { nullable: true }),
    model: string(model, { nullable: true }),
    effort: string(effort, { nullable: true, max: 64 }),
    ...observed,
    lensId: string(lensId, { nullable: true, max: 64 }),
    exit: exitValue,
    durationSec: finite(durationSec),
    invoked: boolean(invoked),
    outputDeclared: { stdout: boolean(stdoutDeclared), stderr: boolean(stderrDeclared) },
    vendorUsage: usageRecord(vendorUsage),
    vendorUsageStatus: label(vendorUsageStatus, USAGE_STATUSES),
    outputCheckStatus: label(outputCheckStatus, OUTPUT_STATUSES),
    outputChecks: outputChecks(outputChecksValue),
    expectedTotal: expectedTotalValue(expectedTotal),
    attempts: attemptsValue,
    attemptWaitsMs: waitValues,
    successfulAttempt: successfulAttemptValue,
    completionTokenLimit: completionLimit(completionTokenLimit),
    failureClass: failureClass === null ? null : label(failureClass, FAILURE_CLASSES),
    failureActor: failureActor === null ? null : label(failureActor, FAILURE_ACTORS),
    remedy: string(remedy, { nullable: true }),
  };
}

export function appendPortableReceipt(target, record) {
  try {
    const serialized = JSON.stringify(record);
    JSON.parse(serialized);
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
    appendFileSync(target, `${separator}${serialized}\n`);
  } catch {
    throw new PortableReceiptError("WRITE_FAILED");
  }
}
