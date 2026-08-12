import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { safeFetch } from "@/lib/services/google-http";
import discordTokenManager from "@/lib/services/integrations/discordTokenManager";
import { mapDiscordError } from "./discordErrors";
import { parseRateLimit, buildQueryString } from "./discordUtils";
import type { RateLimitInfo } from "./discordUtils";

const BASE = "https://discord.com/api/v10";

/**
 * Structured log meta with the platform tag, mirroring the google-logger style.
 */
function logMeta(meta?: Record<string, unknown>) {
  return { platform: "discord", ...(meta ?? {}) };
}

export interface DiscordRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | null | undefined>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface DiscordResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
  rateLimit: RateLimitInfo;
}

/**
 * Reusable Discord REST API client.
 *
 * Responsibilities:
 * - Resolves a valid access token via DiscordTokenManager (read access token)
 * - Builds the Authorization header
 * - Calls the Discord REST API through the shared safeFetch() utility
 *   (timeout handling + transient retry logic are reused, not duplicated)
 * - Maps non-OK responses to AppError via mapDiscordError()
 * - Exposes rate-limit info parsed from Discord's X-RateLimit-* headers
 *
 * Generic by design so it can be reused by future Guilds, Channels, and
 * Messages services. Discord paginates with cursor params (before/after/limit)
 * rather than Link headers, so no Link-based paginate() is needed here.
 */
export class DiscordClient {
  private readonly integrationId: string;

  constructor(integrationId: string) {
    this.integrationId = integrationId;
  }

  /**
   * Build the standard Discord REST headers for a given access token.
   * Exposed separately so callers can inspect/extend the default header set.
   */
  buildHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  /**
   * Resolve a valid access token for this client's integration.
   * Delegates to DiscordTokenManager.getValidAccessToken().
   */
  private async resolveAccessToken(): Promise<string> {
    const token = await discordTokenManager.getValidAccessToken(this.integrationId);
    if (!token?.accessToken) {
      logger.warn("Discord: access token unavailable", logMeta({ integrationId: this.integrationId }));
      throw new AppError("Discord access token unavailable", 401, "authentication_required");
    }
    return token.accessToken;
  }

  /**
   * Core request method: resolves the token, calls safeFetch(), and maps errors.
   * Returns a structured response including rate-limit info.
   *
   * Discord OAuth2 access tokens expire (~7 days). When Discord rejects the
   * stored token with a 401, the client refreshes the token once (the refresh
   * token is rotated + persisted by DiscordTokenManager) and retries the same
   * request before surfacing an error. This transparently recovers from a
   * stale/expired access token instead of failing the whole request.
   */
  async authenticatedFetch<T = unknown>(path: string, opts: DiscordRequestOptions = {}): Promise<DiscordResponse<T>> {
    const accessToken = await this.resolveAccessToken();

    // Accept both absolute and relative paths.
    const url = path.startsWith("http") ? new URL(path) : new URL(`${BASE}${path}`);
    if (opts.query) {
      const qs = buildQueryString(opts.query);
      if (qs) url.search = qs.replace(/^\?/, "");
    }

    const headers = { ...this.buildHeaders(accessToken), ...(opts.headers ?? {}) };
    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }

    logger.debug("Discord: calling Discord API", logMeta({ url: url.pathname, method: init.method }));

    let res = await safeFetch(
      url.toString(),
      init,
      logMeta({ url: url.pathname }),
      opts.timeoutMs ?? 10000,
      opts.maxRetries ?? 1
    );

    // A 401 means the access token is stale/expired — refresh once and retry.
    // If the refresh fails, the manager already marks the integration as
    // needing reconnection; surface that (more accurate) error instead of the
    // raw Discord "401: Unauthorized".
    if (res.status === 401) {
      try {
        const refreshed = await discordTokenManager.refreshToken(this.integrationId);
        if (refreshed?.access_token) {
          const retryHeaders = { ...this.buildHeaders(refreshed.access_token), ...(opts.headers ?? {}) };
          const retryInit: RequestInit = { ...init, headers: retryHeaders };
          res = await safeFetch(
            url.toString(),
            retryInit,
            logMeta({ url: url.pathname, retry: true }),
            opts.timeoutMs ?? 10000,
            opts.maxRetries ?? 1
          );
        }
      } catch (refreshErr) {
        // Refresh failed (missing/invalid refresh token, network, …). Rethrow
        // the AppError from the token manager — it carries a clean
        // "reconnect required" message and the integration is already marked
        // needs_reconnect where appropriate.
        if (refreshErr instanceof AppError) throw refreshErr;
      }
    }

    // Best-effort JSON body parsing (Discord returns JSON for errors too)
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      throw mapDiscordError(res.status, data, res.headers);
    }

    return {
      data: data as T,
      status: res.status,
      headers: res.headers,
      rateLimit: parseRateLimit(res.headers),
    };
  }

  /** GET convenience wrapper. */
  async get<T = unknown>(path: string, opts: DiscordRequestOptions = {}): Promise<DiscordResponse<T>> {
    return this.authenticatedFetch<T>(path, { ...opts, method: "GET" });
  }

  /** POST convenience wrapper. */
  async post<T = unknown>(path: string, body?: unknown, opts: DiscordRequestOptions = {}): Promise<DiscordResponse<T>> {
    return this.authenticatedFetch<T>(path, { ...opts, method: "POST", body });
  }
}

export default DiscordClient;
