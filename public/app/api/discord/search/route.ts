import { withHandler } from "@/lib/api/handler";
import { DiscordService } from "@/lib/services/discord/discordService";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { discordSearchQuerySchema } from "@/lib/validators/discord";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/discord/search - handler");
  const url = new URL(request.url);

  const rawChannelIds = url.searchParams.getAll("channelIds");
  const payload = {
    query: url.searchParams.get("query") ?? "",
    guildId: url.searchParams.get("guildId") ?? undefined,
    channelIds: rawChannelIds.length > 0 ? rawChannelIds : undefined,
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
  };

  const validated = validateSchema(discordSearchQuerySchema, payload);
  logger.info("Discord search validated", { query: validated.query, guildId: validated.guildId, limit: validated.limit });

  const res = await DiscordService.searchMessages({
    query: validated.query,
    guildId: validated.guildId,
    channelIds: validated.channelIds,
    limit: validated.limit,
  });
  return { message: "Message search results", data: res };
});
