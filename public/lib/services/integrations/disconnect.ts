import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { getProvider } from "./registry";
import { validateProviderId } from "./utils";
import type { DisconnectParams, DisconnectResult } from "./types";
import { getIntegrationById, deleteIntegration, updateIntegrationStatus } from "@/lib/db/queries";

/**
 * Generic disconnect orchestration:
 * - verify integration exists and belongs to user
 * - delegate the disconnect to provider implementation
 * - update integration status
 * - return standardized response
 */
export async function disconnectIntegration(params: DisconnectParams): Promise<DisconnectResult> {
  logger.info("Integrations: disconnectIntegration requested", { integrationId: params.integrationId, userId: params.userId });

  const existing = await getIntegrationById(params.integrationId, params.userId);
  if (!existing) throw new AppError("Integration not found", 404, "not_found");

  const platform = validateProviderId(existing.platform);
  const provider = getProvider(platform);

  // Delegate provider-specific disconnect logic (may be a no-op for stubs)
  const providerResult = await provider.disconnect({ integrationId: params.integrationId, userId: params.userId });

  // Update status (do not delete tokens in Step 1). Keep integration record but mark as not-connected.
  const updated = await updateIntegrationStatus(params.integrationId, "not-connected");

  logger.info("Integrations: disconnectIntegration - updated status", { integrationId: params.integrationId, platform, userId: params.userId });

  return { success: true, message: providerResult.message ?? "Disconnected" };
}

export default disconnectIntegration;