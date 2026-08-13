/**
 * AI layer — server-only Groq client.
 *
 * The single place the application talks to Groq:
 *
 * - Reads `GROQ_API_KEY` from environment variables (NEVER exposed to the
 *   frontend, never logged, never included in tool results).
 * - Centralizes the model configuration (`GROQ_MODEL` override, defaulting
 *   to a currently supported Groq model) and generation settings.
 * - Uses the OpenAI-compatible chat completions endpoint
 *   (`https://api.groq.com/openai/v1/chat/completions`) directly via the
 *   shared `fetch` primitive — no extra SDK dependency, mirroring the
 *   existing Google/GitHub/Discord/Telegram HTTP layers.
 * - Maps failures to the project's `AppError`/`AIError` conventions.
 *
 * This module is server-only by design: it reads `process.env` and must
 * never be imported from client components or bundled into client code.
 */

import { AIError, AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

// ──────────────────────────────────────────────
//  Diagnostic instrumentation (DEBUG_GROQ=true)
//  Temporary — logs request/prompt/response details only. No behavior change.
// ──────────────────────────────────────────────

/** Master switch: `DEBUG_GROQ=true` enables the diagnostic logs below. */
const DEBUG_GROQ = process.env.DEBUG_GROQ === "true";

/** Emit one diagnostic line when DEBUG_GROQ is enabled. */
function groqDebug(fields: Record<string, unknown>): void {
  if (!DEBUG_GROQ) return;
  logger.info("[groq-debug]", fields);
}

/** Per-request id (UUID when available). */
function newRequestId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    /* fall through */
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Rough prompt-token estimate — no tokenizer exists in this repo (chars/4 heuristic). */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Best-effort extraction of injected integration data (array lengths) from a
 * user message that embeds `Tool data (JSON): …`. Never logs content.
 */
function describeInjectedData(userContent: string): Record<string, unknown> | null {
  const marker = "Tool data (JSON):";
  const idx = userContent.indexOf(marker);
  if (idx === -1) return null;
  try {
    const parsed: unknown = JSON.parse(userContent.slice(idx + marker.length).trim());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (Array.isArray(v)) out[`${k} (array length)`] = v.length;
      else if (v !== null && typeof v === "object") out[k] = "(object)";
      else out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** Classify a Groq failure for the diagnostic log. */
function classifyGroqStatus(status: number | null | undefined, bodyText: string): string {
  if (status === 401) return "Authentication";
  if (status === 403) return "Authorization";
  if (status === 404) return "Invalid Model";
  if (status === 408) return "Timeout";
  if (status === 429) {
    const b = bodyText.toLowerCase();
    if (b.includes("token")) return "Token Rate Limit";
    if (b.includes("request") && b.includes("rate")) return "Request Rate Limit";
    return "Rate Limit (see body)";
  }
  if (status === 400) {
    const b = bodyText.toLowerCase();
    if (b.includes("json")) return "Invalid JSON";
    if (b.includes("context_length") || b.includes("context length") || b.includes("too long") || b.includes("prompt")) {
      return "Prompt Too Long";
    }
    if (b.includes("large")) return "Request Too Large";
    return "Bad Request (see body)";
  }
  if (status !== null && status !== undefined && status >= 500) return "Provider Internal Error";
  if (status === null || status === undefined) return "Timeout / Network";
  return "Unknown";
}

/** All rate-limit related response headers, or "missing" when absent. */
function rateLimitHeaderLog(res: Response): Record<string, unknown> {
  const names = [
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
    "retry-after",
  ];
  const out: Record<string, unknown> = {};
  for (const name of names) {
    out[name] = res.headers.get(name) ?? "missing";
  }
  return out;
}

/** Groq OpenAI-compatible chat completions endpoint. */
export const GROQ_CHAT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Default model. `llama-3.3-70b-versatile` is a long-supported Groq model
 * (see https://console.groq.com/docs/models); `GROQ_MODEL` overrides it.
 */
export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

/** Default maximum tokens for a generated response. */
export const DEFAULT_GROQ_MAX_TOKENS = 600;

/** Request timeout for a single Groq call. */
export const GROQ_TIMEOUT_MS = 30_000;

// ──────────────────────────────────────────────
//  Configuration
// ──────────────────────────────────────────────

/** The Groq API key from the environment (never serialized anywhere). */
export function getGroqApiKey(): string | undefined {
  return process.env.GROQ_API_KEY;
}

/** Whether a non-empty Groq API key is configured. */
export function isGroqConfigured(): boolean {
  const key = getGroqApiKey();
  return typeof key === "string" && key.trim().length > 0;
}

/** The configured model id (`GROQ_MODEL` override, else the default). */
export function getGroqModel(): string {
  const configured = process.env.GROQ_MODEL;
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_GROQ_MODEL;
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

/** A single chat message sent to Groq. */
export interface GroqChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options accepted by {@link GroqClient.complete}. */
export interface GroqCompletionOptions {
  /** The chat messages, oldest first. */
  messages: readonly GroqChatMessage[];
  /** Sampling temperature (defaults to 0.3 for deterministic summaries). */
  temperature?: number;
  /** Maximum output tokens (defaults to {@link DEFAULT_GROQ_MAX_TOKENS}). */
  maxTokens?: number;
  /** When true, requests `response_format: { type: "json_object" }`. */
  jsonMode?: boolean;
}

/** A successful Groq completion. */
export interface GroqCompletion {
  /** The generated text content. */
  text: string;
  /** The model id that produced the completion. */
  model: string;
  /** Token usage, when reported by the API. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * The minimal client contract consumed by the tool layer / orchestrator.
 * Injectable so tests can substitute a stub — production code uses
 * {@link productionGroqClient}.
 */
export interface GroqClient {
  complete(options: GroqCompletionOptions): Promise<GroqCompletion>;
}

// ──────────────────────────────────────────────
//  Error mapping
// ──────────────────────────────────────────────

/**
 * Map a Groq HTTP error response to the project's `AppError` conventions.
 * Never includes the API key or the raw Authorization header.
 */
export function mapGroqError(status: number | null | undefined, body?: unknown): AppError {
  const message = extractErrorMessage(body) ?? "Groq API error";
  if (status === null || status === undefined) {
    return new AppError(message, 502, "groq_error");
  }
  // 401 = the API key itself is rejected. Keep this message precise so a real
  // key problem is never hidden behind a generic provider message.
  if (status === 401) {
    return new AppError("Groq authentication failed — check GROQ_API_KEY", 502, "groq_authentication_error");
  }
  // 403 = the key authenticated, but the request was refused for a
  // permission reason (e.g. a model blocked at the project level, an
  // org/region restriction). Surface the provider's exact message instead of
  // mislabeling it as an authentication failure.
  if (status === 403) {
    return new AppError(message, 502, "groq_permission_error");
  }
  if (status === 429) {
    return new AppError("Groq rate limit exceeded", 429, "rate_limited");
  }
  if (status >= 500 && status < 600) {
    return new AppError(message, 502, "groq_server_error");
  }
  return new AppError(message, 502, "groq_error");
}

/** Best-effort extraction of a human-readable message from an API error body. */
function extractErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error !== null && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message;
  }
  return null;
}

// ──────────────────────────────────────────────
//  Client
// ──────────────────────────────────────────────

/**
 * Production Groq client. Resolves the API key + model from the environment
 * and calls the chat completions endpoint.
 *
 * The key is held only in memory for the duration of the request and is
 * never logged, returned, or serialized.
 */
export class GroqService implements GroqClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.apiKey = options.apiKey ?? getGroqApiKey() ?? "";
    this.model = options.model ?? getGroqModel();
  }

  /**
   * Run a chat completion. Throws:
   * - `AppError` (503, `ai_not_configured`) when no API key is configured.
   * - `AppError` (mapped) when Groq returns a non-OK status.
   * - `AIError` when the response body is malformed or empty.
   */
  async complete(options: GroqCompletionOptions): Promise<GroqCompletion> {
    const key = this.apiKey.trim();
    if (!key) {
      logger.warn("Groq: GROQ_API_KEY is not configured on the server");
      throw new AppError("AI service is not configured (GROQ_API_KEY missing)", 503, "ai_not_configured");
    }

    const requestId = newRequestId();
    const startedAt = Date.now();
    const messages = options.messages;
    const perMessage = messages.map((m) => ({ role: m.role, chars: m.content.length }));
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const injectedData = messages
      .filter((m) => m.role === "user")
      .map((m) => describeInjectedData(m.content))
      .filter((d): d is Record<string, unknown> => d !== null);

    // 1) Request metadata + 2) prompt size + 3) injected data counts.
    groqDebug({
      event: "request",
      requestId,
      endpoint: GROQ_CHAT_ENDPOINT,
      method: "POST",
      model: this.model,
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens ?? DEFAULT_GROQ_MAX_TOKENS,
      stream: false,
      jsonMode: options.jsonMode === true,
      authorization: "Bearer ****", // never the key
      messageCount: messages.length,
      perMessage,
      totalChars,
      estimatedPromptTokens: estimateTokens(totalChars),
      injectedData: injectedData.length > 0 ? injectedData : undefined,
    });

    const body: Record<string, unknown> = {
      model: this.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? DEFAULT_GROQ_MAX_TOKENS,
    };
    if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const payloadJson = JSON.stringify(body);
    groqDebug({
      event: "payload",
      requestId,
      payloadChars: payloadJson.length,
      payloadBytes: new TextEncoder().encode(payloadJson).length,
    });

    let res: Response;
    try {
      res = await fetch(GROQ_CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: payloadJson,
        signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      groqDebug({
        event: "response",
        requestId,
        httpStatus: null,
        durationMs: Date.now() - startedAt,
        classification: "Timeout / Network",
        error: detail,
      });
      logger.warn("Groq: request failed", { error: detail });
      throw new AppError("Groq request failed", 502, "groq_error", detail);
    }

    const durationMs = Date.now() - startedAt;
    const rateLimitHeaders = rateLimitHeaderLog(res);

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        bodyText = "";
      }
      // 6-9) Status + rate-limit headers + full raw body + timing + classification.
      // Full body is logged for error responses only (Groq error bodies never
      // contain the key); success bodies are summarized to avoid echoing data.
      groqDebug({
        event: "response",
        requestId,
        httpStatus: res.status,
        durationMs,
        rateLimitHeaders,
        rawBody: bodyText,
        classification: classifyGroqStatus(res.status, bodyText),
      });
      // Log the exact provider response (status + redacted body) before
      // mapping, so the real failure reason is never lost. Never log the key.
      logger.warn("Groq: non-OK response", {
        status: res.status,
        bodyPreview: bodyText.slice(0, 500),
      });
      let parsed: unknown;
      try {
        parsed = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        parsed = null;
      }
      throw mapGroqError(res.status, parsed);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      groqDebug({
        event: "response",
        requestId,
        httpStatus: res.status,
        durationMs,
        classification: "Unknown (malformed JSON body)",
        error: String(err),
      });
      logger.warn("Groq: malformed response body", { error: String(err) });
      throw new AIError("Malformed Groq response: invalid JSON body");
    }

    const content = extractContent(payload);
    if (typeof content !== "string" || content.trim().length === 0) {
      groqDebug({
        event: "response",
        requestId,
        httpStatus: res.status,
        durationMs,
        classification: "Unknown (empty content)",
      });
      logger.warn("Groq: response contained no content");
      throw new AIError("Malformed Groq response: empty content");
    }

    groqDebug({
      event: "response",
      requestId,
      httpStatus: res.status,
      durationMs,
      rateLimitHeaders,
      classification: "Success",
      contentChars: content.length,
      usage: extractUsage(payload) ?? undefined,
    });

    return {
      text: content,
      model: extractModel(payload) ?? this.model,
      usage: extractUsage(payload),
    };
  }
}

/** Extract the generated text from a chat completions payload. */
function extractContent(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message;
  if (message === null || typeof message !== "object") return null;
  return (message as Record<string, unknown>).content;
}

/** Extract the model id from a chat completions payload. */
function extractModel(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const model = (payload as Record<string, unknown>).model;
  return typeof model === "string" ? model : undefined;
}

/** Extract token usage from a chat completions payload. */
function extractUsage(payload: unknown): GroqCompletion["usage"] {
  if (payload === null || typeof payload !== "object") return undefined;
  const usage = (payload as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined;
  return {
    promptTokens: toNumber(record.prompt_tokens),
    completionTokens: toNumber(record.completion_tokens),
    totalTokens: toNumber(record.total_tokens),
  };
}

// ──────────────────────────────────────────────
//  Convenience helpers
// ──────────────────────────────────────────────

/**
 * Run a completion and return the raw text.
 * Re-exported so callers can use either the client or the convenience layer.
 */
export async function groqComplete(
  client: GroqClient,
  options: GroqCompletionOptions,
): Promise<GroqCompletion> {
  return client.complete(options);
}

/**
 * Run a completion in JSON mode and return the parsed JSON object.
 * Throws `AIError` when the model output is not valid JSON.
 */
export async function groqCompleteJson(
  client: GroqClient,
  options: Omit<GroqCompletionOptions, "jsonMode">,
): Promise<Record<string, unknown>> {
  const completion = await client.complete({ ...options, jsonMode: true });
  const text = completion.text.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    logger.warn("Groq: JSON mode returned invalid JSON", { preview: text.slice(0, 120) });
    throw new AIError("Malformed Groq response: invalid JSON");
  }
}

/** The application's single production Groq client. */
export const productionGroqClient: GroqClient = new GroqService();

export default productionGroqClient;
