import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getUserIntegrationByPlatform, findUserByAuthId, logActivity } from "@/lib/db/queries";
import telegramTokenManager from "@/lib/services/integrations/telegramTokenManager";
import { TelegramClient } from "./telegramClient";

const PLATFORM = "telegram"; // matches the platform stored by the connect flow

/**
 * Structured log meta with the platform tag, mirroring the google-logger style.
 */
function logMeta(meta?: Record<string, unknown>) {
  return { platform: "telegram", ...(meta ?? {}) };
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

/** Raw bot user payload returned by the Bot API (GET /getMe). */
interface RawUser {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/** Raw chat payload returned by the Bot API (GET /getChat). */
interface RawChat {
  id?: number;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  description?: string | null;
  invite_link?: string | null;
  has_private_forwards?: boolean;
  member_count?: number;
}

/**
 * Common shape of Telegram attachment media (document/video/audio/voice/
 * sticker/animation/video_note all carry these fields).
 */
interface RawMedia {
  file_id?: string;
  file_name?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  duration?: number;
  is_animated?: boolean;
}

/** Raw message payload embedded in updates (GET /getUpdates). */
interface RawMessage {
  message_id?: number;
  chat?: RawChat;
  from?: RawUser;
  date?: number;
  text?: string;
  caption?: string;
  document?: RawMedia;
  photo?: Array<{ file_id?: string; file_size?: number | null }>;
  video?: RawMedia;
  audio?: RawMedia;
  voice?: RawMedia;
  sticker?: RawMedia;
  animation?: RawMedia;
  video_note?: RawMedia;
}

/** Raw update payload returned by GET /getUpdates. */
interface RawUpdate {
  update_id?: number;
  message?: RawMessage;
  edited_message?: RawMessage;
  channel_post?: RawMessage;
  edited_channel_post?: RawMessage;
  callback_query?: { message?: RawMessage };
}

export interface BotInfo {
  id: number;
  username: string | null;
  firstName: string;
  isBot: boolean;
}

export interface ChatSummary {
  id: number;
  title: string;
  username: string | null;
  type: string;
}

export interface ListChatsResult {
  chats: ChatSummary[];
}

export interface ChatDetail {
  id: number;
  type: string;
  title: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  description: string | null;
  inviteLink: string | null;
  memberCount: number | null;
  hasPrivateForwards: boolean;
}

export interface TelegramAttachment {
  /** "document" | "photo" | "video" | "audio" | "voice" | "sticker" | "animation" | "video_note" */
  type: string;
  fileId: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

export interface MessageSummary {
  id: number;
  chatId: number;
  senderId: number | null;
  senderName: string | null;
  text: string;
  /** ISO timestamp — Telegram's `date` is unix epoch seconds. */
  date: string | null;
  attachments: TelegramAttachment[];
}

export interface ListMessagesResult {
  messages: MessageSummary[];
}

export interface SearchMessagesParams {
  /** Required — the text to search for (case-insensitive match on message text). */
  query: string;
  /** Optional — scope the search to specific chat ids. */
  chatIds?: string[];
  /** Optional — max messages to return (clamped to 100). */
  limit?: number;
}

export interface SearchMessagesResult {
  messages: MessageSummary[];
  totalMatches: number;
  searchedChats: number;
}

// ──────────────────────────────────────────────
//  Service
// ──────────────────────────────────────────────

/**
 * Telegram bot service.
 * Mirrors the GitHub/Discord service architecture: resolves the current user +
 * integration, delegates HTTP to TelegramClient (no direct fetch()), maps raw
 * payloads to typed shapes, logs activity asynchronously, and maps errors to
 * AppError (invalidating the bot token on 401).
 */
export class TelegramService {
  /**
   * Resolve the current user + their Telegram integration and build a client.
   * TelegramClient takes the integrationId and resolves a valid bot token
   * itself via telegramTokenManager.getValidAccessToken() on every request.
   */
  static async createClientForUser() {
    const user = await getCurrentUser();
    if (!user) throw new AppError("Not authenticated", 401, "authentication_required");

    // Resolve the application user ID — getCurrentUser() returns auth.users.id,
    // but integrations.user_id references users.id (the application-level ID)
    const appUser = await findUserByAuthId(user.id);
    if (!appUser) throw new AppError("User not found", 404, "user_not_found");

    const integration = await getUserIntegrationByPlatform(appUser.id, PLATFORM);
    if (!integration) throw new AppError("No Telegram integration found for user", 404, "telegram_not_connected");

    logger.debug("TelegramService: creating client", logMeta({ integrationId: integration.id }));
    return { client: new TelegramClient(integration.id), integration };
  }

  // ── Mappers ────────────────────────────────

  static toChatDetail(raw: RawChat): ChatDetail {
    return {
      id: raw.id ?? 0,
      type: raw.type ?? "unknown",
      title: raw.title ?? null,
      username: raw.username ?? null,
      firstName: raw.first_name ?? null,
      lastName: raw.last_name ?? null,
      description: raw.description ?? null,
      inviteLink: raw.invite_link ?? null,
      memberCount: raw.member_count ?? null,
      hasPrivateForwards: raw.has_private_forwards ?? false,
    };
  }

  static toMessageSummary(raw: RawMessage): MessageSummary {
    const sender = raw.from;
    const fullName = sender
      ? [sender.first_name, sender.last_name].filter(Boolean).join(" ").trim() || null
      : null;

    return {
      id: raw.message_id ?? 0,
      chatId: raw.chat?.id ?? 0,
      senderId: sender?.id ?? null,
      senderName: fullName ?? sender?.username ?? null,
      text: raw.text ?? raw.caption ?? "",
      date: raw.date ? new Date(raw.date * 1000).toISOString() : null,
      attachments: TelegramService.toAttachments(raw),
    };
  }

  static toAttachments(raw: RawMessage): TelegramAttachment[] {
    const attachments: TelegramAttachment[] = [];

    TelegramService.pushAttachment(attachments, "document", raw.document);
    TelegramService.pushAttachment(attachments, "video", raw.video);
    TelegramService.pushAttachment(attachments, "audio", raw.audio);
    TelegramService.pushAttachment(attachments, "voice", raw.voice);
    TelegramService.pushAttachment(attachments, "sticker", raw.sticker);
    TelegramService.pushAttachment(attachments, "animation", raw.animation);
    TelegramService.pushAttachment(attachments, "video_note", raw.video_note);

    // Photo is an array of sizes — use the largest (last) one
    if (Array.isArray(raw.photo) && raw.photo.length > 0) {
      const largest = raw.photo[raw.photo.length - 1];
      attachments.push({
        type: "photo",
        fileId: largest?.file_id ?? "",
        fileName: null,
        mimeType: "image/jpeg",
        fileSize: largest?.file_size ?? null,
      });
    }

    return attachments;
  }

  // ── Helpers ────────────────────────────────

  /**
   * Collect the message-bearing objects from a single update. An update carries
   * at most one message; the `*_message` / `channel_post` fields cover edited
   * messages, channel posts, and callback queries.
   */
  private static collectMessages(update: RawUpdate): RawMessage[] {
    const messages: RawMessage[] = [];
    if (update.message) messages.push(update.message);
    if (update.edited_message) messages.push(update.edited_message);
    if (update.channel_post) messages.push(update.channel_post);
    if (update.edited_channel_post) messages.push(update.edited_channel_post);
    if (update.callback_query?.message) messages.push(update.callback_query.message);
    return messages;
  }

  /** Push a Telegram media field into the attachments list when present. */
  private static pushAttachment(attachments: TelegramAttachment[], type: string, media?: RawMedia): void {
    if (!media) return;
    attachments.push({
      type,
      fileId: media.file_id ?? "",
      fileName: media.file_name ?? null,
      mimeType: media.mime_type ?? null,
      fileSize: media.file_size ?? null,
    });
  }

  // ── Methods ────────────────────────────────

  /**
   * Verify the connected bot and return its identity.
   * GET /getMe — returns the bot's id, username, first name, and is_bot flag.
   */
  static async verifyBot(): Promise<BotInfo> {
    logger.info("TelegramService: verifyBot request received", logMeta());
    const { client, integration } = await TelegramService.createClientForUser();
    try {
      const res = await client.get<RawUser>("/getMe");
      const info: BotInfo = {
        id: res.data.id ?? 0,
        username: res.data.username ?? null,
        firstName: res.data.first_name ?? "",
        isBot: res.data.is_bot ?? false,
      };

      logger.info("TelegramService: bot verified", logMeta({ botId: info.id, username: info.username }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Verify Bot",
        details: `Verified bot @${info.username ?? info.id}`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return info;
    } catch (err) {
      logger.error("TelegramService: verifyBot failed", logMeta({ error: String(err) }));
      return TelegramService.handleError(err, integration.id);
    }
  }

  /**
   * List the unique chats the bot has interacted with.
   * Reads the bot's update queue via GET /getUpdates and collects the distinct
   * chats from every message-bearing update (a bot can only see chats it has
   * received updates from).
   */
  static async listChats(): Promise<ListChatsResult> {
    logger.info("TelegramService: listChats request received", logMeta());
    const { client, integration } = await TelegramService.createClientForUser();
    try {
      const res = await client.get<RawUpdate[]>("/getUpdates");
      const updates = Array.isArray(res.data) ? res.data : [];

      // Collect unique chats (dedupe by chat id)
      const chatsById = new Map<number, ChatSummary>();
      for (const update of updates) {
        for (const raw of TelegramService.collectMessages(update)) {
          const chat = raw.chat;
          if (!chat || chat.id === undefined || chatsById.has(chat.id)) continue;
          chatsById.set(chat.id, {
            id: chat.id,
            title: chat.title ?? chat.first_name ?? chat.username ?? "",
            username: chat.username ?? null,
            type: chat.type ?? "unknown",
          });
        }
      }
      const chats = Array.from(chatsById.values());

      logger.info("TelegramService: chats returned", logMeta({ count: chats.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Telegram Chats",
        details: `Viewed ${chats.length} Telegram chats`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { chats };
    } catch (err) {
      logger.error("TelegramService: listChats failed", logMeta({ error: String(err) }));
      return TelegramService.handleError(err, integration.id);
    }
  }

  /**
   * Get a single chat's details (title, type, username, member count, invite link…).
   * GET /getChat — accepts a numeric chat id, @username, or t.me URL.
   */
  static async getChat(chatId: string): Promise<ChatDetail> {
    logger.info("TelegramService: getChat request received", logMeta({ chatId }));
    const { client, integration } = await TelegramService.createClientForUser();
    try {
      const res = await client.get<RawChat>("/getChat", { query: { chat_id: chatId } });
      const detail = TelegramService.toChatDetail(res.data);

      logger.info("TelegramService: chat returned", logMeta({ chatId: detail.id, type: detail.type }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Telegram Chat",
        details: `Viewed Telegram chat ${detail.title ?? detail.id}`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return detail;
    } catch (err) {
      logger.error("TelegramService: getChat failed", logMeta({ chatId, error: String(err) }));
      return TelegramService.handleError(err, integration.id);
    }
  }

  /**
   * List messages from a specific chat.
   * Reads the bot's update queue via GET /getUpdates and returns only the
   * messages that belong to the requested chat (a bot can only see messages it
   * has received updates from).
   */
  static async listMessages(chatId: string, limit?: number): Promise<ListMessagesResult> {
    logger.info("TelegramService: listMessages request received", logMeta({ chatId }));
    const { client, integration } = await TelegramService.createClientForUser();
    try {
      const res = await client.get<RawUpdate[]>("/getUpdates");
      const updates = Array.isArray(res.data) ? res.data : [];

      const messages = updates
        .flatMap((u) => TelegramService.collectMessages(u))
        .filter((m) => m.chat?.id !== undefined && String(m.chat.id) === String(chatId))
        .map((m) => TelegramService.toMessageSummary(m))
        .slice(0, limit ?? 100);

      logger.info("TelegramService: messages returned", logMeta({ chatId, count: messages.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Telegram Messages",
        details: `Viewed ${messages.length} messages in chat ${chatId}`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { messages };
    } catch (err) {
      logger.error("TelegramService: listMessages failed", logMeta({ chatId, error: String(err) }));
      return TelegramService.handleError(err, integration.id);
    }
  }

  /**
   * Search Telegram messages across the chats the bot can see.
   *
   * Telegram has no native message-search API for bots, so this lists the chats
   * (listChats) and reads each chat's messages via listMessages() — reusing the
   * same code path with no duplicated logic — then filters locally with a
   * case-insensitive content match.
   */
  static async searchMessages(params: SearchMessagesParams): Promise<SearchMessagesResult> {
    logger.info("TelegramService: searchMessages request received", logMeta({ params }));
    // Fail fast on an empty query before resolving the user + integration (DB work)
    const q = params.query.trim().toLowerCase();
    if (!q) throw new AppError("Search query is required", 400, "bad_request");

    const { integration } = await TelegramService.createClientForUser();
    try {
      let chats: ChatSummary[];
      if (params.chatIds && params.chatIds.length > 0) {
        // Use the caller-supplied chat ids directly — skip fetching all chats
        chats = params.chatIds.map((id) => ({
          id: Number(id),
          title: id,
          username: null,
          type: "unknown",
        }));
      } else {
        const result = await TelegramService.listChats();
        chats = result.chats;
      }

      const matches: MessageSummary[] = [];
      for (const chat of chats) {
        const { messages } = await TelegramService.listMessages(String(chat.id), params.limit);
        for (const m of messages) {
          if (m.text.toLowerCase().includes(q)) matches.push(m);
        }
      }

      logger.info("TelegramService: search completed", logMeta({ matches: matches.length, searchedChats: chats.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Searched Telegram Messages",
        details: `Searched for "${params.query}" across ${chats.length} chats`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { messages: matches, totalMatches: matches.length, searchedChats: chats.length };
    } catch (err) {
      logger.error("TelegramService: searchMessages failed", logMeta({ error: String(err) }));
      return TelegramService.handleError(err, integration.id);
    }
  }

  // ── Error handling ─────────────────────────

  /**
   * Centralize error handling: TelegramClient already throws AppError (mapped
   * via mapTelegramError), so rethrow it (invalidating the bot token on 401 so
   * the UI surfaces reconnection). 404 and 429 are rethrown as-is. Wrap any
   * unexpected error into a generic AppError.
   */
  private static async handleError(err: unknown, integrationId: string): Promise<never> {
    if (err instanceof AppError) {
      if (err.status === 401) {
        try {
          await telegramTokenManager.invalidate(integrationId);
        } catch (e) {
          logger.debug("TelegramService: failed to invalidate token", logMeta({ integrationId, error: String(e) }));
        }
      }
      throw err;
    }
    // Unexpected (non-AppError) failure — preserve the original message for debugging
    const detail = err instanceof Error ? err.message : String(err);
    throw new AppError("Telegram API error", 502, "telegram_error", detail);
  }
}

export default TelegramService;
