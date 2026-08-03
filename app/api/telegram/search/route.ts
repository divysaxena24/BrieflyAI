import { withHandler } from "@/lib/api/handler";
import { TelegramService } from "@/lib/services/telegram/telegramService";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { telegramSearchSchema } from "@/lib/validators/telegram";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/telegram/search - handler");
  const url = new URL(request.url);

  const rawChatIds = url.searchParams.getAll("chatIds");
  const payload = {
    query: url.searchParams.get("query") ?? "",
    chatIds: rawChatIds.length > 0 ? rawChatIds : undefined,
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
  };

  const validated = validateSchema(telegramSearchSchema, payload);
  logger.info("Telegram search validated", {
    query: validated.query,
    chatIds: validated.chatIds?.length,
    limit: validated.limit,
  });

  // TODO(phase-4d): wire `chatIds`/`limit` into TelegramService.searchMessages()
  // once it supports them — currently validated for API contract only
  // (forward-compatible).
  const res = await TelegramService.searchMessages({ query: validated.query });
  return { message: "Message search results", data: res };
});
