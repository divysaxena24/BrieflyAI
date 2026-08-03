import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { safeFetch } from "@/lib/services/google-http";
import telegramTokenManager from "@/lib/services/integrations/telegramTokenManager";
import { mapTelegramError } from "./telegramErrors";
import { buildBotUrl } from "./telegramUtils";

/**
 * Structured log meta with the platform tag, mirroring the google-logger style.
 */
function logMeta(meta?: Record<string, unknown>) {
  return { platform: "telegram", ...(meta ?? {}) };
}

export interface TelegramRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | null | undefined>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface TelegramResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
}

/**
 * Reusable Telegram Bot API client.
 *
 * Responsibilities:
 * - Resolves a valid bot token via TelegramTokenManager
 * - Builds the Bot API URL with the token in the PATH
 *   (https://api.telegram.org/bot<TOKEN>/<method> — no Authorization header)
 * - Calls the Bot API through the shared safeFetch() utility
 *   (timeout handling + transient retry logic are reused, not duplicated)
 * - Verifies the Telegram response envelope ({ ok: true, result } vs
 *   { ok: false, error_code, description }) — Telegram returns HTTP 200 even
 *   when ok === false, so the `ok` field must be checked, not just res.ok
 * - Maps failures to AppError via mapTelegramError()
 * - Unwraps the envelope so consumers receive `result` as data
 *
 * Generic by design so it can be reused by future Chats and Messages services.
 */
export class TelegramClient {
  private readonly integrationId: string;

  constructor(integrationId: string) {
    this.integrationId = integrationId;
  }

  /**
   * Build the standard Bot API headers. Telegram needs no Authorization header
   * — the token is embedded in the URL path by buildBotUrl().
   */
  buildHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  /**
   * Resolve a valid bot token for this client's integration.
   * Delegates to TelegramTokenManager.getValidAccessToken().
   */
  private async resolveBotToken(): Promise<string> {
    const token = await telegramTokenManager.getValidAccessToken(this.integrationId);
    if (!token?.accessToken) {
      logger.warn("Telegram: bot token unavailable", logMeta({ integrationId: this.integrationId }));
      throw new AppError("Telegram bot token unavailable", 401, "authentication_required");
    }
    return token.accessToken;
  }

  /**
   * Core request method: resolves the token, calls safeFetch(), verifies the
   * Telegram envelope, and maps errors. Returns { data, status, headers }.
   * `path` is the Bot API method name (e.g. "getMe", "getChat") or an absolute URL.
   */
  async authenticatedFetch<T = unknown>(path: string, opts: TelegramRequestOptions = {}): Promise<TelegramResponse<T>> {
    const token = await this.resolveBotToken();

    // The token belongs in the URL path — buildBotUrl() embeds it.
    const url = path.startsWith("http") ? new URL(path) : new URL(buildBotUrl(token, path));
    if (opts.query) {
      Object.entries(opts.query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      });
    }

    const headers = { ...this.buildHeaders(), ...(opts.headers ?? {}) };
    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }

    logger.debug("Telegram: calling Bot API", logMeta({ url: url.pathname, method: init.method }));

    const res = await safeFetch(
      url.toString(),
      init,
      logMeta({ url: url.pathname }),
      opts.timeoutMs ?? 10000,
      opts.maxRetries ?? 1
    );

    // Best-effort JSON body parsing (Telegram returns JSON for errors too)
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    // Telegram envelope: { ok: true, result } or { ok: false, error_code, description }.
    // IMPORTANT: Telegram usually returns HTTP 200 even when ok === false — the
    // `ok` field must be checked, not just res.ok.
    const envelope = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const ok = envelope && typeof envelope.ok === "boolean" ? envelope.ok : null;

    if (!res.ok || ok === false) {
      throw mapTelegramError(res.status, data, res.headers);
    }

    // Unwrap the envelope: consumers receive `result` as data.
    return {
      data: (envelope?.result as T) ?? (data as T),
      status: res.status,
      headers: res.headers,
    };
  }

  /** GET convenience wrapper. */
  async get<T = unknown>(path: string, opts: TelegramRequestOptions = {}): Promise<TelegramResponse<T>> {
    return this.authenticatedFetch<T>(path, { ...opts, method: "GET" });
  }

  /** POST convenience wrapper. */
  async post<T = unknown>(path: string, body?: unknown, opts: TelegramRequestOptions = {}): Promise<TelegramResponse<T>> {
    return this.authenticatedFetch<T>(path, { ...opts, method: "POST", body });
  }
}

export default TelegramClient;
