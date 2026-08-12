import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { registry } from "@/lib/services/integrations/registry";
import { withHandler } from "@/lib/api/handler";
import { getUserIntegrationByPlatform, findUserByAuthId } from "@/lib/db/queries";
import { whatsappSessionManager } from "@/lib/services/whatsapp/whatsappSessionManager";
import { db, integrations } from "@/lib/db";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { formatWhatsAppPhone } from "@/lib/services/whatsapp/whatsappUtils";

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

  // The session manager persists the connected status from Baileys' open event.
  // Keep the phase metadata update here without issuing a second status write.
  if (res.status === "connected" && integration.status !== "connected") {
    try {
      const meta = integration.metadata ? JSON.parse(integration.metadata) : {};
      const nextMeta =
        typeof meta === "object" && meta !== null ? { ...meta, phase: "connected" } : { phase: "connected" };
      await db
        .update(integrations)
        .set({ metadata: JSON.stringify(nextMeta), updatedAt: new Date() })
        .where(eq(integrations.id, integration.id));
      logger.info("WhatsApp integration metadata phase set to connected", { integrationId: integration.id });
    } catch (err) {
      logger.debug("Failed to update WhatsApp metadata phase", { error: String(err) });
    }

    logger.info("WhatsApp integration marked connected", {
      userId: appUser.id,
      integrationId: integration.id,
    });
  }

  // Capture the account name once the socket exposes it. Prefer the WhatsApp
  // profile name (socket.user.name); fall back to a clean phone number — the
  // raw JID local part would include the ":<device>" suffix, e.g.
  // "917024296567:96". Kept OUTSIDE the status-transition guard so it keeps
  // retrying on later polls if the socket user wasn't populated on the exact
  // transition poll. Best-effort.
  if (res.status === "connected" && !integration.accountName) {
    try {
      const socket = whatsappSessionManager.getSession(integration.id);
      const profileName = socket?.user?.name ?? socket?.user?.verifiedName ?? null;
      const phone = formatWhatsAppPhone(socket?.user?.id);
      const accountName = profileName ?? phone;
      if (accountName) {
        await db
          .update(integrations)
          .set({ accountName, updatedAt: new Date() })
          .where(eq(integrations.id, integration.id));
        logger.info("WhatsApp account name saved", { integrationId: integration.id, accountName });
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
