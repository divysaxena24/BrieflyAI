import { withHandler } from "@/lib/api/handler";
import { WhatsAppService } from "@/lib/services/whatsapp/whatsappService";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { whatsappMessagesSchema } from "@/lib/validators/whatsapp";

export const dynamic = "force-dynamic";

/**
 * GET /api/whatsapp/messages?chatId=<jid>&limit=<n>
 * List messages for a chat from the authenticated WhatsApp session. The chatId
 * is the WhatsApp jid (e.g. "15551234567@s.whatsapp.net").
 */
export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/whatsapp/messages - handler");
  const url = new URL(request.url);

  const payload = {
    chatId: url.searchParams.get("chatId") ?? "",
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
  };

  const validated = validateSchema(whatsappMessagesSchema, payload);
  logger.info("WhatsApp messages validated", { chatId: validated.chatId, limit: validated.limit });

  const res = await WhatsAppService.listMessages(validated);
  return { message: "Message list", data: res };
});
