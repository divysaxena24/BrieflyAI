import { withHandler } from "@/lib/api/handler";
import { TelegramService } from "@/lib/services/telegram/telegramService";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withHandler(async () => {
  logger.debug("GET /api/telegram/chats - handler");

  const res = await TelegramService.listChats();
  return { message: "Chat list", data: res };
});
