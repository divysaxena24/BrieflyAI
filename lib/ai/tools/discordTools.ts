/**
 * AI layer — Discord tools.
 *
 * Three tools that reuse the existing production `DiscordService`:
 *
 * - `discord.channelSummary`    → messages from a (resolved) text channel
 * - `discord.recentMessages`    → recent real messages with a configurable limit
 * - `discord.extractActionItems` → recent messages for action-item extraction
 *
 * Channel resolution: when `guildId`/`channelId` are omitted, the tools use
 * the user's first server and its first message-bearing text channel — real
 * data from `listGuilds`/`listChannels`, never invented.
 */

import { z } from "zod";
import type { Tool } from "@/lib/tools/types";
import DiscordService from "@/lib/services/discord/discordService";
import type {
  ChannelSummary,
  GuildSummary,
  ListChannelsResult,
  ListGuildsResult,
  ListMessagesParams,
  ListMessagesResult,
  MessageSummary,
} from "@/lib/services/discord/discordService";
import { AppError } from "@/lib/errors";
import { toolSuccess, truncate, type AIToolResult, type AIToolSource } from "./types";

/** Default / maximum messages read from a channel. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Cap for message content kept in normalized data. */
const CONTENT_MAX = 400;

const channelInputSchema = z.object({
  /** Discord guild (server) id; defaults to the user's first guild. */
  guildId: z.string().min(1).optional(),
  /** Discord text-channel id; defaults to the first message-bearing channel. */
  channelId: z.string().min(1).optional(),
  /** Optional maximum number of messages (1-100). */
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type ChannelToolInput = z.infer<typeof channelInputSchema>;

/**
 * Minimal structural surface of the production Discord service used by the
 * tools (mirrors `lib/services/discord/discordService.ts`).
 */
export interface DiscordToolService {
  listGuilds(): Promise<ListGuildsResult>;
  listChannels(guildId: string): Promise<ListChannelsResult>;
  listMessages(channelId: string, params?: ListMessagesParams): Promise<ListMessagesResult>;
}

/** A resolved channel target. */
export interface ResolvedChannel {
  guild: GuildSummary;
  channel: ChannelSummary;
}

/** Resolve a text channel from explicit ids or real defaults. */
export async function resolveChannel(
  service: DiscordToolService,
  guildId?: string,
  channelId?: string,
): Promise<ResolvedChannel> {
  let guild: GuildSummary;
  if (guildId) {
    guild = { id: guildId, name: guildId, icon: null, owner: false, permissions: "", memberCount: null, features: [], joinedAt: null };
  } else {
    const { guilds } = await service.listGuilds();
    const first = guilds[0];
    if (!first) throw new AppError("No Discord servers found for user", 404, "no_discord_guilds");
    guild = first;
  }

  let channel: ChannelSummary;
  if (channelId) {
    channel = { id: channelId, guildId: guild.id, name: channelId, type: 0, position: 0, topic: null, parentId: null, nsfw: false };
  } else {
    const { channels } = await service.listChannels(guild.id);
    const first = channels[0];
    if (!first) throw new AppError("No message channels found in the Discord server", 404, "no_discord_channels");
    channel = first;
  }
  return { guild, channel };
}

/** Normalize a message for display + LLM context. */
export function toMessageSummary(message: MessageSummary) {
  return {
    id: message.id,
    authorName: message.authorName ?? "Unknown",
    content: truncate(message.content, CONTENT_MAX),
    timestamp: message.timestamp ?? null,
    pinned: message.pinned,
  };
}

/** Source reference for a message. */
function messageSource(message: MessageSummary): AIToolSource {
  return {
    integration: "discord",
    type: "message",
    id: message.id,
    title: message.authorName ?? undefined,
  };
}

async function fetchChannelMessages(
  service: DiscordToolService,
  input: ChannelToolInput,
): Promise<{ resolved: ResolvedChannel; messages: MessageSummary[] }> {
  const resolved = await resolveChannel(service, input.guildId, input.channelId);
  const { messages } = await service.listMessages(resolved.channel.id, {
    limit: input.limit ?? DEFAULT_LIMIT,
  });
  return { resolved, messages };
}

/** Summarize the discussion in a Discord channel. */
export class DiscordChannelSummaryTool implements Tool {
  readonly id = "discord.channelSummary";
  readonly description = "Fetch recent messages from a Discord channel for discussion summarization.";
  readonly inputSchema = channelInputSchema;

  constructor(private readonly service: DiscordToolService = DiscordService) {}

  async execute(input: ChannelToolInput): Promise<AIToolResult> {
    const { resolved, messages } = await fetchChannelMessages(this.service, input);
    return toolSuccess(
      this.id,
      {
        guild: { id: resolved.guild.id, name: resolved.guild.name },
        channel: { id: resolved.channel.id, name: resolved.channel.name },
        count: messages.length,
        messages: messages.map(toMessageSummary),
      },
      messages.map(messageSource),
    );
  }
}

/** Return recent real messages from a Discord channel. */
export class DiscordRecentMessagesTool implements Tool {
  readonly id = "discord.recentMessages";
  readonly description = "List recent messages from a Discord channel.";
  readonly inputSchema = channelInputSchema;

  constructor(private readonly service: DiscordToolService = DiscordService) {}

  async execute(input: ChannelToolInput): Promise<AIToolResult> {
    const { resolved, messages } = await fetchChannelMessages(this.service, input);
    return toolSuccess(
      this.id,
      {
        guild: { id: resolved.guild.id, name: resolved.guild.name },
        channel: { id: resolved.channel.id, name: resolved.channel.name },
        count: messages.length,
        messages: messages.map(toMessageSummary),
      },
      messages.map(messageSource),
    );
  }
}

/** Fetch recent messages for action-item extraction (done by Groq upstream). */
export class DiscordExtractActionItemsTool implements Tool {
  readonly id = "discord.extractActionItems";
  readonly description = "Fetch recent Discord channel messages to extract action items from.";
  readonly inputSchema = channelInputSchema;

  constructor(private readonly service: DiscordToolService = DiscordService) {}

  async execute(input: ChannelToolInput): Promise<AIToolResult> {
    const { resolved, messages } = await fetchChannelMessages(this.service, input);
    return toolSuccess(
      this.id,
      {
        guild: { id: resolved.guild.id, name: resolved.guild.name },
        channel: { id: resolved.channel.id, name: resolved.channel.name },
        count: messages.length,
        messages: messages.map(toMessageSummary),
      },
      messages.map(messageSource),
    );
  }
}
