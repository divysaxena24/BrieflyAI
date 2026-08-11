import { withHandler } from "@/lib/api/handler";
import { TelegramService } from "@/lib/services/telegram/telegramService";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { telegramMessagesSchema } from "@/lib/validators/telegram";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/telegram/messages - handler");
  const url = new URL(request.url);

  const payload = {
    chatId: url.searchParams.get("chatId") ?? "",
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
  };

  const validated = validateSchema(telegramMessagesSchema, payload);
  logger.info("Telegram messages validated", { chatId: validated.chatId, limit: validated.limit });

  const res = await TelegramService.listMessages(validated.chatId, validated.limit);
  return { message: "Message list", data: res };
});
