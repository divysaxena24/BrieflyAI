// ──────────────────────────────────────────────
//  Telegram services barrel
//  Reusable HTTP layer (client/errors/utils).
//  Chats / Messages service comes in a later step.
// ──────────────────────────────────────────────

export * from "./telegramClient";
export * from "./telegramErrors";
export * from "./telegramUtils";

import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Placeholder kept for backward compatibility until the Telegram service
 * (chats/messages) is implemented in a later step.
 */
export async function listChats() {
  logger.debug("Telegram: listChats called (placeholder)");
  throw new AppError("Telegram service not implemented", 501, "not_implemented");
}

export const telegramService = { listChats };

export default telegramService;
