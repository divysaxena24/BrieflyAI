import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function listServers() {
  logger.debug("Discord: listServers called (placeholder)");
  throw new AppError("Discord service not implemented", 501, "not_implemented");
}

export const discordService = { listServers };

export default discordService;
