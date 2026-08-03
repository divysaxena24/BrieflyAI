import { AppError } from "@/lib/errors";

/**
 * Extract the most useful message from a Discord error response body.
 * Discord error bodies follow the shape { message, code, errors? } where
 * `message` is human-readable and `code` is a Discord-specific numeric code.
 */
export function extractDiscordErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;

  const obj = body as Record<string, unknown>;
  const message = typeof obj.message === "string" ? obj.message : undefined;

  // Validation errors: { errors: { field: { _errors: [{ message, code }] } } }
  const errors = obj.errors;
  if (errors && typeof errors === "object") {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(errors as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const fieldErrors = (value as Record<string, unknown>)._errors;
      if (Array.isArray(fieldErrors)) {
        for (const fe of fieldErrors) {
          if (!fe || typeof fe !== "object") continue;
          const feObj = fe as Record<string, unknown>;
          if (typeof feObj.message === "string") parts.push(`${field}: ${feObj.message}`);
        }
      }
    }
    if (parts.length > 0) return parts.join("; ");
  }

  return message;
}

/**
 * Map a Discord REST API response to the application's AppError.
 * Uses the same error style as the rest of the codebase — no second framework.
 *
 * Discord specifics handled here:
 * - Rate limiting is signaled as HTTP 429 with a `Retry-After` header (seconds)
 *   and a `retry_after` field in the body — both are captured as details.
 * - Error messages live in the JSON body `message` field.
 * - Discord has no per-endpoint numeric status codes that map 1:1 to HTTP
 *   semantics, so we rely on the HTTP status + body message.
 */
export function mapDiscordError(status: number | null | undefined, body?: unknown, headers?: Headers | null): AppError {
  const dcMsg = extractDiscordErrorMessage(body);

  if (!status) return new AppError(dcMsg ?? "Discord API error", 502, "discord_error");

  switch (status) {
    case 400:
      return new AppError(dcMsg ?? "Bad request", 400, "bad_request");
    case 401:
      return new AppError(dcMsg ?? "Authentication required", 401, "authentication_required");
    case 403:
      return new AppError(dcMsg ?? "Permission denied", 403, "permission_denied");
    case 404:
      return new AppError(dcMsg ?? "Not found", 404, "not_found");
    case 429: {
      // Discord rate limit: capture Retry-After (seconds, may be fractional)
      const retryAfter = headers?.get("retry-after");
      const bodyObj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
      const bodyRetryAfter = bodyObj && typeof bodyObj.retry_after === "number" ? String(bodyObj.retry_after) : undefined;
      return new AppError(
        dcMsg ?? "Rate limited by Discord",
        429,
        "rate_limited",
        { retryAfter: retryAfter ?? bodyRetryAfter ?? null }
      );
    }    case 500:
    case 502:
    case 503:
      return new AppError(dcMsg ?? "Discord server error", 502, "discord_server_error");
    default:
      return new AppError(dcMsg ?? "Discord API error", 502, "discord_error");
  }
}

export default mapDiscordError;
