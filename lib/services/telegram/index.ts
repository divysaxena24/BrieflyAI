import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function listChats() {
  logger.debug("Telegram: listChats called (placeholder)");
  throw new AppError("Telegram service not implemented", 501, "not_implemented");
}

export const telegramService = { listChats };

export default telegramService;
