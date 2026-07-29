import { withHandler } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth";
import { findUserByAuthId, getUserIntegrations } from "@/lib/db/queries";
import { db, oauthTokens as oauthTokensTable } from "@/lib/db";
import { inArray } from "drizzle-orm";
import { integrationPlatforms } from "@/lib/integrations/config";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (_req: Request) => {
  logger.debug("GET /api/integrations - handler");

  // Start with the static platform config as base
  let platforms = [...integrationPlatforms];

  // Try to merge real DB status if user is authenticated
  try {
    const authUser = await getCurrentUser();
    if (authUser) {
      const appUser = await findUserByAuthId(authUser.id);
      if (appUser) {
        const userIntegrations = await getUserIntegrations(appUser.id);
        // Map DB integrations (platform "gmail" etc.) onto config platforms
        const integrationMap = new Map(
          userIntegrations.map((i) => [i.platform, i])
        );
        // Fetch OAuth tokens to surface scopes for connected integrations
        const integrationIds = userIntegrations.map((i) => i.id);
        const tokenRows = integrationIds.length > 0
          ? await db.select().from(oauthTokensTable).where(inArray(oauthTokensTable.integrationId, integrationIds))
          : [];
        const tokenMap = new Map(tokenRows.map((t) => [t.integrationId, t]));

        platforms = platforms.map((p) => {
          const dbInt = integrationMap.get(p.id);
          if (dbInt) {
            const token = tokenMap.get(dbInt.id);
            return {
              ...p,
              status: dbInt.status as any,
              permissions: dbInt.permissions ?? p.permissions,
              lastSync: dbInt.lastSyncAt ? dbInt.lastSyncAt.toISOString() : p.lastSync,
              account: dbInt.accountEmail ?? dbInt.accountName ?? p.account,
              scopes: token?.scope ?? null,
            };
          }
          return p;
        });
        logger.info("Integrations listed with DB status", { count: platforms.length, connected: userIntegrations.length });
      }
    }
  } catch (err) {
    logger.warn("Could not merge DB status, falling back to static config", { error: String(err) });
  }

  return { message: "Integrations list", data: platforms };
});
