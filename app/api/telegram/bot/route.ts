import { withHandler } from "@/lib/api/handler";
import { TelegramService } from "@/lib/services/telegram/telegramService";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { telegramBotSchema } from "@/lib/validators/telegram";

export const dynamic = "force-dynamic";

export const GET = withHandler(async () => {
  logger.debug("GET /api/telegram/bot - handler");

  // No required query params — validate an empty payload for contract consistency
  validateSchema(telegramBotSchema, {});

  const res = await TelegramService.verifyBot();
  return { message: "Bot info", data: res };
});
