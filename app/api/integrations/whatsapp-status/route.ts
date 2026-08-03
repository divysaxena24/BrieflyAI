import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { withHandler } from "@/lib/api/handler";
import { getUserIntegrationByPlatform, findUserByAuthId, updateIntegrationStatus } from "@/lib/db/queries";
import { whatsappSessionManager } from "@/lib/services/whatsapp/whatsappSessionManager";
import { db, integrations } from "@/lib/db";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/integrations/whatsapp-status
 * Returns the WhatsApp connection status for the current user.
 *
 * The UI polls this endpoint while the connect dialog is open. The provider
 * maps the session-manager state into the integration status model, so the
 * response includes both the mapped status and the raw session state:
 *   { status, sessionState }
 */
export const GET = withHandler(async () => {
  registry.bootstrapProviders();

  // Authenticate the current user (same pattern as the other integration routes)
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: userData } = await supabase.auth.getUser();
  const authUserId = userData?.user?.id;
  if (!authUserId) throw new AppError("Unauthorized", 401, "authentication_required");

  // Resolve auth.users.id → users.id (integrations.user_id references users.id)
  const appUser = await findUserByAuthId(authUserId);
  if (!appUser) throw new AppError("Application user not found", 404, "user_not_found");

  // Resolve the WhatsApp integration for this user
  const integration = await getUserIntegrationByPlatform(appUser.id, "whatsapp");
  if (!integration) throw new AppError("No WhatsApp integration found", 404, "integration_not_found");

  // Delegate to the provider — it asks the session manager and maps the state
  // (connecting / qr / open / close / logged-out) into the status model.
  const provider = registry.getProvider("whatsapp");
  const res = await provider.status(appUser.id, "whatsapp");

  // Persist the connected state so the integrations list (which reads the DB
  // row directly) reflects the scan. Guarded so the poll doesn't churn the DB.
  if (res.status === "connected" && integration.status !== "connected") {
    await updateIntegrationStatus(integration.id, "connected");
    logger.info("WhatsApp integration marked connected", {
      userId: appUser.id,
      integrationId: integration.id,
    });
  }

  // Capture the phone number as the account name once the socket exposes it
  // (jid format "15551234567@s.whatsapp.net" → local part). Kept OUTSIDE the
  // status-transition guard so it keeps retrying on later polls if the socket
  // user wasn't populated on the exact transition poll. Best-effort.
  if (res.status === "connected" && !integration.accountName) {
    try {
      const socket = whatsappSessionManager.getSession(integration.id);
      const jid = socket?.user?.id;
      const phone = jid ? jid.split("@")[0] : null;
      if (phone) {
        await db
          .update(integrations)
          .set({ accountName: phone, updatedAt: new Date() })
          .where(eq(integrations.id, integration.id));
        logger.info("WhatsApp account name saved", { integrationId: integration.id, accountName: phone });
      }
    } catch (err) {
      logger.debug("Failed to save WhatsApp account name", { error: String(err) });
    }
  }

  const meta = (res.meta ?? {}) as { sessionState?: string; lastDisconnectReason?: string };
  return {
    message: "WhatsApp connection status",
    data: {
      status: res.status,
      sessionState: meta.sessionState ?? null,
      lastDisconnectReason: meta.lastDisconnectReason ?? null,
    },
  };
});
