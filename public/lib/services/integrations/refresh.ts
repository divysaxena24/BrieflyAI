import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { getProvider } from "./registry";
import { getIntegrationById } from "@/lib/db/queries";
import { db, integrations } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * Orchestrate a token refresh attempt. This intentionally does not implement
 * provider refresh logic; providers should throw NotImplemented for now.
 */
export async function refreshIntegration(integrationId: string) {
  logger.info("Integrations: refreshIntegration requested", { integrationId });

  // Try scoped lookup first (may require user context in future). Fall back to global lookup.
  let integration = await getIntegrationById(integrationId, "");
  if (!integration) {
    const rows = await db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
    integration = rows[0] ?? null;
  }

  if (!integration) throw new AppError("Integration not found", 404, "not_found");

  const provider = getProvider(integration.platform);

  try {
    const res = await provider.refresh({ integrationId });
    return res;
  } catch (err) {
    // Bubble up AppError or wrap non-AppError
    if (err instanceof AppError) throw err;
    throw new AppError("Provider refresh failed", 500, "refresh_failed");
  }
}

export default refreshIntegration;