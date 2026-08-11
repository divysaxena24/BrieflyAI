import { z } from "zod";

// Query params for GET /api/discord/channels
// guildId is required
export const discordChannelsQuerySchema = z.object({
  guildId: z.string().min(1),
});

// Query params for GET /api/discord/messages
// channelId is required; limit/before/after are optional
export const discordMessagesQuerySchema = z.object({
  channelId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
});

// Query params for GET /api/discord/search
// query is required; guildId/channelIds/limit are optional
export const discordSearchQuerySchema = z.object({
  query: z.string().min(1),
  guildId: z.string().min(1).optional(),
  channelIds: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type DiscordChannelsQuery = z.infer<typeof discordChannelsQuerySchema>;
export type DiscordMessagesQuery = z.infer<typeof discordMessagesQuerySchema>;
export type DiscordSearchQuery = z.infer<typeof discordSearchQuerySchema>;
