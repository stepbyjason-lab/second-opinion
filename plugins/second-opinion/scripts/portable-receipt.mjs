// Portable receipts are assembled only from the closed, typed arguments below.
// They are not derived by copying or filtering the private receipt. Dispatcher-
// owned locator fields therefore have no input seam here. Free-form vendor
// vocabulary can still contain sensitive text and needs review before sharing.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { AGY_NATIVE_READONLY_PROFILE, DISPATCH_MODES, OPERATIONS, VENDORS } from "./vendor-policy.mjs";

const MAX_FREE_STRING = 1024;
const MODES = new Set([...DISPATCH_MODES, "invalid"]);
const PROFILES = new Set(["none", AGY_NATIVE_READONLY_PROFILE, "invalid"]);
const USAGE_SOURCES = new Set(["codex-rollout", "claude-result-json"]);
const USAGE_STATUSES = new Set([
  "not-invoked", "ok", "unsupported-vendor", "no-err-file", "no-session-id", "read-failed", "not-regular-file", "file-too-large",
  "no-rollout-file", "ambiguous-rollout-file", "no-token-count", "invalid-token-fields", "output-too-large", "empty-output", "invalid-json",
  "vendor-reported-error", "empty-result", "missing-model-usage", "model-mismatch",
]);
const OUTPUT_STATUSES = new Set(["not-requested", "not-evaluated", "matched", "missing"]);
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
) {
  const timestamp = string(ts, { max: 32 });
  try { if (new Date(timestamp).toISOString() !== timestamp) invalid(); } catch { invalid(); }
  const exitValue = exit === "timeout" ? "timeout" : exit;
  if (exitValue !== "timeout" && (!Number.isInteger(exitValue) || exitValue < 0 || exitValue > 0xffff_ffff)) invalid();
  return {
    schemaVersion: 2,
    receiptKind: "portable",
    ts: timestamp,
    vendor: label(vendor, new Set(VENDORS)),
    operation: label(operation, new Set(OPERATIONS)),
    requestedMode: label(requestedMode, MODES),
    effectiveMode: label(effectiveMode, MODES),
    inputProfile: label(inputProfile, PROFILES),
    modelRequested: string(modelRequested, { nullable: true }),
    model: string(model, { nullable: true }),
    effort: string(effort, { nullable: true, max: 64 }),
    exit: exitValue,
    durationSec: finite(durationSec),
    invoked: boolean(invoked),
    outputDeclared: { stdout: boolean(stdoutDeclared), stderr: boolean(stderrDeclared) },
    vendorUsage: usageRecord(vendorUsage),
    vendorUsageStatus: label(vendorUsageStatus, USAGE_STATUSES),
    outputCheckStatus: label(outputCheckStatus, OUTPUT_STATUSES),
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
