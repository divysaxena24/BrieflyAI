import { withHandler } from "@/lib/api/handler";
import { WhatsAppService } from "@/lib/services/whatsapp/whatsappService";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { whatsappSearchSchema } from "@/lib/validators/whatsapp";

export const dynamic = "force-dynamic";

/**
 * GET /api/whatsapp/search?query=<text>
 * Search WhatsApp messages (conversation text + captions) in the authenticated
 * WhatsApp session with a case-insensitive match.
 */
export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/whatsapp/search - handler");
  const url = new URL(request.url);

  const payload = {
    query: url.searchParams.get("query") ?? "",
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
  };

  const validated = validateSchema(whatsappSearchSchema, payload);
  logger.info("WhatsApp search validated", { query: validated.query, limit: validated.limit });

  const res = await WhatsAppService.searchMessages({ query: validated.query, limit: validated.limit });
  return { message: "Message search results", data: res };
});
