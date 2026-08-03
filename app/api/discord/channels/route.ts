import { withHandler } from "@/lib/api/handler";
import { DiscordService } from "@/lib/services/discord/discordService";
import { logger } from "@/lib/logger";
import { validateSchema } from "@/lib/validators";
import { discordChannelsQuerySchema } from "@/lib/validators/discord";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (request: Request) => {
  logger.debug("GET /api/discord/channels - handler");
  const url = new URL(request.url);

  const payload = {
    guildId: url.searchParams.get("guildId") ?? "",
  };

  const validated = validateSchema(discordChannelsQuerySchema, payload);
  logger.info("Discord channels validated", { guildId: validated.guildId });

  const res = await DiscordService.listChannels(validated.guildId);
  return { message: "Channel list", data: res };
});
