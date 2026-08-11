import { withHandler } from "@/lib/api/handler";
import { DiscordService } from "@/lib/services/discord/discordService";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { discordMessagesQuerySchema } from "@/lib/validators/discord";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/discord/messages - handler");
  const url = new URL(request.url);

  const payload = {
    channelId: url.searchParams.get("channelId") ?? "",
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    before: url.searchParams.get("before") ?? undefined,
    after: url.searchParams.get("after") ?? undefined,
  };

  const validated = validateSchema(discordMessagesQuerySchema, payload);
  logger.info("Discord messages validated", { channelId: validated.channelId, limit: validated.limit });

  const res = await DiscordService.listMessages(validated.channelId, {
    limit: validated.limit,
    before: validated.before,
    after: validated.after,
  });
  return { message: "Message list", data: res };
});
