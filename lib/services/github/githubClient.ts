import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { safeFetch } from "@/lib/services/google-http";
import githubTokenManager from "@/lib/services/integrations/githubTokenManager";
import { mapGitHubError } from "./githubErrors";
import { parsePagination, parseRateLimit } from "./githubUtils";
import type { PaginationInfo, RateLimitInfo } from "./githubUtils";

const BASE = "https://api.github.com";

/**
 * Structured log meta with the platform tag, mirroring the google-logger style.
 */
function logMeta(meta?: Record<string, unknown>) {
  return { platform: "github", ...(meta ?? {}) };
}

export interface GitHubRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | null | undefined>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface GitHubResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
  pagination: PaginationInfo;
  rateLimit: RateLimitInfo;
}

/**
 * Reusable GitHub REST API client.
 *
 * Responsibilities:
 * - Resolves a valid access token via GitHubTokenManager (read access token)
 * - Builds the Authorization header
 * - Calls the GitHub REST API through the shared safeFetch() utility
 *   (timeout handling + transient retry logic are reused, not duplicated)
 * - Maps non-OK responses to AppError via mapGitHubError()
 * - Provides pagination via the Link header
 *
 * Generic by design so it can be reused by Repositories, Pull Requests,
 * Issues, and Commits services.
 */
export class GitHubClient {
  private readonly integrationId: string;

  constructor(integrationId: string) {
    this.integrationId = integrationId;
  }

  /**
   * Build the standard GitHub REST headers for a given access token.
   * Exposed separately so callers can inspect/extend the default header set.
   */
  buildHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  /**
   * Resolve a valid access token for this client's integration.
   * Delegates to GitHubTokenManager.getValidAccessToken().
   */
  private async resolveAccessToken(): Promise<string> {
    const token = await githubTokenManager.getValidAccessToken(this.integrationId);
    if (!token?.accessToken) {
      logger.warn("GitHub: access token unavailable", logMeta({ integrationId: this.integrationId }));
      throw new AppError("GitHub access token unavailable", 401, "authentication_required");
    }
    return token.accessToken;
  }

  /**
   * Core request method: resolves the token, calls safeFetch(), and maps errors.
   * Returns a structured response including pagination + rate-limit info.
   */
  async authenticatedFetch<T = unknown>(path: string, opts: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    const accessToken = await this.resolveAccessToken();

    // GitHub's Link header returns absolute next-page URLs (e.g.
    // https://api.github.com/...?page=2); accept both absolute and relative paths.
    const url = path.startsWith("http") ? new URL(path) : new URL(`${BASE}${path}`);
    if (opts.query) {
      Object.entries(opts.query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      });
    }

    const headers = { ...this.buildHeaders(accessToken), ...(opts.headers ?? {}) };
    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }

    logger.debug("GitHub: calling GitHub API", logMeta({ url: url.pathname, method: init.method }));

    const res = await safeFetch(
      url.toString(),
      init,
      logMeta({ url: url.pathname }),
      opts.timeoutMs ?? 10000,
      opts.maxRetries ?? 1
    );

    // Best-effort JSON body parsing (GitHub returns JSON for errors too)
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
      throw mapGitHubError(res.status, data, res.headers);
    }

    return {
      data: data as T,
      status: res.status,
      headers: res.headers,
      pagination: parsePagination(res.headers.get("link")),
      rateLimit: parseRateLimit(res.headers),
    };
  }

  /** GET convenience wrapper. */
  async get<T = unknown>(path: string, opts: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    return this.authenticatedFetch<T>(path, { ...opts, method: "GET" });
  }

  /** POST convenience wrapper. */
  async post<T = unknown>(path: string, body?: unknown, opts: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    return this.authenticatedFetch<T>(path, { ...opts, method: "POST", body });
  }

  /**
   * Follow the Link-header `next` pages and collect all items, up to maxPages.
   * Sets per_page=100 to minimize round trips.
   */
  async paginate<T = unknown>(path: string, opts: GitHubRequestOptions = {}, maxPages = 10): Promise<T[]> {
    const results: T[] = [];
    let page = 0;
    let nextUrl: string | null = path;

    while (nextUrl && page < maxPages) {
      page += 1;
      // Use the URL API so per_page is set/replaced rather than duplicated when
      // following a next link that already echoes per_page from the Link header.
      const url = nextUrl.startsWith("http") ? new URL(nextUrl) : new URL(`${BASE}${nextUrl}`);
      url.searchParams.set("per_page", "100");
      const res = await this.get<unknown[]>(url.pathname + url.search, { ...opts, query: undefined });
      if (Array.isArray(res.data)) results.push(...(res.data as T[]));
      const pagination = parsePagination(res.headers.get("link"));
      nextUrl = pagination.hasNext ? pagination.next : null;
    }

    return results;
  }
}

export default GitHubClient;
