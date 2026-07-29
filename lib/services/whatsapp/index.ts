import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function listWhatsappConversations() {
  logger.debug("WhatsApp: listWhatsappConversations called (placeholder)");
  throw new AppError("WhatsApp service not implemented", 501, "not_implemented");
}

export const whatsappService = { listWhatsappConversations };

export default whatsappService;
