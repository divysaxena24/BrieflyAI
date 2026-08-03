import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { db, oauthTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { updateIntegrationStatus } from "@/lib/db/queries";

const REFRESH_ENDPOINT = "https://discord.com/api/oauth2/token";
const REVOKE_ENDPOINT = "https://discord.com/api/oauth2/token/revoke";
const DEFAULT_EXPIRY_SAFETY_SECONDS = 60; // default threshold (seconds)
const RETRY_COUNT = 1;
const RETRY_DELAY_MS = 300;

/**
 * Discord OAuth2 access tokens are EXPIRING (~7 days) and refreshable — the
 * same model as Google (unlike GitHub's non-expiring tokens). Missing expiry is
 * therefore treated as expired, mirroring GoogleTokenManager.
 */
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

/**
 * Best-effort revocation of a Discord OAuth access token.
 * Discord revoke endpoint: POST https://discord.com/api/oauth2/token/revoke
 * with form fields token, client_id, client_secret.
 * Failures are logged but never thrown — revocation must not block disconnect.
 */
async function revokeAccessToken(accessToken: string, integrationId?: string) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    logger.debug("DiscordTokenManager: cannot revoke token, missing client credentials", { integrationId });
    return false;
  }
  try {
    const res = await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: accessToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      logger.warn("DiscordTokenManager: revoke returned non-OK", { integrationId, status: res.status });
      return false;
    }
    logger.info("DiscordTokenManager: token revoked", { integrationId });
    return true;
  } catch (err) {
    logger.warn("DiscordTokenManager: revoke failed (best effort)", { integrationId, error: String(err) });
    return false;
  }
}

async function doRefresh(integrationId: string) {
  const row = await getTokenRow(integrationId);
  if (!row) throw new AppError("No OAuth token row found for integration", 404, "token_not_found");

  const refreshToken = row.refreshToken;
  if (!refreshToken) {
    logger.warn("DiscordTokenManager: missing refresh token for integration", { integrationId });
    throw new AppError("Refresh token missing", 401, "missing_refresh_token");
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.error("DiscordTokenManager: missing client credentials");
    throw new AppError("Discord OAuth configuration missing", 500, "missing_config");
  }

  let lastErr: unknown = null;
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
      });

      const payload = (await res.json().catch(() => {
        throw new AppError("Invalid JSON from token endpoint", 502, "invalid_provider_response");
      })) as Record<string, unknown>;

      if (!res.ok) {
        // Discord error body: { error, error_description }
        const errCode = typeof payload.error === "string" ? payload.error : undefined;
        const errDesc = typeof payload.error_description === "string" ? payload.error_description : undefined;
        logger.warn("DiscordTokenManager: token endpoint error", { integrationId, error: errCode, description: errDesc });

        if (errCode === "invalid_grant") {
          // refresh token no longer valid — mark integration as needing reconnect
          try {
            await updateIntegrationStatus(integrationId, "needs_reconnect");
            logger.info("DiscordTokenManager: integration marked needs_reconnect", { integrationId });
          } catch (e) {
            logger.warn("DiscordTokenManager: failed to update integration status", { integrationId, error: String(e) });
          }
          throw new AppError("Authentication required", 401, "authentication_required");
        }

        throw new AppError("Token refresh failed", 502, "token_refresh_failed");
      }

      const rawExpiresIn = payload.expires_in;
      const expires_in = typeof rawExpiresIn === "number" || typeof rawExpiresIn === "string" ? Number(rawExpiresIn) : undefined;
      const access_token = typeof payload.access_token === "string" ? payload.access_token : undefined;
      const new_refresh_token = typeof payload.refresh_token === "string" ? payload.refresh_token : undefined;
      const scope = typeof payload.scope === "string" ? payload.scope : undefined;

      if (!access_token) {
        logger.error("DiscordTokenManager: token response missing access_token", { integrationId });
        throw new AppError("Token refresh returned no access token", 502, "no_access_token");
      }

      const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

      try {
        const updateData: Record<string, unknown> = {
          accessToken: access_token,
          updatedAt: new Date(),
        };
        if (new_refresh_token) updateData.refreshToken = new_refresh_token;
        if (scope) updateData.scope = scope;
        if (expiresAt) updateData.expiresAt = expiresAt;

        await db.update(oauthTokens).set(updateData).where(eq(oauthTokens.integrationId, integrationId)).returning();

        logger.info("DiscordTokenManager: refresh successful", { integrationId, expiresAt: expiresAt ? expiresAt.toISOString() : null });
        return { access_token, expiresAt };
      } catch (err) {
        logger.error("DiscordTokenManager: failed to persist refreshed token", { integrationId, error: String(err) });
        throw new AppError("Failed to persist refreshed token", 500, "db_error");
      }
    } catch (err) {
      lastErr = err;
      // Only retry network/transient (non-AppError) failures — provider-level
      // errors (invalid_grant, missing_config, ...) bubble up immediately.
      if (attempt < RETRY_COUNT && !(err instanceof AppError)) {
        logger.warn("DiscordTokenManager: refresh attempt failed, retrying", { integrationId, attempt, error: String(err) });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      // Provider-signaled errors are already AppErrors — bubble them up
      if (err instanceof AppError) throw err;

      // treat as network error
      logger.error("DiscordTokenManager: network or unknown error during refresh", { integrationId, error: String(err) });
      throw new AppError("Network error during token refresh", 502, "network_error");
    }
  }

  // should not reach here
  throw lastErr instanceof AppError
    ? lastErr
    : new AppError("Token refresh failed", 502, "token_refresh_failed");
}

export async function refreshToken(integrationId: string) {
  logger.info("DiscordTokenManager: refresh started", { integrationId });
  return doRefresh(integrationId);
}

export async function invalidate(integrationId: string) {
  try {
    // Best effort: revoke the access token on Discord's side before clearing
    const row = await getTokenRow(integrationId);
    if (row?.accessToken) {
      await revokeAccessToken(row.accessToken, integrationId);
    }

    await db
      .update(oauthTokens)
      .set({ accessToken: null, refreshToken: null, expiresAt: null, updatedAt: new Date() })
      .where(eq(oauthTokens.integrationId, integrationId))
      .returning();
    // mark integration not-connected
    try {
      await updateIntegrationStatus(integrationId, "not-connected");
    } catch (e) {
      logger.warn("DiscordTokenManager: failed to update integration status during invalidate", { integrationId, error: String(e) });
    }
    logger.info("DiscordTokenManager: tokens invalidated", { integrationId });
    return true;
  } catch (err) {
    logger.error("DiscordTokenManager: failed to invalidate tokens", { integrationId, error: String(err) });
    throw new AppError("Failed to invalidate tokens", 500, "invalidate_failed");
  }
}

export async function getValidAccessToken(integrationId: string, thresholdSeconds = DEFAULT_EXPIRY_SAFETY_SECONDS) {
  logger.debug("DiscordTokenManager: token requested", { integrationId });
  const row = await getTokenRow(integrationId);
  if (!row) throw new AppError("No OAuth token found for integration", 404, "token_not_found");

  const expiresAt = row.expiresAt ?? null;
  if (!expiresAt) {
    logger.warn("DiscordTokenManager: token has no expiry, attempting refresh", { integrationId });
    // try to refresh once
    const refreshed = await refreshToken(integrationId);
    return { accessToken: refreshed.access_token, expiresAt: refreshed.expiresAt };
  }

  if (isExpired(expiresAt)) {
    logger.info("DiscordTokenManager: token expired, refreshing", { integrationId });
    const refreshed = await refreshToken(integrationId);
    return { accessToken: refreshed.access_token, expiresAt: refreshed.expiresAt };
  }

  if (expiresSoon(expiresAt, thresholdSeconds)) {
    logger.info("DiscordTokenManager: token expires soon, refreshing proactively", { integrationId });
    const refreshed = await refreshToken(integrationId);
    return { accessToken: refreshed.access_token, expiresAt: refreshed.expiresAt };
  }

  logger.info("DiscordTokenManager: returning existing access token", { integrationId, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
  return { accessToken: row.accessToken as string, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null };
}

export default {
  getValidAccessToken,
  refreshToken,
  invalidate,
  isExpired,
  expiresSoon,
};
