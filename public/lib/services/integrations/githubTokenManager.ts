import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { db, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { updateIntegrationStatus } from "@/lib/db/queries";

const DEFAULT_EXPIRY_SAFETY_SECONDS = 60; // default threshold (seconds)

/**
 * GitHub OAuth App access tokens are NON-EXPIRING by default.
 * A missing expiry therefore means the token is still valid (unlike Google,
 * where a missing expiry is treated as expired and triggers a refresh).
 */
export function isExpired(expiresAt?: Date | string | null) {
  if (!expiresAt) return false; // non-expiring GitHub tokens: missing expiry = valid
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now();
}

export function expiresSoon(expiresAt: Date | string | null | undefined, thresholdSeconds = DEFAULT_EXPIRY_SAFETY_SECONDS) {
  if (!expiresAt) return false; // non-expiring GitHub tokens never expire soon
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() - Date.now() <= thresholdSeconds * 1000;
}

async function getTokenRow(integrationId: string) {
  const rows = await db.select().from(oauthTokens).where(eq(oauthTokens.integrationId, integrationId)).limit(1);
  return rows[0] ?? null;
}

/**
 * GitHub OAuth App tokens are non-expiring and the token endpoint does not
 * issue refresh tokens for classic OAuth Apps (unlike Google's offline access).
 *
 * Token refresh is intentionally UNSUPPORTED: it throws a meaningful AppError
 * instead of inventing unsupported behavior. If GitHub expiring tokens are
 * enabled in the future (GitHub Apps / expiring OAuth App tokens), implement
 * refresh against https://github.com/login/oauth/access_token here.
 */
export async function refreshToken(integrationId: string) {
  logger.warn("GitHubTokenManager: refresh requested but unsupported for non-expiring GitHub tokens", { integrationId });
  throw new AppError(
    "GitHub OAuth App tokens are non-expiring; token refresh is not supported",
    501,
    "not_implemented"
  );
}

export async function invalidate(integrationId: string) {
  try {
    await db.update(oauthTokens).set({ accessToken: null, refreshToken: null, expiresAt: null, updatedAt: new Date() }).where(eq(oauthTokens.integrationId, integrationId)).returning();
    // mark integration not-connected
    try {
      await updateIntegrationStatus(integrationId, "not-connected");
    } catch (e) {
      logger.warn("GitHubTokenManager: failed to update integration status during invalidate", { integrationId, error: String(e) });
    }
    logger.info("GitHubTokenManager: tokens invalidated", { integrationId });
    return true;
  } catch (err) {
    logger.error("GitHubTokenManager: failed to invalidate tokens", { integrationId, error: String(err) });
    throw new AppError("Failed to invalidate tokens", 500, "invalidate_failed");
  }
}

export async function getValidAccessToken(integrationId: string) {
  logger.debug("GitHubTokenManager: token requested", { integrationId });
  const row = await getTokenRow(integrationId);
  if (!row) throw new AppError("No OAuth token found for integration", 404, "token_not_found");

  const expiresAt = row.expiresAt ?? null;

  // GitHub tokens are non-expiring: a missing expiry means the token is valid as-is.
  if (!expiresAt) {
    logger.info("GitHubTokenManager: returning existing access token (non-expiring)", { integrationId });
    return { accessToken: row.accessToken as string, expiresAt: null };
  }

  if (isExpired(expiresAt)) {
    logger.warn("GitHubTokenManager: token expired", { integrationId });
    throw new AppError("GitHub token expired", 401, "authentication_required");
  }

  logger.info("GitHubTokenManager: returning existing access token", { integrationId, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
  return { accessToken: row.accessToken as string, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null };
}

export default {
  getValidAccessToken,
  refreshToken,
  invalidate,
  isExpired,
  expiresSoon,
};
