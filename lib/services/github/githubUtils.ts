/**
 * Generic GitHub REST utilities.
 * Designed to be reused by Repositories, Pull Requests, Issues, and Commits services.
 */

// ──────────────────────────────────────────────
//  Pagination (Link header)
// ──────────────────────────────────────────────

export interface PaginationInfo {
  next: string | null;
  prev: string | null;
  first: string | null;
  last: string | null;
  /** True when a `next` page exists. */
  hasNext: boolean;
}

/**
 * Parse GitHub's `Link` header into a structured pagination object.
 * GitHub formats it as: <https://api.github.com/...?page=2>; rel="next", ...
 * Returns all-null fields when the header is absent.
 */
export function parsePagination(linkHeader: string | null | undefined): PaginationInfo {
  const empty: PaginationInfo = { next: null, prev: null, first: null, last: null, hasNext: false };
  if (!linkHeader) return empty;

  const result: PaginationInfo = { ...empty };
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (!match) continue;
    const url = match[1];
    const rel = match[2];
    if (rel === "next") result.next = url;
    else if (rel === "prev") result.prev = url;
    else if (rel === "first") result.first = url;
    else if (rel === "last") result.last = url;
  }
  result.hasNext = !!result.next;
  return result;
}

// ──────────────────────────────────────────────
//  Rate limits (X-RateLimit-* headers)
// ──────────────────────────────────────────────

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  /** ISO timestamp when the rate limit window resets. */
  resetAt: string | null;
}

/**
 * Parse GitHub rate-limit headers into a structured object.
 * Headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used,
 * X-RateLimit-Reset (unix epoch seconds).
 */
export function parseRateLimit(headers: Headers): RateLimitInfo {
  const toInt = (v: string | null): number | null => {
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  };

  const reset = toInt(headers.get("x-ratelimit-reset"));

  return {
    limit: toInt(headers.get("x-ratelimit-limit")),
    remaining: toInt(headers.get("x-ratelimit-remaining")),
    used: toInt(headers.get("x-ratelimit-used")),
    resetAt: reset ? new Date(reset * 1000).toISOString() : null,
  };
}

// ──────────────────────────────────────────────
//  Repository owner / name extraction
// ──────────────────────────────────────────────

/**
 * Extract the repository owner from a full URL ("https://github.com/owner/repo"),
 * a "owner/repo" string, or a bare "owner".
 * Returns null when it cannot be determined.
 */
export function extractRepositoryOwner(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full URL form
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "github.com" && !url.hostname.endsWith(".github.com")) return null;
      const segments = url.pathname.split("/").filter(Boolean);
      return segments[0] ?? null;
    } catch {
      return null;
    }
  }

  // "owner/repo" or bare "owner"
  const segments = trimmed.split("/").filter(Boolean);
  return segments[0] ?? null;
}

/**
 * Extract the repository name from a full URL ("https://github.com/owner/repo")
 * or a "owner/repo" string.
 * Returns null when it cannot be determined.
 */
export function extractRepositoryName(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full URL form
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "github.com" && !url.hostname.endsWith(".github.com")) return null;
      const segments = url.pathname.split("/").filter(Boolean);
      return segments[1] ?? null;
    } catch {
      return null;
    }
  }

  // "owner/repo" string
  const segments = trimmed.split("/").filter(Boolean);
  return segments.length >= 2 ? segments[1] : null;
}

// ──────────────────────────────────────────────
//  Search query builder
// ──────────────────────────────────────────────

export interface SearchQueryParams {
  /** Free-text search term. */
  term?: string;
  /** Repository qualifier, e.g. "owner/repo". */
  repo?: string;
  /** Search type qualifier, e.g. "issue", "pr", "commit", "code", "repository". */
  type?: string;
  /** State qualifier: "open", "closed", or "all". */
  state?: string;
  /** Author qualifier (login). */
  author?: string;
  /** Assignee qualifier (login). */
  assignee?: string;
  /** Labels qualifiers. */
  labels?: string[];
  /** Any additional qualifier key/value pairs, e.g. { is: "pr" }. */
  extra?: Record<string, string>;
}

/**
 * Build a GitHub search query string from structured params.
 * Values are space-joined per the GitHub search syntax: `term repo:x state:y`.
 */
export function buildSearchQuery(params: SearchQueryParams): string {
  const parts: string[] = [];

  if (params.term) parts.push(params.term);
  if (params.repo) parts.push(`repo:${params.repo}`);
  if (params.type) parts.push(`type:${params.type}`);
  if (params.state) parts.push(`state:${params.state}`);
  if (params.author) parts.push(`author:${params.author}`);
  if (params.assignee) parts.push(`assignee:${params.assignee}`);
  if (params.labels && params.labels.length > 0) {
    params.labels.forEach((label) => parts.push(`label:${label}`));
  }
  if (params.extra) {
    Object.entries(params.extra).forEach(([key, value]) => parts.push(`${key}:${value}`));
  }

  return parts.join(" ");
}

export default {
  parsePagination,
  parseRateLimit,
  extractRepositoryOwner,
  extractRepositoryName,
  buildSearchQuery,
};
