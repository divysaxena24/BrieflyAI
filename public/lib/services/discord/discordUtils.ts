/**
 * Generic Discord REST utilities.
 * Designed to be reused by future Guilds, Channels, and Messages services.
 */

// ──────────────────────────────────────────────
//  Rate limits (X-RateLimit-* headers)
// ──────────────────────────────────────────────

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Epoch (unix seconds) when the rate limit window resets. */
  reset: number | null;
  /** Seconds until the rate limit window resets (from X-RateLimit-Reset-After). */
  resetAfter: number | null;
  /** Rate limit bucket id (X-RateLimit-Bucket). */
  bucket: string | null;
}

/**
 * Parse Discord rate-limit headers into a structured object.
 * Headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset,
 * X-RateLimit-Reset-After, X-RateLimit-Bucket.
 * Unlike GitHub, Discord signals rate limits with HTTP 429 (not 403), and the
 * reset is given as epoch seconds with an explicit "reset after" duration.
 */
export function parseRateLimit(headers: Headers): RateLimitInfo {
  const toFloat = (v: string | null): number | null => {
    if (!v) return null;
    const n = Number.parseFloat(v);
    return Number.isNaN(n) ? null : n;
  };

  return {
    limit: toFloat(headers.get("x-ratelimit-limit")),
    remaining: toFloat(headers.get("x-ratelimit-remaining")),
    reset: toFloat(headers.get("x-ratelimit-reset")),
    resetAfter: toFloat(headers.get("x-ratelimit-reset-after")),
    bucket: headers.get("x-ratelimit-bucket"),
  };
}

// ──────────────────────────────────────────────
//  Query string builder
// ──────────────────────────────────────────────

/**
 * Build a URL query string from structured params, skipping null/undefined
 * values. Used to append pagination/filter params (e.g. before, after, limit)
 * to Discord REST paths.
 */
export function buildQueryString(
  params?: Record<string, string | number | null | undefined>
): string {
  if (!params) return "";
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    searchParams.set(key, String(value));
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : "";
}

// ──────────────────────────────────────────────
//  Guild / channel id extraction
// ──────────────────────────────────────────────

/**
 * Extract the guild (server) id from a Discord URL
 * ("https://discord.com/channels/{guildId}/{channelId}"), a bare guild id,
 * or a "guildId/channelId" string.
 * Returns null when it cannot be determined.
 */
export function extractGuildId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full URL form
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "discord.com" && !url.hostname.endsWith(".discord.com")) return null;
      // /channels/{guildId}/{channelId}
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments[0] === "channels" && segments[1]) return segments[1];
      return null;
    } catch {
      return null;
    }
  }

  // "guildId/channelId" or bare guild id
  const segments = trimmed.split("/").filter(Boolean);
  return segments[0] ?? null;
}

/**
 * Extract the channel id from a Discord URL
 * ("https://discord.com/channels/{guildId}/{channelId}") or a bare channel id.
 * Returns null when it cannot be determined.
 */
export function extractChannelId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full URL form
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "discord.com" && !url.hostname.endsWith(".discord.com")) return null;
      // /channels/{guildId}/{channelId}
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments[0] === "channels" && segments[2]) return segments[2];
      return null;
    } catch {
      return null;
    }
  }

  // Bare channel id
  const segments = trimmed.split("/").filter(Boolean);
  return segments.length === 1 ? segments[0] : null;
}

export default {
  parseRateLimit,
  buildQueryString,
  extractGuildId,
  extractChannelId,
};
