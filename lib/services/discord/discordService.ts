import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getUserIntegrationByPlatform, findUserByAuthId, logActivity } from "@/lib/db/queries";
import discordTokenManager from "@/lib/services/integrations/discordTokenManager";
import { DiscordClient } from "./discordClient";

const PLATFORM = "discord"; // matches the platform stored by OAuth callback

/**
 * Structured log meta with the platform tag, mirroring the google-logger style.
 */
function logMeta(meta?: Record<string, unknown>) {
  return { platform: "discord", ...(meta ?? {}) };
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

/** Raw guild payload returned by the Discord REST API (GET /users/@me/guilds). */
interface RawGuild {
  id?: string;
  name?: string;
  icon?: string | null;
  owner?: boolean;
  permissions?: string;
  approximate_member_count?: number;
  member_count?: number;
  features?: string[];
  joined_at?: string | null;
}

export interface GuildSummary {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  /** Only available when Discord returns it (with_counts / member_count). */
  memberCount: number | null;
  features: string[];
  /** Only available when Discord returns it. */
  joinedAt: string | null;
}

export interface ListGuildsResult {
  guilds: GuildSummary[];
  // Discord's /users/@me/guilds returns all guilds in one response — no
  // Link-header cursor pagination (unlike GitHub), so hasMore is always false.
  pagination: { hasMore: boolean };
}

/** Raw channel payload returned by the Discord REST API (GET /guilds/{guildId}/channels). */
interface RawChannel {
  id?: string;
  guild_id?: string;
  name?: string;
  type?: number;
  position?: number;
  topic?: string | null;
  parent_id?: string | null;
  nsfw?: boolean;
}

export interface ChannelSummary {
  id: string;
  guildId: string;
  name: string;
  type: number;
  position: number;
  topic: string | null;
  parentId: string | null;
  nsfw: boolean;
}

export interface ListChannelsResult {
  channels: ChannelSummary[];
}

// Discord channel types that can carry readable messages (the Read Channels
// feature). Voice/category/thread/stage channels are not message-bearing for
// this product, so they are filtered out.
const SUPPORTED_CHANNEL_TYPES = new Set([0, 5, 15, 16]); // GUILD_TEXT, GUILD_ANNOUNCEMENT, GUILD_FORUM, GUILD_MEDIA

/** Raw message payload returned by the Discord REST API (GET /channels/{channelId}/messages). */
interface RawMessage {
  id?: string;
  channel_id?: string;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
  } | null;
  content?: string;
  timestamp?: string | null;
  edited_timestamp?: string | null;
  attachments?: Array<{ id?: string; filename?: string; url?: string }>;
  embeds?: Array<{ title?: string | null; description?: string | null; url?: string | null }>;
  pinned?: boolean;
  mentions?: Array<{ id?: string; username?: string; global_name?: string | null }>;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  url: string;
}

export interface MessageEmbed {
  title: string | null;
  description: string | null;
  url: string | null;
}

export interface MessageMention {
  id: string;
  username: string;
}

export interface MessageSummary {
  id: string;
  channelId: string;
  authorId: string | null;
  authorName: string | null;
  authorAvatar: string | null;
  content: string;
  timestamp: string | null;
  editedTimestamp: string | null;
  attachments: MessageAttachment[];
  embeds: MessageEmbed[];
  pinned: boolean;
  mentions: MessageMention[];
}

export interface ListMessagesParams {
  limit?: number;
  before?: string;
  after?: string;
}

export interface ListMessagesResult {
  messages: MessageSummary[];
}

export interface SearchMessagesParams {
  /** Required — the text to search for (case-insensitive match on message content). */
  query: string;
  /** Optional — scope the search to a single guild's text channels. */
  guildId?: string;
  /** Optional — scope the search to specific channel ids. */
  channelIds?: string[];
  /** Optional — messages to read per channel (clamped to 100 by listMessages). */
  limit?: number;
}

export interface SearchMessagesResult {
  messages: MessageSummary[];
  totalMatches: number;
  searchedChannels: number;
}

// ──────────────────────────────────────────────
//  Service
// ──────────────────────────────────────────────

/**
 * Discord guilds service.
 * Mirrors the GitHubService architecture: resolves the current user +
 * integration, delegates HTTP to DiscordClient (no direct fetch()), maps raw
 * payloads to typed shapes, logs activity asynchronously, and maps errors to
 * AppError (invalidating the token on 401).
 */
export class DiscordService {
  /**
   * Resolve the current user + their Discord integration and build a client.
   * DiscordClient takes the integrationId and resolves a valid token itself via
   * discordTokenManager.getValidAccessToken() on every request.
   */
  static async createClientForUser() {
    const user = await getCurrentUser();
    if (!user) throw new AppError("Not authenticated", 401, "authentication_required");

    // Resolve the application user ID — getCurrentUser() returns auth.users.id,
    // but integrations.user_id references users.id (the application-level ID)
    const appUser = await findUserByAuthId(user.id);
    if (!appUser) throw new AppError("User not found", 404, "user_not_found");

    const integration = await getUserIntegrationByPlatform(appUser.id, PLATFORM);
    if (!integration) throw new AppError("No Discord integration found for user", 404, "discord_not_connected");

    logger.debug("DiscordService: creating client", logMeta({ integrationId: integration.id }));
    return { client: new DiscordClient(integration.id), integration };
  }

  // ── Mappers ────────────────────────────────

  static toGuildSummary(raw: RawGuild): GuildSummary {
    return {
      id: raw.id ?? "",
      name: raw.name ?? "",
      icon: raw.icon ?? null,
      owner: raw.owner ?? false,
      permissions: raw.permissions ?? "",
      memberCount: raw.approximate_member_count ?? raw.member_count ?? null,
      features: raw.features ?? [],
      joinedAt: raw.joined_at ?? null,
    };
  }

  static toChannelSummary(raw: RawChannel): ChannelSummary {
    return {
      id: raw.id ?? "",
      guildId: raw.guild_id ?? "",
      name: raw.name ?? "",
      type: raw.type ?? 0,
      position: raw.position ?? 0,
      topic: raw.topic ?? null,
      parentId: raw.parent_id ?? null,
      nsfw: raw.nsfw ?? false,
    };
  }

  static toMessageSummary(raw: RawMessage): MessageSummary {
    const authorId = raw.author?.id ?? null;
    const avatarHash = raw.author?.avatar ?? null;

    // Avatar CDN URL: https://cdn.discordapp.com/avatars/{user_id}/{hash}.png
    // (use .gif when the hash starts with "a_", which denotes an animated avatar)
    let authorAvatar: string | null = null;
    if (authorId && avatarHash) {
      const ext = avatarHash.startsWith("a_") ? "gif" : "png";
      authorAvatar = `https://cdn.discordapp.com/avatars/${authorId}/${avatarHash}.${ext}`;
    }

    return {
      id: raw.id ?? "",
      channelId: raw.channel_id ?? "",
      authorId,
      authorName: raw.author?.global_name ?? raw.author?.username ?? null,
      authorAvatar,
      content: raw.content ?? "",
      timestamp: raw.timestamp ?? null,
      editedTimestamp: raw.edited_timestamp ?? null,
      attachments: (raw.attachments ?? []).map((a) => ({
        id: a.id ?? "",
        filename: a.filename ?? "",
        url: a.url ?? "",
      })),
      embeds: (raw.embeds ?? []).map((e) => ({
        title: e.title ?? null,
        description: e.description ?? null,
        url: e.url ?? null,
      })),
      pinned: raw.pinned ?? false,
      mentions: (raw.mentions ?? []).map((m) => ({
        id: m.id ?? "",
        username: m.username ?? "",
      })),
    };
  }

  // ── Methods ────────────────────────────────

  /**
   * List the authenticated user's Discord servers.
   * GET /users/@me/guilds — supports cursor params (before/after/limit) and
   * with_counts for approximate member counts.
   */
  static async listGuilds(): Promise<ListGuildsResult> {
    logger.info("DiscordService: listGuilds request received", logMeta());
    const { client, integration } = await DiscordService.createClientForUser();
    try {
      const res = await client.get<RawGuild[]>("/users/@me/guilds", {
        query: { with_counts: 1 },
      });

      const guilds = (Array.isArray(res.data) ? res.data : []).map((g) => DiscordService.toGuildSummary(g));

      logger.info("DiscordService: guilds returned", logMeta({ count: guilds.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Discord Servers",
        details: `Viewed ${guilds.length} Discord servers`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { guilds, pagination: { hasMore: false } };
    } catch (err) {
      logger.error("DiscordService: listGuilds failed", logMeta({ error: String(err) }));
      return DiscordService.handleError(err, integration.id);
    }
  }

  /**
   * List the message-bearing channels of a Discord guild.
   * GET /guilds/{guildId}/channels — unsupported channel types are filtered out.
   */
  static async listChannels(guildId: string): Promise<ListChannelsResult> {
    logger.info("DiscordService: listChannels request received", logMeta({ guildId }));
    const { client, integration } = await DiscordService.createClientForUser();
    try {
      const res = await client.get<RawChannel[]>(`/guilds/${encodeURIComponent(guildId)}/channels`);

      const channels = (Array.isArray(res.data) ? res.data : [])
        .filter((c) => SUPPORTED_CHANNEL_TYPES.has(c.type ?? -1))
        .map((c) => DiscordService.toChannelSummary(c));

      logger.info("DiscordService: channels returned", logMeta({ guildId, count: channels.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Discord Channels",
        details: `Viewed ${channels.length} channels in guild ${guildId}`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { channels };
    } catch (err) {
      logger.error("DiscordService: listChannels failed", logMeta({ guildId, error: String(err) }));
      return DiscordService.handleError(err, integration.id);
    }
  }

  /**
   * List messages from a Discord channel.
   * GET /channels/{channelId}/messages — supports optional limit/before/after.
   */
  static async listMessages(channelId: string, params: ListMessagesParams = {}): Promise<ListMessagesResult> {
    logger.info("DiscordService: listMessages request received", logMeta({ channelId, params }));
    const { client, integration } = await DiscordService.createClientForUser();
    try {
      // Discord rejects limit > 100 with 400 — clamp defensively (mirrors the
      // GitHub validator's perPage max(100) cap). Undefined falls back to Discord's default.
      const limit = params.limit ? Math.min(params.limit, 100) : undefined;
      const res = await client.get<RawMessage[]>(`/channels/${encodeURIComponent(channelId)}/messages`, {
        query: {
          limit,
          before: params.before,
          after: params.after,
        },
      });

      const messages = (Array.isArray(res.data) ? res.data : []).map((m) => DiscordService.toMessageSummary(m));

      logger.info("DiscordService: messages returned", logMeta({ channelId, count: messages.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Discord Messages",
        details: `Viewed ${messages.length} messages in channel ${channelId}`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { messages };
    } catch (err) {
      logger.error("DiscordService: listMessages failed", logMeta({ channelId, error: String(err) }));
      return DiscordService.handleError(err, integration.id);
    }
  }

  /**
   * Search Discord messages across accessible text channels.
   *
   * Discord has no native global message-search API for OAuth applications, so
   * this reads messages from the resolved channels via listMessages() and
   * filters them locally with a case-insensitive content match.
   *
   * Channel resolution priority: explicit channelIds > guildId > all accessible
   * text channels (listGuilds + listChannels per guild).
   */
  static async searchMessages(params: SearchMessagesParams): Promise<SearchMessagesResult> {
    logger.info("DiscordService: searchMessages request received", logMeta({ params }));
    // Fail fast on an empty query before resolving the user + integration (DB work)
    const q = params.query.trim().toLowerCase();
    if (!q) throw new AppError("Search query is required", 400, "bad_request");

    const { integration } = await DiscordService.createClientForUser();
    try {

      // Resolve the channels to search across (dedupe caller-supplied ids)
      let channelIds = Array.from(new Set(params.channelIds ?? []));
      if (channelIds.length === 0) {
        if (params.guildId) {
          const channels = await DiscordService.listChannels(params.guildId);
          channelIds = channels.channels.map((c) => c.id);
        } else {
          const guilds = await DiscordService.listGuilds();
          for (const guild of guilds.guilds) {
            const channels = await DiscordService.listChannels(guild.id);
            channelIds.push(...channels.channels.map((c) => c.id));
          }
        }
      }

      // Read messages per channel — listMessages() owns the limit clamp (max 100)
      // and falls back to Discord's default when limit is undefined.
      const matches: MessageSummary[] = [];
      for (const channelId of channelIds) {
        const { messages } = await DiscordService.listMessages(channelId, { limit: params.limit });
        for (const m of messages) {
          if (m.content.toLowerCase().includes(q)) matches.push(m);
        }
      }

      logger.info("DiscordService: search completed", logMeta({ matches: matches.length, searchedChannels: channelIds.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Searched Discord Messages",
        details: `Searched for "${params.query}" across ${channelIds.length} channels`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { messages: matches, totalMatches: matches.length, searchedChannels: channelIds.length };
    } catch (err) {
      logger.error("DiscordService: searchMessages failed", logMeta({ error: String(err) }));
      return DiscordService.handleError(err, integration.id);
    }
  }

  // ── Error handling ─────────────────────────

  /**
   * Centralize error handling: DiscordClient already throws AppError (mapped via
   * mapDiscordError), so rethrow it (invalidating the token on 401 so the UI
   * surfaces reconnection). Wrap any unexpected error into a generic AppError.
   */
  private static async handleError(err: unknown, integrationId: string): Promise<never> {
    if (err instanceof AppError) {
      if (err.status === 401) {
        try {
          await discordTokenManager.invalidate(integrationId);
        } catch (e) {
          logger.debug("DiscordService: failed to invalidate token", logMeta({ integrationId, error: String(e) }));
        }
      }
      throw err;
    }
    // Unexpected (non-AppError) failure — preserve the original message for debugging
    const detail = err instanceof Error ? err.message : String(err);
    throw new AppError("Discord API error", 502, "discord_error", detail);
  }
}

export default DiscordService;
