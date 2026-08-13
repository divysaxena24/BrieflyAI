import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getUserIntegrationByPlatform, findUserByAuthId, logActivity, updateIntegrationStatus } from "@/lib/db/queries";
import { DiscordClient } from "./discordClient";

const PLATFORM = "discord"; // matches the platform stored by OAuth callback

// ──────────────────────────────────────────────
//  Discord bot limitation
// ──────────────────────────────────────────────

/**
 * Canned explanation for features that need a Discord Bot.
 *
 * Discord's OAuth API grants no scope for reading guild channels or
 * messages: GET /guilds/{guildId}/channels and GET /channels/{channelId}/messages
 * are bot-only endpoints. An OAuth user Bearer token is rejected with 401
 * regardless of validity, and no amount of OAuth scopes or token refreshes
 * changes that.
 */
export const DISCORD_BOT_REQUIRED_TITLE = "Discord Bot Required";
export const DISCORD_BOT_REQUIRED_CODE = "discord_bot_required";
export const DISCORD_BOT_REQUIRED_MESSAGE =
  "Discord's OAuth API does not allow applications to read server channels or messages using a user login. " +
  "BrieflyAI currently connects using OAuth, which only grants access to your Discord profile and server list. " +
  "Reading channels and messages requires installing a Discord Bot in the server. " +
  "This feature is planned for a future release.";

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

/** Parameters kept for the unsupported (bot-only) listMessages surface. */
export interface ListMessagesParams {
  limit?: number;
  before?: string;
  after?: string;
}

/** Parameters kept for the unsupported (bot-only) searchMessages surface. */
export interface SearchMessagesParams {
  /** Required — the text to search for. */
  query: string;
  /** Optional — scope the search to a single guild. */
  guildId?: string;
  /** Optional — scope the search to specific channel ids. */
  channelIds?: string[];
  /** Optional — messages to read per channel. */
  limit?: number;
}

// ──────────────────────────────────────────────
//  Service
// ──────────────────────────────────────────────

/**
 * Discord service.
 *
 * Only the OAuth-supported capability is implemented: listing the user's
 * servers via GET /users/@me/guilds (Bearers token + `guilds` scope).
 * Channel/message reads are bot-only endpoints with no OAuth scope — those
 * methods fail fast with the "Discord Bot Required" explanation instead of
 * attempting requests that would 401, burn a token refresh, and falsely mark
 * the healthy integration as needing reconnection.
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
   *
   * GET /guilds/{guildId}/channels is a BOT-ONLY endpoint — Discord's OAuth
   * API has no scope for it, so an OAuth user token always gets 401. Fail
   * fast with the honest explanation instead of attempting the request
   * (which would also burn a token refresh and falsely mark the healthy
   * integration as needs_reconnect).
   */
  static async listChannels(guildId: string): Promise<never> {
    logger.info("DiscordService: listChannels blocked — requires a Discord bot", logMeta({ guildId }));
    return DiscordService.unsupported();
  }

  /**
   * List messages from a Discord channel.
   *
   * GET /channels/{channelId}/messages is a BOT-ONLY endpoint — same OAuth
   * limitation as listChannels. Fail fast with the honest explanation.
   */
  static async listMessages(channelId: string, params: ListMessagesParams = {}): Promise<never> {
    logger.info("DiscordService: listMessages blocked — requires a Discord bot", logMeta({ channelId, params }));
    return DiscordService.unsupported();
  }

  /**
   * Search Discord messages across channels.
   *
   * Same bot-only limitation as listMessages — Discord has no OAuth-scoped
   * message search. Fail fast with the honest explanation.
   */
  static async searchMessages(params: SearchMessagesParams): Promise<never> {
    logger.info("DiscordService: searchMessages blocked — requires a Discord bot", logMeta({ params }));
    return DiscordService.unsupported();
  }

  /**
   * Throw the canned "Discord Bot Required" explanation.
   *
   * HTTP 200 is intentional: this is an informational limitation of the OAuth
   * connection, not a failure of the request — the client must receive the
   * explanation without treating it as an error (and without the 401 path
   * that would refresh tokens / mark the integration needs_reconnect).
   */
  private static unsupported(): never {
    throw new AppError(DISCORD_BOT_REQUIRED_MESSAGE, 200, DISCORD_BOT_REQUIRED_CODE);
  }

  // ── Error handling ─────────────────────────

  /**
   * Centralize error handling: DiscordClient already throws AppError (mapped via
   * mapDiscordError), so rethrow it. On 401 the integration is marked as
   * needing reconnection so the UI surfaces it — the token row is deliberately
   * NOT invalidated (invalidate() wipes the refresh token, which is what turned
   * a recoverable expired token into a permanent "Refresh token missing" state).
   * Wrap any unexpected error into a generic AppError.
   */
  private static async handleError(err: unknown, integrationId: string): Promise<never> {
    if (err instanceof AppError) {
      if (err.status === 401) {
        try {
          await updateIntegrationStatus(integrationId, "needs_reconnect");
          logger.info("DiscordService: integration marked needs_reconnect", logMeta({ integrationId }));
        } catch (e) {
          logger.debug("DiscordService: failed to mark needs_reconnect", logMeta({ integrationId, error: String(e) }));
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
