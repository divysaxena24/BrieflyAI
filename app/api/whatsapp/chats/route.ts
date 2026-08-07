import { withHandler } from "@/lib/api/handler";
import { WhatsAppService } from "@/lib/services/whatsapp/whatsappService";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/whatsapp/chats
 * List the chats visible to the authenticated WhatsApp session. Authenticated
 * through the LIVE Baileys socket (resolved by WhatsAppService) — never
 * through OAuth tokens.
 */
export const GET = withHandler(async () => {
  logger.debug("GET /api/whatsapp/chats - handler");

  const res = await WhatsAppService.listChats();
  return { message: "Chat list", data: res };
});
