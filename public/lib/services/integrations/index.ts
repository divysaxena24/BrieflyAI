import { integrationPlatforms } from "@/lib/integrations/config";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

// Orchestrator exports
import { connectIntegration } from "./connect";
import { disconnectIntegration } from "./disconnect";
import { getIntegrationStatus } from "./status";
import { refreshIntegration } from "./refresh";
import { registry, registerDefaultPlaceholders, listRegisteredProviders } from "./registry";

// Note: provider registration is performed explicitly via registry.bootstrapProviders()
// to avoid import-time side effects. Call bootstrapProviders() during application
// initialization or within route handlers before provider usage if needed.

/**
 * Integrations service – returns configured platforms (UI-facing catalog).
 */
export function listIntegrations() {
  logger.debug("Integrations: listIntegrations");
  return integrationPlatforms;
}

export const integrationsService = {
  listIntegrations,
  connectIntegration,
  disconnectIntegration,
  getIntegrationStatus,
  refreshIntegration,
  registry,
  listRegisteredProviders,
};

export default integrationsService;

// Barrel exports for convenience
export { connectIntegration as connect } from "./connect";
export { disconnectIntegration as disconnect } from "./disconnect";
export { getIntegrationStatus as status } from "./status";
export { refreshIntegration as refresh } from "./refresh";
export { registry, registerDefaultPlaceholders, listRegisteredProviders } from "./registry";
export * from "./types";

