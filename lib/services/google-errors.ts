import { AppError } from "@/lib/errors";

export function mapStatusToAppError(status: number | null | undefined, body?: any): AppError {
  // Extract the real Google error message from the response body when available
  const googleMsg: string | undefined =
    body?.error?.message ??
    body?.error_description ??
    (Array.isArray(body?.error?.errors) ? body.error.errors[0]?.message : undefined) ??
    undefined;

  if (!status) return new AppError(googleMsg ?? "Google API error", 502, "google_error");
  if (status === 400) return new AppError(googleMsg ?? "Bad request", 400, "bad_request");
  if (status === 401) return new AppError(googleMsg ?? "Authentication required", 401, "authentication_required");
  if (status === 403) return new AppError(googleMsg ?? "Permission denied", 403, "permission_denied");
  if (status === 404) return new AppError(googleMsg ?? "Not found", 404, "not_found");
  if (status === 429) return new AppError(googleMsg ?? "Rate limited", 429, "rate_limited");
  if (status >= 500 && status < 600) return new AppError(googleMsg ?? "Google server error", 502, "google_server_error");
  return new AppError(googleMsg ?? "Google API error", 502, "google_error");
}
