import { withHandler } from "@/lib/api/handler";
import { TelegramService } from "@/lib/services/telegram/telegramService";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { telegramChatSchema } from "@/lib/validators/telegram";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/telegram/chat - handler");
  const url = new URL(request.url);

  const payload = {
    chatId: url.searchParams.get("chatId") ?? "",
  };

  const validated = validateSchema(telegramChatSchema, payload);
  logger.info("Telegram chat validated", { chatId: validated.chatId });

  const res = await TelegramService.getChat(validated.chatId);
  return { message: "Chat details", data: res };
});
