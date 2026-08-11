import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { db, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { updateIntegrationStatus } from "@/lib/db/queries";

const REFRESH_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_EXPIRY_SAFETY_SECONDS = 60; // default threshold (seconds)
const RETRY_COUNT = 1;
const RETRY_DELAY_MS = 300;

function redact(obj: any) {
  // shallow redact known sensitive fields
  if (!obj || typeof obj !== "object") return obj;
  const copy = { ...obj };
  if (copy.access_token) copy.access_token = "[REDACTED]";
  if (copy.refresh_token) copy.refresh_token = "[REDACTED]";
  if (copy.id_token) copy.id_token = "[REDACTED]";
  return copy;
}

export function isExpired(expiresAt?: Date | string | null) {
  if (!expiresAt) return true; // treat missing expiry as expired
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return true;
  return d.getTime() <= Date.now();
}

export function expiresSoon(expiresAt: Date | string | null | undefined, thresholdSeconds = DEFAULT_EXPIRY_SAFETY_SECONDS) {
  if (!expiresAt) return true;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return true;
  return d.getTime() - Date.now() <= thresholdSeconds * 1000;
}

async function getTokenRow(integrationId: string) {
  const rows = await db.select().from(oauthTokens).where(eq(oauthTokens.integrationId, integrationId)).limit(1);
  return rows[0] ?? null;
}

async function doRefresh(integrationId: string) {
  const row = await getTokenRow(integrationId);
  if (!row) throw new AppError("No OAuth token row found for integration", 404, "token_not_found");

  const refreshToken = row.refreshToken;
  if (!refreshToken) {
    logger.warn("GoogleTokenManager: missing refresh token for integration", { integrationId });
    throw new AppError("Refresh token missing", 401, "missing_refresh_token");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.error("GoogleTokenManager: missing client credentials");
    throw new AppError("Google OAuth configuration missing", 500, "missing_config");
  }

  let lastErr: any = null;
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      const res = await fetch(REFRESH_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        // no credentials, keep simple
      });

      const payload = await res.json().catch((e) => {
        throw new AppError("Invalid JSON from token endpoint", 502, "invalid_provider_response");
      });

      if (!res.ok) {
        // provider-level errors
        const errCode = payload?.error;
        const errDesc = payload?.error_description;
        logger.warn("GoogleTokenManager: token endpoint error", { integrationId, error: errCode, description: errDesc });

        if (errCode === "invalid_grant" || errCode === "invalid_token") {
          // mark integration as needing reconnect
          try {
            await updateIntegrationStatus(integrationId, "needs_reconnect");
            logger.info("GoogleTokenManager: integration marked needs_reconnect", { integrationId });
          } catch (e) {
            logger.warn("GoogleTokenManager: failed to update integration status", { integrationId, error: String(e) });
          }
          throw new AppError("Authentication required", 401, "authentication_required");
        }

        throw new AppError("Token refresh failed", 502, "token_refresh_failed");
      }

      const access_token = payload.access_token as string | undefined;
      const expires_in = payload.expires_in as number | undefined;
      const new_refresh_token = payload.refresh_token as string | undefined;
      const scope = payload.scope as string | undefined;

      if (!access_token) {
        logger.error("GoogleTokenManager: token response missing access_token", { integrationId });
        throw new AppError("Token refresh returned no access token", 502, "no_access_token");
      }

      const expiresAt = expires_in ? new Date(Date.now() + Number(expires_in) * 1000) : null;

      try {
        const updateData: Record<string, unknown> = {
          accessToken: access_token,
          updatedAt: new Date(),
        };
        if (new_refresh_token) updateData.refreshToken = new_refresh_token;
        if (scope) updateData.scope = scope;
        if (expiresAt) updateData.expiresAt = expiresAt;

        await db.update(oauthTokens).set(updateData).where(eq(oauthTokens.integrationId, integrationId)).returning();

        logger.info("GoogleTokenManager: refresh successful", { integrationId, expiresAt: expiresAt ? expiresAt.toISOString() : null });
        return { access_token, expiresAt };
      } catch (err) {
        logger.error("GoogleTokenManager: failed to persist refreshed token", { integrationId, error: String(err) });
        throw new AppError("Failed to persist refreshed token", 500, "db_error");
      }
    } catch (err: any) {
      lastErr = err;
      // network / transient errors: retry once
      const isNetwork = err instanceof AppError && err.code === "network_error";
      if (attempt < RETRY_COUNT) {
        logger.warn("GoogleTokenManager: refresh attempt failed, retrying", { integrationId, attempt, error: String(err) });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      // If provider indicated invalid_grant/auth needed, bubble up AppError already thrown
      if (err instanceof AppError) throw err;

      // treat as network error
      logger.error("GoogleTokenManager: network or unknown error during refresh", { integrationId, error: String(err) });
      throw new AppError("Network error during token refresh", 502, "network_error");
    }
  }

  // should not reach here
  throw lastErr ?? new AppError("Token refresh failed", 502, "token_refresh_failed");
}

export async function refreshToken(integrationId: string) {
  logger.info("GoogleTokenManager: refresh started", { integrationId });
  return doRefresh(integrationId);
}

export async function invalidate(integrationId: string) {
  try {
    await db.update(oauthTokens).set({ accessToken: null, refreshToken: null, expiresAt: null, updatedAt: new Date() }).where(eq(oauthTokens.integrationId, integrationId)).returning();
    // mark integration not-connected
    try {
      await updateIntegrationStatus(integrationId, "not-connected");
    } catch (e) {
      logger.warn("GoogleTokenManager: failed to update integration status during invalidate", { integrationId, error: String(e) });
    }
    logger.info("GoogleTokenManager: tokens invalidated", { integrationId });
    return true;
  } catch (err) {
    logger.error("GoogleTokenManager: failed to invalidate tokens", { integrationId, error: String(err) });
    throw new AppError("Failed to invalidate tokens", 500, "invalidate_failed");
  }
}

export async function getValidAccessToken(integrationId: string, thresholdSeconds = DEFAULT_EXPIRY_SAFETY_SECONDS) {
  logger.debug("GoogleTokenManager: token requested", { integrationId });
  const row = await getTokenRow(integrationId);
  if (!row) throw new AppError("No OAuth token found for integration", 404, "token_not_found");

  const expiresAt = row.expiresAt ?? null;
  if (!expiresAt) {
    logger.warn("GoogleTokenManager: token has no expiry, attempting refresh", { integrationId });
    // try to refresh once
    const refreshed = await refreshToken(integrationId);
    return { accessToken: refreshed.access_token, expiresAt: refreshed.expiresAt };
  }

  if (isExpired(expiresAt)) {
    logger.info("GoogleTokenManager: token expired, refreshing", { integrationId });
    const refreshed = await refreshToken(integrationId);
    return { accessToken: refreshed.access_token, expiresAt: refreshed.expiresAt };
  }

  if (expiresSoon(expiresAt, thresholdSeconds)) {
    logger.info("GoogleTokenManager: token expires soon, refreshing proactively", { integrationId });
    const refreshed = await refreshToken(integrationId);
    return { accessToken: refreshed.access_token, expiresAt: refreshed.expiresAt };
  }

  logger.info("GoogleTokenManager: returning existing access token", { integrationId, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
  return { accessToken: row.accessToken as string, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null };
}

export default {
  getValidAccessToken,
  refreshToken,
  invalidate,
  isExpired,
  expiresSoon,
};