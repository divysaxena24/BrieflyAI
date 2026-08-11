import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { getProvider } from "./registry";
import { validateProviderId } from "./utils";
import type { ConnectParams, ConnectResult } from "./types";
import { getUserIntegrationByPlatform, createIntegration } from "@/lib/db/queries";

/**
 * Generic connect flow:
 * - validate provider exists
 * - validate provider configuration
 * - prevent duplicate connections (user + platform)
 * - delegate connect to provider implementation
 * - create integration record (in a minimal form)
 * - return standardized result
 */
export async function connectIntegration(params: ConnectParams): Promise<ConnectResult> {
  const platform = validateProviderId(params.platform);
  logger.info("Integrations: connectIntegration requested", { platform, userId: params.userId });

  const provider = getProvider(platform);

  // Provider configuration validation
  const valid = await provider.validateConfiguration(params.config);
  if (!valid) throw new AppError("Invalid provider configuration", 400, "invalid_configuration");

  // Prevent duplicate connection for the same user + platform
  const existing = await getUserIntegrationByPlatform(params.userId, platform);
  if (existing) {
    logger.info("Integrations: connectIntegration - already connected", { platform, userId: params.userId, integrationId: existing.id });
    return { success: false, message: "Integration already exists for this platform." };
  }

  // Delegate to provider for any provider-specific connect action (placeholder)
  const providerResult = await provider.connect(params);

  // Persist a lightweight integration record so UI shows the new integration
  // Real provider metadata (tokens) will be saved in Step 2 when provider returns tokens
  const created = await createIntegration({
    userId: params.userId,
    platform,
    permissions: "read",
    accountEmail: undefined,
    accountName: undefined,
    metadata: JSON.stringify({ placeholder: true, providerPayload: providerResult.payload ?? null }),
  });

  // Optionally update status depending on provider result — keep simple for Step 1
  // Mark as "connecting" when provider indicates next steps are required
  const message = providerResult.message ?? "Integration created (placeholder)";

  logger.info("Integrations: connectIntegration - created integration", { integrationId: created.id, platform, userId: params.userId });

  return { success: true, message, payload: { integration: created, provider: providerResult.payload ?? null } };
}

export default connectIntegration;