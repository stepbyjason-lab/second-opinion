// Unified text-generation dispatcher used by consumer projects.
//
// This layer owns HTTP and subscription adapters plus bounded, same-provider
// retry. Callers name exactly one provider; cross-provider routing and budgets
// remain caller concerns. Secrets are read from an env file or
// inherited environment and are never accepted as CLI arguments or returned.
import {
  mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  MAX_BRIEF_BYTES,
  MAX_VENDOR_USAGE_BYTES,
  generationPathConfigError,
  resolveReceiptSinks,
  writeApiDispatchReceipts,
} from "./dispatch.mjs";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_COMPLETION_TOKENS = 4096;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_RETRIES = 5;
const MAX_RETRIES = 16;
const INITIAL_BACKOFF_MS = 2_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 120_000;
export const MAX_ACCEPTED_RESPONSE_BYTES = 16 * 1024 * 1024;

export const HTTP_PROVIDERS = Object.freeze({
  openrouter: { kind: "openai", key: "OPENROUTER_API_KEY", model: "OPENROUTER_MODEL", base: "OPENROUTER_BASE_URL", defaultBase: "https://openrouter.ai/api/v1" },
  nvidia_nim: { kind: "openai", key: "NVIDIA_NIM_API_KEY", model: "NVIDIA_NIM_MODEL", base: "NVIDIA_NIM_BASE_URL", defaultBase: "https://integrate.api.nvidia.com/v1" },
  gemini: { kind: "gemini", key: "GEMINI_API_KEY", model: "GEMINI_MODEL", base: "GEMINI_BASE_URL", defaultBase: "https://generativelanguage.googleapis.com/v1beta" },
  mistral: { kind: "openai", key: "MISTRAL_API_KEY", model: "MISTRAL_MODEL", base: "MISTRAL_BASE_URL", defaultBase: "https://api.mistral.ai/v1" },
  github_models: { kind: "openai", key: "GITHUB_MODELS_API_KEY", model: "GITHUB_MODELS_MODEL", base: "GITHUB_MODELS_BASE_URL", defaultBase: "https://models.github.ai/inference" },
  zhipu: { kind: "openai", key: "ZHIPU_API_KEY", model: "ZHIPU_MODEL", base: "ZHIPU_BASE_URL", defaultBase: "https://api.z.ai/api/paas/v4" },
});

const SUBSCRIPTION_PROVIDERS = new Set(["codex", "agy", "claude"]);

export class GenerationDispatchError extends Error {
  constructor(message, {
    statusCode = null,
    retryable = false,
    code = "provider_error",
    failureClass = "unclassified",
    failureActor = "caller",
    remedy = "Inspect the configured stderr sink; no diagnosis was inferred.",
    retryAfterMs = 0,
    attempts = 1,
    attemptLog = [],
  } = {}) {
    super(message);
    this.name = "GenerationDispatchError";
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.code = code;
    this.failureClass = failureClass;
    this.failureActor = failureActor;
    this.remedy = remedy;
    this.retryAfterMs = retryAfterMs;
    this.attempts = attempts;
    this.attemptLog = attemptLog;
  }
}

function emptyResponseFailure(message, remedy = "The provider returned no usable text; retry the same provider after backoff.") {
  return new GenerationDispatchError(message, {
    retryable: true,
    code: "vendor_error",
    failureClass: "vendor-error",
    failureActor: "vendor",
    remedy,
  });
}

function invalidResponseFailure(message, remedy = "The provider response did not contain a text string; inspect the provider response shape before retrying.") {
  return new GenerationDispatchError(message, {
    code: "invalid_response",
    failureClass: "invalid-response",
    failureActor: "vendor",
    remedy,
  });
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new GenerationDispatchError(`${label} must be an integer from ${minimum} to ${maximum}`, {
      code: "invalid_request", failureClass: "bad-invocation", failureActor: "caller",
      remedy: `Set ${label} to an integer from ${minimum} to ${maximum}.`,
    });
  }
  return candidate;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || /[\0]/.test(value)) {
    throw new GenerationDispatchError(`${label} must be a non-empty string`, {
      code: "invalid_request", failureClass: "bad-invocation", failureActor: "caller",
      remedy: `Provide a non-empty ${label} value.`,
    });
  }
  return value;
}

function parseEnvText(text) {
  const parsed = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    if (key) parsed[key] = value;
  }
  return parsed;
}

export function loadProviderEnvironment(envFile, inherited = process.env) {
  let fromFile = {};
  if (envFile) {
    try { fromFile = parseEnvText(readFileSync(resolve(envFile), "utf8")); }
    catch (error) {
      throw new GenerationDispatchError(`unable to read provider env file (${error.code ?? "read_failed"})`, {
        code: "env_file_error", failureClass: "bad-invocation", failureActor: "caller",
        remedy: "Provide a readable env_file path containing only the documented provider environment names.",
      });
    }
  }
  // Explicit process environment wins, matching ordinary dotenv semantics.
  return { ...fromFile, ...inherited };
}
function providerConfig(provider, model, env) {
  if (SUBSCRIPTION_PROVIDERS.has(provider)) return { provider, model, kind: "subscription", active: true };
  const definition = HTTP_PROVIDERS[provider];
  if (!definition) {
    throw new GenerationDispatchError(`unsupported provider: ${provider}`, {
      code: "unsupported_provider",
      failureClass: "unknown-vendor",
      failureActor: "caller",
      remedy: `Choose one provider from: ${[...Object.keys(HTTP_PROVIDERS), ...SUBSCRIPTION_PROVIDERS].join(", ")}.`,
    });
  }
  const apiKey = String(env[definition.key] ?? "").trim();
  const configuredBase = String(env[definition.base] || definition.defaultBase);
  let baseUrl;
  try {
    const candidate = new URL(configuredBase);
    const trusted = new URL(definition.defaultBase);
    if (candidate.protocol !== "https:" || candidate.origin !== trusted.origin || candidate.username || candidate.password || candidate.search || candidate.hash) throw new Error();
    baseUrl = candidate.href.replace(/\/$/, "");
  } catch {
    throw new GenerationDispatchError(`${definition.base} base URL must use the provider's trusted HTTPS origin`, {
      code: "invalid_request", failureClass: "bad-invocation", failureActor: "caller",
      remedy: `Use the trusted HTTPS origin declared for ${provider}; redirects and credentials in the URL are not accepted.`,
    });
  }
  return {
    provider,
    model,
    kind: definition.kind,
    active: Boolean(apiKey && model),
    reason: apiKey ? null : "missing-api-key",
    apiKey,
    baseUrl,
  };
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const prompt = raw.prompt_tokens ?? raw.input_tokens ?? raw.inputTokens ?? raw.promptTokenCount;
  const completion = raw.completion_tokens ?? raw.output_tokens ?? raw.outputTokens ?? raw.candidatesTokenCount;
  const total = raw.total_tokens ?? raw.totalTokens ?? raw.totalTokenCount;
  const normalized = {};
  if (Number.isFinite(prompt)) normalized.prompt_tokens = prompt;
  if (Number.isFinite(completion)) normalized.completion_tokens = completion;
  if (Number.isFinite(total)) normalized.total_tokens = total;
  else if (Number.isFinite(prompt) && Number.isFinite(completion)) normalized.total_tokens = prompt + completion;
  return Object.keys(normalized).length ? normalized : null;
}

function retryAfterMilliseconds(response, now = Date.now()) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function classifyHttpFailure(response, now) {
  const status = response.status;
  if (status === 401 || status === 403) {
    return new GenerationDispatchError(`HTTP ${status}`, {
      statusCode: status,
      code: "auth_failed",
      failureClass: "auth-failed",
      failureActor: "user",
      remedy: "The provider credential is missing, expired, or unauthorized; verify the documented environment variable and reissue it if needed.",
    });
  }
  if (status === 429) {
    return new GenerationDispatchError("HTTP 429", {
      statusCode: status,
      retryable: true,
      retryAfterMs: retryAfterMilliseconds(response, now),
      code: "rate_limited",
      failureClass: "rate-limited",
      failureActor: "vendor",
      remedy: "Wait for the provider limit to recover, then retry the same provider.",
    });
  }
  if (status >= 500 && status <= 599) {
    return new GenerationDispatchError(`HTTP ${status}`, {
      statusCode: status,
      retryable: true,
      retryAfterMs: retryAfterMilliseconds(response, now),
      code: "vendor_error",
      failureClass: "vendor-error",
      failureActor: "vendor",
      remedy: "The provider returned a transient server error; retry the same provider after backoff.",
    });
  }
  if (status === 404 || status === 410) {
    return new GenerationDispatchError(`HTTP ${status}`, {
      statusCode: status,
      code: "model_unavailable",
      failureClass: "model-unavailable",
      failureActor: "vendor",
      remedy: "The requested provider model is unavailable or retired; verify that exact model with the provider before retrying.",
    });
  }
  if (status === 400 || status === 422) {
    return new GenerationDispatchError(`HTTP ${status}`, {
      statusCode: status,
      code: "payload_incompatible",
      failureClass: "payload-incompatible",
      failureActor: "dispatcher",
      remedy: "The provider rejected this adapter payload shape; update the provider adapter before retrying the unchanged request.",
    });
  }
  return new GenerationDispatchError(`HTTP ${status}`, {
    statusCode: status,
    code: "http_error",
    failureClass: "bad-invocation",
    failureActor: "caller",
    remedy: "Correct the request parameters for this provider before retrying.",
  });
}

function timeoutSignal(milliseconds, deps = {}) {
  const controller = new AbortController();
  const timer = (deps.setTimeout ?? setTimeout)(() => controller.abort(), Math.max(1, milliseconds));
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function remainingMilliseconds(request, deps) {
  return Math.max(0, request.deadlineMs - (deps.now ?? Date.now)());
}

async function readStreamChunk(reader, request, deps) {
  let timer;
  try {
    const remaining = remainingMilliseconds(request, deps);
    if (remaining <= 0) {
      throw new GenerationDispatchError("generation deadline expired", {
        retryable: false,
        code: "timeout",
        failureClass: "no-output-timeout",
        failureActor: "caller",
        remedy: "Increase timeout_seconds or split the request into smaller work.",
      });
    }
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = (deps.setTimeout ?? setTimeout)(
          () => reject(new GenerationDispatchError("stream read timed out", {
            retryable: true,
            code: "read_timeout",
            failureClass: "no-output-timeout",
            failureActor: "caller",
            remedy: "Increase timeout_seconds or retry the same provider after the read stall clears.",
          })),
          Math.max(1, Math.min(READ_TIMEOUT_MS, remaining)),
        );
        timer.unref?.();
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function consumeSse(response, parseEvent, onChunk, request, deps) {
  if (!response.body?.getReader) throw new GenerationDispatchError("streaming response body is unavailable", { code: "streaming_unsupported" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason = null;
  let model = null;
  let usage = null;
  let done = false;
  let totalBytes = 0;
  let incompleteFrameBytes = 0;
  let acceptedBytes = 0;
  let sawTextString = false;
  let failed = true;
  const providerStopSignals = { finish_reason: null, finishReason: null, incomplete_details: null };
  try {
    for (;;) {
      // Re-arm on every chunk. A single flat timer either kills legitimate long
      // generations or, if cleared after headers, leaves a stalled stream forever.
      const part = await readStreamChunk(reader, request, deps);
      if (part.done) break;
      const bytes = part.value?.byteLength ?? 0;
      totalBytes += bytes;
      if (totalBytes > MAX_VENDOR_USAGE_BYTES) {
        throw new GenerationDispatchError("stream data exceeds the 64MB limit", {
          code: "oversized_response",
          failureClass: "oversized-response",
          failureActor: "vendor",
          remedy: "Reduce max_completion_tokens or request a smaller response; oversized responses are not retried.",
        });
      }
      let lastNewline = -1;
      for (let index = 0; index < bytes; index += 1) if (part.value[index] === 0x0a) lastNewline = index;
      incompleteFrameBytes = lastNewline >= 0 ? bytes - lastNewline - 1 : incompleteFrameBytes + bytes;
      if (incompleteFrameBytes > MAX_BRIEF_BYTES) {
        throw new GenerationDispatchError("stream frame exceeds the 8MB limit", {
          code: "oversized_response",
          failureClass: "oversized-response",
          failureActor: "vendor",
          remedy: "Request a smaller response; oversized frames are not retried.",
        });
      }
      buffer += decoder.decode(part.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { done = true; continue; }
        if (!payload) continue;
        let parsed;
        try { parsed = JSON.parse(payload); }
        catch {
          throw new GenerationDispatchError("invalid SSE JSON payload", {
            code: "invalid_response",
            failureClass: "invalid-response",
            failureActor: "vendor",
            remedy: "The provider returned malformed streaming data; inspect the provider status before retrying.",
          });
        }
        const event = parseEvent(parsed);
        if (typeof event.text === "string") {
          sawTextString = true;
          acceptedBytes += Buffer.byteLength(event.text, "utf8");
          if (acceptedBytes > MAX_ACCEPTED_RESPONSE_BYTES) {
            throw new GenerationDispatchError("accepted response exceeds the 16MB buffer limit", {
              code: "oversized_response",
              failureClass: "oversized-response",
              failureActor: "vendor",
              remedy: "Reduce max_completion_tokens or request a smaller response; oversized responses are not retried.",
            });
          }
          text += event.text;
          onChunk?.(event.text);
        }
        finishReason = event.finishReason ?? finishReason;
        model = event.model ?? model;
        usage = event.usage ?? usage;
        if (event.providerStopSignals) {
          for (const key of Object.keys(providerStopSignals)) {
            if (event.providerStopSignals[key] !== null && event.providerStopSignals[key] !== undefined) {
              providerStopSignals[key] = event.providerStopSignals[key];
            }
          }
        }
        done ||= event.done === true;
      }
    }
    if (!sawTextString) throw invalidResponseFailure("stream response text is missing or is not a string");
    if (!text.trim()) throw emptyResponseFailure("stream returned no text");
    failed = false;
    const rawStopReason = providerStopSignals.finish_reason
      ?? providerStopSignals.finishReason
      ?? providerStopSignals.incomplete_details?.reason
      ?? finishReason;
    const normalizedStopReason = typeof rawStopReason === "string" ? rawStopReason.toLowerCase() : null;
    return {
      text,
      finishReason,
      model,
      usage,
      truncatedSuspected: providerStopSignals.incomplete_details !== null
        || normalizedStopReason === "length"
        || normalizedStopReason === "max_tokens"
        || (!done && !finishReason),
      providerStopSignals,
    };
  } finally {
    if (failed) {
      try { await reader.cancel(); } catch { /* the bounded stream failure remains primary */ }
    }
  }
}

async function readJsonResponse(response, request, deps) {
  if (!response.body?.getReader) {
    throw new GenerationDispatchError("response body is unavailable", {
      code: "invalid_response",
      failureClass: "invalid-response",
      failureActor: "vendor",
      remedy: "The provider returned an unreadable response body.",
    });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let failed = true;
  try {
    for (;;) {
      const part = await readStreamChunk(reader, request, deps);
      if (part.done) break;
      const value = Buffer.from(part.value);
      bytes += value.length;
      if (bytes > MAX_ACCEPTED_RESPONSE_BYTES) {
        throw new GenerationDispatchError("response exceeds the 16MB buffer limit", {
          code: "oversized_response",
          failureClass: "oversized-response",
          failureActor: "vendor",
          remedy: "Reduce max_completion_tokens or request a smaller response; oversized responses are not retried.",
        });
      }
      chunks.push(value);
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch {
      throw new GenerationDispatchError("invalid JSON response", {
        code: "invalid_response",
        failureClass: "invalid-response",
        failureActor: "vendor",
        remedy: "The provider returned malformed JSON; inspect provider status before retrying.",
      });
    }
    failed = false;
    return parsed;
  } finally {
    if (failed) {
      try { await reader.cancel(); } catch { /* bounded failure remains primary */ }
    }
  }
}

async function openAiAdapter(config, request, deps) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new GenerationDispatchError("fetch is unavailable", { code: "adapter_unsupported" });
  const payload = {
    model: config.model,
    messages: [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      { role: "user", content: request.user },
    ],
    max_tokens: request.maxCompletionTokens,
    stream: request.stream,
  };
  if (config.provider === "nvidia_nim" && new Set(["qwen/qwen3.5-397b-a17b", "qwen/qwen3.5-122b-a10b"]).has(config.model)) {
    payload.chat_template_kwargs = { enable_thinking: false };
  }
  if (request.stream) payload.stream_options = { include_usage: true };
  const remaining = remainingMilliseconds(request, deps);
  if (remaining <= 0) {
    throw new GenerationDispatchError("generation deadline expired", {
      code: "timeout", failureClass: "no-output-timeout", failureActor: "caller",
      remedy: "Increase timeout_seconds or split the request into smaller work.",
    });
  }
  const timer = timeoutSignal(Math.min(CONNECT_TIMEOUT_MS, remaining), deps);
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: timer.signal,
      redirect: "error",
    });
  } catch (error) {
    throw new GenerationDispatchError(error?.name === "AbortError" ? "connection timed out" : `network error: ${error?.name ?? "unknown"}`, {
      retryable: true,
      code: error?.name === "AbortError" ? "connect_timeout" : "network_error",
      failureClass: error?.name === "AbortError" ? "no-output-timeout" : "vendor-error",
      failureActor: error?.name === "AbortError" ? "caller" : "vendor",
      remedy: error?.name === "AbortError"
        ? "Increase timeout_seconds or retry the same provider after the connection stall clears."
        : "The provider connection failed; retry the same provider after backoff.",
    });
  } finally { timer.clear(); }
  if (!response.ok) throw classifyHttpFailure(response, (deps.now ?? Date.now)());
  if (request.stream) {
    return await consumeSse(response, (event) => ({
      text: event?.choices?.[0]?.delta?.content,
      finishReason: event?.choices?.[0]?.finish_reason ?? null,
      model: event?.model ?? null,
      usage: normalizeUsage(event?.usage),
      done: Boolean(event?.choices?.[0]?.finish_reason),
      providerStopSignals: {
        finish_reason: event?.choices?.[0]?.finish_reason ?? null,
        finishReason: null,
        incomplete_details: event?.incomplete_details?.reason == null ? null : { reason: event.incomplete_details.reason },
      },
    }), deps.onChunk, request, deps);
  }
  const data = await readJsonResponse(response, request, deps);
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw invalidResponseFailure("response text is missing or is not a string");
  if (!text.trim()) throw emptyResponseFailure("response returned no text");
  const finishReason = data?.choices?.[0]?.finish_reason ?? null;
  return {
    text,
    model: data.model ?? null,
    usage: normalizeUsage(data.usage),
    finishReason,
    truncatedSuspected: finishReason === "length" || data?.incomplete_details?.reason != null,
    providerStopSignals: {
      finish_reason: finishReason,
      finishReason: null,
      incomplete_details: data?.incomplete_details?.reason == null ? null : { reason: data.incomplete_details.reason },
    },
  };
}

function geminiEvent(event) {
  const candidate = event?.candidates?.[0];
  const parts = candidate?.content?.parts;
  return {
    text: Array.isArray(parts)
      ? parts.map((part) => typeof part?.text === "string" ? part.text : "").join("")
      : undefined,
    finishReason: candidate?.finishReason ? String(candidate.finishReason).toLowerCase() : null,
    model: event?.modelVersion ?? null,
    usage: normalizeUsage(event?.usageMetadata),
    done: Boolean(candidate?.finishReason),
    providerStopSignals: {
      finish_reason: null,
      finishReason: candidate?.finishReason ?? null,
      incomplete_details: null,
    },
  };
}

async function geminiAdapter(config, request, deps) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new GenerationDispatchError("fetch is unavailable", { code: "adapter_unsupported" });
  const payload = {
    ...(request.system ? { system_instruction: { parts: [{ text: request.system }] } } : {}),
    contents: [{ role: "user", parts: [{ text: request.user }] }],
    generationConfig: { maxOutputTokens: request.maxCompletionTokens },
  };
  const method = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const remaining = remainingMilliseconds(request, deps);
  if (remaining <= 0) {
    throw new GenerationDispatchError("generation deadline expired", {
      code: "timeout", failureClass: "no-output-timeout", failureActor: "caller",
      remedy: "Increase timeout_seconds or split the request into smaller work.",
    });
  }
  const timer = timeoutSignal(Math.min(CONNECT_TIMEOUT_MS, remaining), deps);
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/models/${encodeURIComponent(config.model)}:${method}`, {
      method: "POST",
      headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: timer.signal,
      redirect: "error",
    });
  } catch (error) {
    throw new GenerationDispatchError(error?.name === "AbortError" ? "connection timed out" : `network error: ${error?.name ?? "unknown"}`, {
      retryable: true,
      code: error?.name === "AbortError" ? "connect_timeout" : "network_error",
      failureClass: error?.name === "AbortError" ? "no-output-timeout" : "vendor-error",
      failureActor: error?.name === "AbortError" ? "caller" : "vendor",
      remedy: error?.name === "AbortError"
        ? "Increase timeout_seconds or retry the same provider after the connection stall clears."
        : "The provider connection failed; retry the same provider after backoff.",
    });
  } finally { timer.clear(); }
  if (!response.ok) throw classifyHttpFailure(response, (deps.now ?? Date.now)());
  if (request.stream) return await consumeSse(response, geminiEvent, deps.onChunk, request, deps);
  const data = await readJsonResponse(response, request, deps);
  const event = geminiEvent(data);
  if (typeof event.text !== "string") throw invalidResponseFailure("response text is missing or is not a string");
  if (!event.text.trim()) throw emptyResponseFailure("response returned no text");
  return {
    text: event.text,
    model: event.model,
    usage: event.usage,
    finishReason: event.finishReason,
    truncatedSuspected: event.finishReason === "max_tokens" || event.finishReason === "length",
    providerStopSignals: event.providerStopSignals,
  };
}

function validateRequest(raw) {
  const invalidRequest = (message) => new GenerationDispatchError(message, {
    code: "invalid_request",
    failureClass: "bad-invocation",
    failureActor: "caller",
    remedy: "Correct the request JSON using the documented generation schema.",
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidRequest("request must be an object");
  if (raw.schema_version !== SCHEMA_VERSION) throw invalidRequest(`schema_version must be ${SCHEMA_VERSION}`);
  if (raw.operation !== "generate") throw invalidRequest("operation must be generate");
  if (Object.hasOwn(raw, "budget")) throw invalidRequest("budget is not supported; callers own cross-provider budgets and may set max_retries for this provider");
  let lensId = null;
  if (raw.lens_id !== undefined && raw.lens_id !== null) {
    if (typeof raw.lens_id !== "string" || raw.lens_id.length < 1 || raw.lens_id.length > 64 || /[\x00-\x1f\x7f]/.test(raw.lens_id)) {
      throw invalidRequest("lens_id must be a string of 1 to 64 characters without control characters");
    }
    lensId = raw.lens_id;
  }
  return {
    provider: requiredString(raw.provider, "provider"),
    model: requiredString(raw.model, "model"),
    system: raw.system == null ? "" : String(raw.system),
    user: requiredString(raw.user, "user"),
    stream: raw.stream === true,
    envFile: raw.env_file ? String(raw.env_file) : null,
    timeoutSeconds: boundedInteger(raw.timeout_seconds, DEFAULT_TIMEOUT_SECONDS, 1, 3600, "timeout_seconds"),
    maxCompletionTokens: boundedInteger(raw.max_completion_tokens, DEFAULT_MAX_COMPLETION_TOKENS, 1, 1_000_000, "max_completion_tokens"),
    maxRetries: boundedInteger(raw.max_retries, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES, "max_retries"),
    lensId,
    promptSource: raw.prompt_source == null ? null : requiredString(raw.prompt_source, "prompt_source"),
    promptBytes: Buffer.byteLength(`${raw.system == null ? "" : String(raw.system)}${requiredString(raw.user, "user")}`, "utf8"),
    planWarningRequested: Object.hasOwn(raw, "timeout_seconds") || Object.hasOwn(raw, "max_retries"),
  };
}

function safeError(error, secrets = []) {
  let value = String(error?.message ?? error?.code ?? "provider failure").replace(/\s+/g, " ").slice(0, 300);
  for (const secret of secrets) if (secret) value = value.split(secret).join("[REDACTED]");
  return value;
}

function backoffMilliseconds(retryNumber) {
  return Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * (BACKOFF_MULTIPLIER ** (retryNumber - 1)));
}

function defaultSleep(milliseconds) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

async function withinWallClockDeadline(promise, milliseconds, enabled) {
  if (!enabled) return await promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new GenerationDispatchError("generation deadline expired", {
          code: "timeout",
          failureClass: "no-output-timeout",
          failureActor: "caller",
          remedy: "Increase timeout_seconds or split the request into smaller work.",
        })), Math.max(1, milliseconds));
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function classifiedError(error) {
  if (error instanceof GenerationDispatchError) return error;
  const status = Number(error?.statusCode);
  if (status === 401 || status === 403) return classifyHttpFailure({ status, headers: { get: () => null } }, Date.now());
  if (status === 429 || (status >= 500 && status <= 599)) return classifyHttpFailure({ status, headers: { get: () => null } }, Date.now());
  return new GenerationDispatchError(safeError(error), {
    code: "unclassified",
    failureClass: "unclassified",
    failureActor: "caller",
    remedy: "Inspect the configured stderr sink; no diagnosis was inferred.",
  });
}

function retryableFailure(error) {
  return error?.statusCode === 429
    || (error?.statusCode >= 500 && error?.statusCode <= 599)
    || new Set(["network_error", "connect_timeout", "read_timeout", "vendor_error"]).has(error?.code);
}

function warningForPlan(request) {
  let backoff = 0;
  for (let retry = 1; retry <= request.maxRetries; retry += 1) backoff += backoffMilliseconds(retry);
  const maximumPlanMs = ((request.maxRetries + 1) * (CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS)) + backoff;
  return request.planWarningRequested && maximumPlanMs > request.timeoutSeconds * 1000
    ? `dispatch generation warning: retry plan worst-case ${Math.ceil(maximumPlanMs / 1000)}s exceeds timeout_seconds=${request.timeoutSeconds}s; the absolute deadline will stop later retries\n`
    : null;
}

export async function dispatchGeneration(rawRequest, deps = {}) {
  const request = validateRequest(rawRequest);
  const env = loadProviderEnvironment(request.envFile, deps.env ?? process.env);
  const config = providerConfig(request.provider, request.model, env);
  if (!config.active) {
    throw new GenerationDispatchError(`credential environment variable is unavailable: ${HTTP_PROVIDERS[request.provider]?.key ?? "provider credential"}`, {
      code: "auth_failed",
      failureClass: "auth-failed",
      failureActor: "user",
      remedy: `Set ${HTTP_PROVIDERS[request.provider]?.key ?? "the documented provider credential"} in the selected environment file or process environment.`,
    });
  }
  const stderr = deps.stderr ?? process.stderr;
  const warning = warningForPlan(request);
  if (warning) {
    try { stderr.write(warning); } catch { /* warnings never change dispatch */ }
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const startedAt = now();
  request.deadlineMs = startedAt + (request.timeoutSeconds * 1000);
  const attemptLog = [];
  let waitBeforeMs = 0;
  let lastError = null;
  const maximumAttempts = 1 + request.maxRetries;
  const secretValues = Object.values(HTTP_PROVIDERS).map((definition) => String(env[definition.key] ?? "").trim()).filter(Boolean);

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let waitedMs = 0;
    if (waitBeforeMs > 0) {
      const remaining = request.deadlineMs - now();
      if (remaining < waitBeforeMs) break;
      const waitStartedAt = now();
      await sleep(waitBeforeMs);
      waitedMs = Math.max(0, now() - waitStartedAt);
      if (now() >= request.deadlineMs) break;
    }
    const row = { attempt, waitedMs, outcome: "started", failureClass: null };
    attemptLog.push(row);
    try {
      const attemptRemainingMs = request.deadlineMs - now();
      if (attemptRemainingMs <= 0) {
        throw new GenerationDispatchError("generation deadline expired", {
          code: "timeout", failureClass: "no-output-timeout", failureActor: "caller",
          remedy: "Increase timeout_seconds or split the request into smaller work.",
        });
      }
      if (config.kind === "subscription" && attemptRemainingMs < 1000) {
        throw new GenerationDispatchError("generation deadline cannot fit another CLI attempt", {
          code: "timeout", failureClass: "no-output-timeout", failureActor: "caller",
          remedy: "Increase timeout_seconds or reduce max_retries so a CLI attempt fits the remaining deadline.",
        });
      }
      const attemptRequest = {
        ...request,
        timeoutSeconds: Math.max(1, Math.floor(attemptRemainingMs / 1000)),
      };
      const attemptChunks = [];
      let bufferedBytes = 0;
      const adapterDeps = {
        ...deps,
        now,
        onChunk: (chunk) => {
          const value = String(chunk);
          bufferedBytes += Buffer.byteLength(value, "utf8");
          if (bufferedBytes > MAX_ACCEPTED_RESPONSE_BYTES) {
            throw new GenerationDispatchError("accepted response exceeds the 16MB buffer limit", {
              code: "oversized_response",
              failureClass: "oversized-response",
              failureActor: "vendor",
              remedy: "Reduce max_completion_tokens or request a smaller response; oversized responses are not retried.",
            });
          }
          attemptChunks.push(value);
        },
      };
      const pendingResult = config.kind === "openai"
        ? (deps.openAiAdapter ?? openAiAdapter)(config, attemptRequest, adapterDeps)
        : config.kind === "gemini"
          ? (deps.geminiAdapter ?? geminiAdapter)(config, attemptRequest, adapterDeps)
          : (deps.subscriptionAdapter ?? (() => {
            throw new GenerationDispatchError("subscription adapter unavailable", {
              code: "adapter_unsupported", failureClass: "unsupported-capability", failureActor: "caller",
              remedy: "Use the installed dispatcher subscription adapter for this provider.",
            });
      }))(config, attemptRequest, adapterDeps);
      const result = await withinWallClockDeadline(pendingResult, attemptRemainingMs, deps.now === undefined);
      if (!result || typeof result.text !== "string") {
        throw invalidResponseFailure("adapter response text is missing or is not a string");
      }
      if (!result.text.trim()) {
        throw emptyResponseFailure("adapter returned no text");
      }
      if (Buffer.byteLength(result.text, "utf8") > MAX_ACCEPTED_RESPONSE_BYTES) {
        throw new GenerationDispatchError("response exceeds the 16MB buffer limit", {
          code: "oversized_response", failureClass: "oversized-response", failureActor: "vendor",
          remedy: "Reduce max_completion_tokens or request a smaller response; oversized responses are not retried.",
        });
      }
      const usage = normalizeUsage(result.usage);
      if (config.kind === "subscription" && (!usage || ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every((value) => Number.isFinite(value) && value >= 0))) {
        throw new GenerationDispatchError("normalized usage is unavailable", {
          code: "attribution_unavailable", failureClass: "attribution-unavailable", failureActor: "vendor",
          remedy: "Use a subscription execution that reports enough model evidence to attribute the response.",
        });
      }
      const reportedModel = typeof result.model === "string" && result.model.trim() ? result.model.trim() : null;
      if (config.kind !== "subscription" && reportedModel !== request.model) {
        throw new GenerationDispatchError("provider-reported model does not match the requested model", {
          code: "model_mismatch", failureClass: "vendor-error", failureActor: "vendor",
          remedy: "Use an endpoint that binds and reports the exact requested model; silent substitution is rejected.",
        });
      }
      row.outcome = "success";
      for (const chunk of attemptChunks) deps.onChunk?.(chunk);
      const response = {
        schema_version: SCHEMA_VERSION,
        text: result.text,
        provider: request.provider,
        model: request.model,
        model_reported: reportedModel ? "observed" : "none",
        requested_provider: request.provider,
        requested_model: request.model,
        finish_reason: result.finishReason ?? null,
        finishReason: result.providerStopSignals?.finishReason ?? null,
        incomplete_details: result.providerStopSignals?.incomplete_details ?? null,
        truncated_suspected: result.truncatedSuspected === true,
        usage,
        attempts: attempt,
      };
      Object.defineProperty(response, "receiptMeta", {
        enumerable: false,
        value: {
          attemptLog,
          successfulAttempt: attempt,
          lensId: request.lensId,
          maxCompletionTokens: request.maxCompletionTokens,
          modelReported: reportedModel ? "observed" : "none",
          truncatedSuspected: result.truncatedSuspected === true,
          providerStopSignals: result.providerStopSignals ?? { finish_reason: null, finishReason: null, incomplete_details: null },
          promptSource: request.promptSource,
          promptBytes: request.promptBytes,
        },
      });
      return response;
    } catch (caught) {
      const error = classifiedError(caught);
      error.message = safeError(error, secretValues);
      row.outcome = "failure";
      row.failureClass = error.failureClass;
      lastError = error;
      if (!retryableFailure(error) || attempt >= maximumAttempts) break;
      waitBeforeMs = Math.max(backoffMilliseconds(attempt), Number(error.retryAfterMs) || 0);
      if ((request.deadlineMs - now()) < waitBeforeMs) break;
    }
  }

  const error = lastError ?? new GenerationDispatchError("generation deadline expired before another attempt could start", {
    code: "timeout", failureClass: "no-output-timeout", failureActor: "caller",
    remedy: "Increase timeout_seconds or reduce max_retries so the plan fits the absolute deadline.",
  });
  error.attempts = Math.max(1, attemptLog.length);
  error.attemptLog = attemptLog;
  error.lensId = request.lensId;
  error.maxCompletionTokens = request.maxCompletionTokens;
  throw error;
}

function standardUsageFromRawReceipt(row) {
  return normalizeUsage(row?.vendorUsage);
}

export function createSubscriptionAdapter(runSubscription) {
  if (typeof runSubscription !== "function") throw new TypeError("runSubscription must be a function");
  return async (config, request, deps = {}) => {
    const root = mkdtempSync(join(tmpdir(), "second-opinion-generation-"));
    const brief = join(root, "brief.md");
    const out = join(root, "out.txt");
    const err = join(root, "err.txt");
    const receipt = join(root, "receipt.jsonl");
    // The adapter API keeps the two roles as different fields.  This tagged
    // serialization is the explicit compatibility boundary for CLIs that only
    // accept one stdin stream; it is not reported as native role support.
    writeFileSync(brief, `<system>\n${request.system}\n</system>\n\n<user>\n${request.user}\n</user>\n`, "utf8");
    try {
      const pendingChunks = [];
      const onStdoutChunk = (chunk) => pendingChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      const exit = await runSubscription({
        vendor: config.provider,
        operation: "text",
        mode: "default",
        brief,
        cwd: root,
        modelRequested: config.model,
        model: config.model,
        lensId: request.lensId,
        completionTokenLimit: { requested: request.maxCompletionTokens, status: "not-applicable-cli" },
        effort: config.provider === "codex" ? (deps.env?.CODEX_EFFORT || process.env.CODEX_EFFORT || undefined) : undefined,
        inputs: [],
        timeout: request.timeoutSeconds,
        killGraceMs: 0,
        reapMs: 0,
        out,
        err,
        dryRun: false,
      }, {
        env: { ...(deps.env ?? process.env) },
        receiptSinks: deps.receiptSinks,
        internalReceiptPath: receipt,
        stdout: { write: () => true },
        stderr: deps.stderr,
        onStdoutChunk,
      });
      if (exit !== 0) {
        throw new GenerationDispatchError(`${config.provider} adapter failed (exit=${exit})`, exit === 124 ? {
          retryable: true,
          code: "read_timeout",
          failureClass: "no-output-timeout",
          failureActor: "caller",
          remedy: "Increase timeout_seconds or split the subscription request into smaller work.",
        } : {
          code: "subscription_failed",
          failureClass: "unclassified",
          failureActor: "caller",
          remedy: "Inspect the configured stderr sink; no diagnosis was inferred.",
        });
      }
      const text = readFileSync(out, "utf8");
      if (!text.trim()) throw emptyResponseFailure(
        `${config.provider} adapter returned no text`,
        "The provider returned no usable text; inspect the saved stderr and retry the same provider after backoff.",
      );
      const rows = readFileSync(receipt, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const row = rows.at(-1);
      const usage = standardUsageFromRawReceipt(row);
      if (!usage) {
        throw new GenerationDispatchError(`${config.provider} usage was not available from its dispatch receipt`, {
          code: "attribution_unavailable", failureClass: "attribution-unavailable", failureActor: "vendor",
          remedy: "Use a subscription execution that reports enough model evidence to attribute the response.",
        });
      }
      for (const chunk of pendingChunks) deps.onChunk?.(chunk);
      return {
        text,
        model: null,
        usage,
        finishReason: "stop",
        truncatedSuspected: false,
        providerStopSignals: { finish_reason: null, finishReason: null, incomplete_details: null },
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export async function executeGenerationCli(argv, deps = {}) {
  const startedAt = Date.now();
  const stderr = deps.stderr ?? process.stderr;
  const validationFailure = (message, responsePath = null) => {
    const payload = {
      error: "invalid_request",
      message,
      failureClass: "bad-invocation",
      failureActor: "caller",
      remedy: "Correct the generation CLI paths or request JSON and retry.",
      stderr: null,
      attempts: 1,
    };
    if (responsePath) {
      try { writeResponseAtomically(responsePath, `${JSON.stringify(payload)}\n`); } catch { /* stderr remains authoritative */ }
    }
    stderr.write(`dispatch validation error: ${message} class=${payload.failureClass} actor=${payload.failureActor} remedy=${payload.remedy}\n`);
    return 2;
  };
  if (argv.length !== 4 || argv[0] !== "--request-json" || argv[2] !== "--response-json") {
    return validationFailure("generation mode requires --request-json <file> --response-json <file>");
  }
  const requestPath = resolve(argv[1]);
  const responsePath = resolve(argv[3]);
  const env = deps.env ?? process.env;
  const receiptSinks = deps.receiptSinks ?? resolveReceiptSinks(env, deps.receiptConfigPath);
  const preliminaryPathError = generationPathConfigError({ requestPath, responsePath }, env, receiptSinks);
  if (preliminaryPathError) {
    return validationFailure(preliminaryPathError);
  }
  let request;
  try { request = JSON.parse(readFileSync(requestPath, "utf8")); }
  catch (error) {
    return validationFailure(`unable to read request JSON (${error.code ?? "invalid_json"})`, responsePath);
  }
  const pathError = generationPathConfigError({
    requestPath,
    responsePath,
    envFile: request?.env_file ? resolve(String(request.env_file)) : undefined,
  }, env, receiptSinks);
  if (pathError) {
    return validationFailure(pathError);
  }
  try {
    const result = await dispatchGeneration(request, {
      ...deps,
      receiptSinks,
      subscriptionAdapter: deps.subscriptionAdapter
        ?? (typeof deps.runSubscription === "function" ? createSubscriptionAdapter(deps.runSubscription) : undefined),
      onChunk: request.stream === true ? (chunk) => (deps.stdout ?? process.stdout).write(`${JSON.stringify({ type: "chunk", text: chunk })}\n`) : undefined,
    });
    writeResponseAtomically(responsePath, `${JSON.stringify(result)}\n`);
    if (HTTP_PROVIDERS[request?.provider]) {
      writeApiDispatchReceipts(stderr, {
        provider: request.provider,
        model: request.model,
        lensId: result.receiptMeta?.lensId ?? null,
        attempts: result.attempts,
        attemptLog: result.receiptMeta?.attemptLog ?? [],
        successfulAttempt: result.receiptMeta?.successfulAttempt ?? result.attempts,
        maxCompletionTokens: result.receiptMeta?.maxCompletionTokens ?? request.max_completion_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
        responsePath,
        usage: result.usage,
        modelReported: result.receiptMeta?.modelReported ?? result.model_reported,
        truncatedSuspected: result.receiptMeta?.truncatedSuspected ?? result.truncated_suspected,
        providerStopSignals: result.receiptMeta?.providerStopSignals,
        promptSource: result.receiptMeta?.promptSource ?? request.prompt_source ?? null,
        promptBytes: result.receiptMeta?.promptBytes ?? null,
      }, 0, startedAt, loadProviderEnvironment(request?.env_file ? String(request.env_file) : null, env), receiptSinks);
    }
    return 0;
  } catch (error) {
    let secrets = [], loaded = env;
    try {
      loaded = loadProviderEnvironment(request?.env_file ? String(request.env_file) : null, env);
      secrets = Object.values(HTTP_PROVIDERS).map((definition) => String(loaded[definition.key] ?? "").trim()).filter(Boolean);
    } catch { /* primary error remains authoritative */ }
    const payload = {
      error: error?.code ?? "dispatch_failed",
      message: safeError(error, secrets),
      failureClass: error?.failureClass ?? "unclassified",
      failureActor: error?.failureActor ?? "caller",
      remedy: error?.remedy ?? "Inspect process stderr; no diagnosis was inferred.",
      stderr: (error?.failureClass ?? "unclassified") === "unclassified" ? "process-stderr" : null,
      attempts: Math.max(1, Number(error?.attempts) || 1),
      statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : null,
    };
    try { writeResponseAtomically(responsePath, `${JSON.stringify(payload)}\n`); } catch { /* primary error wins */ }
    stderr.write(`dispatch generation failed: ${payload.error}: ${payload.message} class=${payload.failureClass} actor=${payload.failureActor} remedy=${payload.remedy}\n`);
    const exit = error?.code === "invalid_request" ? 2 : 4;
    if (HTTP_PROVIDERS[request?.provider]) {
      writeApiDispatchReceipts(stderr, {
        provider: request.provider,
        model: request.model,
        lensId: error?.lensId ?? request?.lens_id ?? null,
        attempts: payload.attempts,
        attemptLog: error?.attemptLog ?? [],
        successfulAttempt: null,
        maxCompletionTokens: error?.maxCompletionTokens ?? request?.max_completion_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
        responsePath,
        usage: null,
        failureClass: payload.failureClass,
        failureActor: payload.failureActor,
        remedy: payload.remedy,
        modelReported: "none",
        truncatedSuspected: null,
        providerStopSignals: { finish_reason: null, finishReason: null, incomplete_details: null },
        promptSource: request?.prompt_source ?? null,
        promptBytes: request && typeof request.user === "string"
          ? Buffer.byteLength(`${request.system == null ? "" : String(request.system)}${request.user}`, "utf8")
          : null,
      }, exit, startedAt, loaded, receiptSinks);
    }
    return exit;
  }
}

function writeResponseAtomically(target, data) {
  const temporaryRoot = mkdtempSync(join(dirname(target), ".second-opinion-generation-response-"));
  const temporary = join(temporaryRoot, "response.json");
  try {
    writeFileSync(temporary, data, "utf8");
    renameSync(temporary, target);
  } finally {
    try { rmSync(temporaryRoot, { recursive: true, force: true }); } catch { /* atomic replacement already won or failed */ }
  }
}
