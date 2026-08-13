/**
 * AI layer — Discord tools.
 *
 * Two tools, honest about what the current Discord OAuth connection can do:
 *
 * - `discord.listGuilds`    → the user's servers (guilds) via
 *                             GET /users/@me/guilds (OAuth-supported)
 * - `discord.botRequired`   → canned explanation for channel/message reads,
 *                             which require a Discord Bot (not available via
 *                             OAuth user tokens)
 *
 * Discord's OAuth API grants no scope for reading guild channels or messages
 * (GET /guilds/{guildId}/channels and GET /channels/{channelId}/messages are
 * bot-only endpoints). These tools therefore NEVER call the Discord API for
 * unsupported work — they return the "Discord Bot Required" explanation
 * instead of attempting requests that would 401.
 */

import { z } from "zod";
import type { Tool } from "@/lib/tools/types";
import DiscordService, {
  DISCORD_BOT_REQUIRED_MESSAGE,
  DISCORD_BOT_REQUIRED_TITLE,
} from "@/lib/services/discord/discordService";
import type { GuildSummary, ListGuildsResult } from "@/lib/services/discord/discordService";
import { toolSuccess, type AIToolResult } from "./types";

const emptyInputSchema = z.object({});

/** Minimal structural surface of the production Discord service used by the
 * tools (mirrors `lib/services/discord/discordService.ts`). */
export interface DiscordToolService {
  listGuilds(): Promise<ListGuildsResult>;
}

/** Normalize a guild for display + LLM context. */
export function toGuildSummary(guild: GuildSummary) {
  return {
    id: guild.id,
    name: guild.name,
    icon: guild.icon,
    owner: guild.owner,
    memberCount: guild.memberCount,
    joinedAt: guild.joinedAt,
  };
}

/**
 * List the user's Discord servers (guilds) — the OAuth-supported feature.
 * GET /users/@me/guilds works with the user's Bearer token + `guilds` scope.
 */
export class DiscordListGuildsTool implements Tool {
  readonly id = "discord.listGuilds";
  readonly description =
    "List the user's Discord servers (guilds): names, member counts, and owner status. Use for \"show my Discord servers\", \"which Discord servers am I in\", or \"summarize my Discord servers\".";
  readonly inputSchema = emptyInputSchema;

  constructor(private readonly service: DiscordToolService = DiscordService) {}

  async execute(): Promise<AIToolResult> {
    const { guilds } = await this.service.listGuilds();
    return toolSuccess(
      this.id,
      {
        count: guilds.length,
        guilds: guilds.map(toGuildSummary),
      },
      guilds.map((guild) => ({
        integration: "discord",
        type: "guild",
        id: guild.id,
        title: guild.name,
      })),
    );
  }
}

/**
 * Answer for requests that need a Discord Bot (reading channels/messages).
 *
 * Discord's OAuth API cannot read guild channels or messages, and no OAuth
 * scope exists for it — these are bot-only endpoints. This tool NEVER calls
 * the Discord API; the orchestrator short-circuits it and returns the canned
 * explanation directly (HTTP 200).
 */
export class DiscordBotRequiredTool implements Tool {
  readonly id = "discord.botRequired";
  readonly description =
    "Answer when the user asks to read Discord channels, messages, chats, conversations, unread activity, or action items (e.g. \"recent Discord messages\", \"summarize a Discord channel\", \"what happened in #channel\"). The OAuth connection cannot read channels or messages — this returns the explanation that a Discord bot is required. Never call the Discord API.";
  readonly inputSchema = emptyInputSchema;
  readonly informational = {
    title: DISCORD_BOT_REQUIRED_TITLE,
    message: DISCORD_BOT_REQUIRED_MESSAGE,
  };

  async execute(): Promise<AIToolResult> {
    // Informational tools are short-circuited by the orchestrator, so this is
    // a safety net — it still returns the same canned explanation, no API call.
    return toolSuccess(this.id, { title: this.informational.title, message: this.informational.message }, []);
  }
}
