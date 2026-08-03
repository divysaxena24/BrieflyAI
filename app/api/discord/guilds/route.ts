import { withHandler } from "@/lib/api/handler";
import { DiscordService } from "@/lib/services/discord/discordService";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const GET = withHandler(async (_request: Request) => {
  logger.debug("GET /api/discord/guilds - handler");

  const res = await DiscordService.listGuilds();
  return { message: "Guild list", data: res };
});
