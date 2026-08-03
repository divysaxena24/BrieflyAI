import { AppError } from "@/lib/errors";

/**
 * Extract the most useful message from a Telegram error response body.
 * Telegram error bodies follow the shape { ok: false, error_code, description,
 * parameters? } where `description` is human-readable (e.g. "Bad Request:
 * chat not found").
 */
export function extractTelegramError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;

  const obj = body as Record<string, unknown>;
  const description = typeof obj.description === "string" ? obj.description : undefined;
  return description;
}

/**
 * Map a Telegram Bot API response to the application's AppError.
 * Uses the same error style as the rest of the codebase — no second framework.
 *
 * Telegram specifics handled here:
 * - Telegram usually returns HTTP 200 with { ok: false, error_code, description }
 *   for failures, so the body's `error_code` is preferred over the HTTP status.
 * - Rate limiting is signaled as error_code 429 with a `parameters.retry_after`
 *   field (seconds) in the body — captured as details.
 * - Error messages live in the body `description` field.
 */
export function mapTelegramError(status: number | null | undefined, body?: unknown, headers?: Headers | null): AppError {
  const tgMsg = extractTelegramError(body);

  const bodyObj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const errorCode = bodyObj && typeof bodyObj.error_code === "number" ? bodyObj.error_code : undefined;
  const effectiveStatus = errorCode ?? status;

  if (!effectiveStatus) return new AppError(tgMsg ?? "Telegram API error", 502, "telegram_error");

  switch (effectiveStatus) {
    case 400:
      return new AppError(tgMsg ?? "Bad request", 400, "bad_request");
    case 401:
      return new AppError(tgMsg ?? "Authentication required", 401, "authentication_required");
    case 403:
      return new AppError(tgMsg ?? "Permission denied", 403, "permission_denied");
    case 404:
      return new AppError(tgMsg ?? "Not found", 404, "not_found");
    case 429: {
      // Telegram rate limit: parameters.retry_after (seconds) in the body
      const parameters =
        bodyObj && typeof bodyObj.parameters === "object"
          ? (bodyObj.parameters as Record<string, unknown>)
          : null;
      const retryAfter =
        parameters && typeof parameters.retry_after === "number"
          ? String(parameters.retry_after)
          : undefined;
      return new AppError(
        tgMsg ?? "Rate limited by Telegram",
        429,
        "rate_limited",
        { retryAfter: retryAfter ?? headers?.get("retry-after") ?? null }
      );
    }
    case 500:
    case 502:
    case 503:
      return new AppError(tgMsg ?? "Telegram server error", 502, "telegram_server_error");
    default:
      return new AppError(tgMsg ?? "Telegram API error", 502, "telegram_error");
  }
}

export default mapTelegramError;
