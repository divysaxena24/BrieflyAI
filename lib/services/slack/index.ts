import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function listSlackChannels() {
  logger.debug("Slack: listSlackChannels called (placeholder)");
  throw new AppError("Slack service not implemented", 501, "not_implemented");
}

export const slackService = { listSlackChannels };

export default slackService;
