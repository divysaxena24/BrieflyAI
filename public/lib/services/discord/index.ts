// ──────────────────────────────────────────────
//  Discord services barrel
//  Reusable HTTP layer (client/errors/utils).
//  Guilds / Channels / Messages services come later.
// ──────────────────────────────────────────────

export * from "./discordClient";
export * from "./discordErrors";
export * from "./discordUtils";

import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Placeholder kept for backward compatibility until the Discord service
 * (guilds/channels/messages) is implemented in a later phase.
 */
export async function listServers() {
  logger.debug("Discord: listServers called (placeholder)");
  throw new AppError("Discord service not implemented", 501, "not_implemented");
}

export const discordService = { listServers };

export default discordService;
