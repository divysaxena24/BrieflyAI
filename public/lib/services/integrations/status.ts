import { logger } from "@/lib/logger";
import { getProvider } from "./registry";
import { validateProviderId } from "./utils";
import tokenManager from "./googleTokenManager";
import type { StatusResult } from "./types";
import { getUserIntegrationByPlatform, getIntegrationById } from "@/lib/db/queries";
import { db, oauthTokens, integrations } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * Return standardized connection status for a user + platform or integration id.
 * If platform and userId provided, prefer that; otherwise use integrationId.
 */
export async function getIntegrationStatus({ userId, platform, integrationId }: { userId?: string; platform?: string; integrationId?: string }): Promise<StatusResult> {
  logger.debug("Integrations: getIntegrationStatus", { userId, platform, integrationId });

  let integrationRecord: any = null;

  if (integrationId) {
    integrationRecord = await getIntegrationById(integrationId, userId ?? "");
  } else if (userId && platform) {
    integrationRecord = await getUserIntegrationByPlatform(userId, validateProviderId(platform));
  }

  if (!integrationRecord) {
    // If not found, return a not-connected shape
    const provider = validateProviderId(platform ?? integrationRecord?.platform ?? "unknown");
    const p = getProvider(provider);
    return p.status(userId ?? "", provider);
  }

  const providerId = validateProviderId(integrationRecord.platform);
  const provider = getProvider(providerId);

  // Query oauth_tokens for expiry info if present
  const tokenRow = await db.select().from(oauthTokens).where(eq(oauthTokens.integrationId, integrationRecord.id)).limit(1);
  const token = tokenRow[0] ?? null;

  const expiresAt = token?.expiresAt ?? null;
  const needsReconnect = !!token && tokenManager.isExpired(expiresAt);

  const statusPayload: StatusResult = {
    provider: providerId,
    status: integrationRecord.status ?? (token ? "connected" : "not-connected"),
    lastSync: integrationRecord.lastSyncAt ? integrationRecord.lastSyncAt.toISOString() : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    needsReconnect,
    connectionHealth: needsReconnect ? "failed" : "healthy",
    meta: integrationRecord.metadata ? JSON.parse(integrationRecord.metadata) : null,
  } as StatusResult;

  // Let provider optionally enrich status for provider-specific insights
  try {
    const providerStatus = await provider.status(userId ?? "", providerId);
    // Merge non-null fields from providerStatus
    return { ...statusPayload, ...providerStatus };
  } catch (err) {
    logger.debug("Integrations: provider.status failed; returning core status", { error: err });
    return statusPayload;
  }
}

export default getIntegrationStatus;