import { AppError } from "@/lib/errors";

/**
 * Extract the most useful message from a GitHub error response body.
 * GitHub error bodies follow the shape { message, documentation_url, errors? }.
 */
export function extractGitHubErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;

  const obj = body as Record<string, unknown>;
  const message = typeof obj.message === "string" ? obj.message : undefined;

  // Errors array: [{ resource, field, code, message? }]
  const errors = Array.isArray(obj.errors) ? obj.errors : undefined;
  if (errors && errors.length > 0) {
    const parts = errors
      .map((e) => {
        if (!e || typeof e !== "object") return "";
        const errObj = e as Record<string, unknown>;
        const field = typeof errObj.field === "string" ? errObj.field : "";
        const code = typeof errObj.code === "string" ? errObj.code : "";
        const resource = typeof errObj.resource === "string" ? errObj.resource : "";
        return [resource, field, code].filter(Boolean).join(" ");
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("; ");
  }

  return message;
}

/**
 * Map a GitHub REST API response to the application's AppError.
 * Uses the same error style as the rest of the codebase — no second framework.
 *
 * GitHub specifics handled here:
 * - Rate limiting is usually signaled as HTTP 403 with X-RateLimit-Remaining: 0
 *   (not 429), so we inspect the response headers to return code "rate_limited".
 * - Error messages live in the JSON body `message` field.
 */
export function mapGitHubError(status: number | null | undefined, body?: unknown, headers?: Headers | null): AppError {
  const ghMsg = extractGitHubErrorMessage(body);

  // Rate-limit detection: GitHub returns 403 with X-RateLimit-Remaining: 0
  const rateLimited = headers?.get("x-ratelimit-remaining") === "0";

  if (!status) return new AppError(ghMsg ?? "GitHub API error", 502, "github_error");

  switch (status) {
    case 400:
      return new AppError(ghMsg ?? "Bad request", 400, "bad_request");
    case 401:
      return new AppError(ghMsg ?? "Authentication required", 401, "authentication_required");
    case 403:
      if (rateLimited) return new AppError(ghMsg ?? "Rate limited by GitHub", 403, "rate_limited");
      return new AppError(ghMsg ?? "Permission denied", 403, "permission_denied");
    case 404:
      return new AppError(ghMsg ?? "Not found", 404, "not_found");
    case 409:
      return new AppError(ghMsg ?? "Conflict", 409, "conflict");
    case 422:
      return new AppError(ghMsg ?? "Validation failed", 422, "validation_failed");
    case 429:
      return new AppError(ghMsg ?? "Rate limited", 429, "rate_limited");
    case 500:
    case 502:
    case 503:
      return new AppError(ghMsg ?? "GitHub server error", 502, "github_server_error");
    default:
      return new AppError(ghMsg ?? "GitHub API error", 502, "github_error");
  }
}

export default mapGitHubError;
