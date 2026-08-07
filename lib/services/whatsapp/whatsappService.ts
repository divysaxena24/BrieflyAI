import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getUserIntegrationByPlatform, findUserByAuthId, logActivity } from "@/lib/db/queries";
import type { Chat, WAMessage } from "@whiskeysockets/baileys";
import { whatsappSessionManager } from "./whatsappSessionManager";
import { WhatsAppClient } from "./whatsappClient";
import { extractMessageText, normalizeNumber, toIso } from "./whatsappUtils";

const PLATFORM = "whatsapp"; // matches the platform stored by the connect flow

/**
 * Structured log meta with the platform tag, mirroring the other service layers.
 */
function logMeta(meta?: Record<string, unknown>) {
  return { platform: "whatsapp", ...(meta ?? {}) };
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ChatSummary {
  id: string;
  name: string;
  /** ISO timestamp of the last message in the chat, or null. */
  lastMessageAt: string | null;
  unreadCount: number;
  pinned: boolean;
  archived: boolean;
}

export interface MessageSummary {
  id: string;
  chatId: string;
  fromMe: boolean;
  senderName: string | null;
  text: string;
  /** ISO timestamp, or null when the message has no timestamp. */
  timestamp: string | null;
}

export interface ListChatsResult {
  chats: ChatSummary[];
}

export interface ListMessagesParams {
  /** The chat jid (e.g. "15551234567@s.whatsapp.net"). */
  chatId: string;
  limit?: number;
}

export interface ListMessagesResult {
  messages: MessageSummary[];
}

export interface SearchMessagesParams {
  query: string;
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
 * WhatsApp read service (chats / messages / search).
 *
 * WhatsApp authenticates through the LIVE Baileys session — NOT through
 * oauth_tokens / access tokens / refresh tokens / token managers. The flow is:
 *
 *   auth user → app user → integration → integration.id → active session
 *
 * createClientForUser() resolves that chain and hands back a WhatsAppClient
 * bound to the one authenticated socket, so every endpoint reuses the exact
 * same session (no second socket is ever created).
 */
export class WhatsAppService {
  /**
   * Resolve the current user + their WhatsApp integration and build a client
   * bound to the LIVE Baileys session. Never touches OAuth credentials.
   */
  static async createClientForUser() {
    const user = await getCurrentUser();
    if (!user) throw new AppError("Not authenticated", 401, "authentication_required");

    // Resolve the application user ID — getCurrentUser() returns auth.users.id,
    // but integrations.user_id references users.id (the application-level ID)
    const appUser = await findUserByAuthId(user.id);
    if (!appUser) throw new AppError("User not found", 404, "user_not_found");

    const integration = await getUserIntegrationByPlatform(appUser.id, PLATFORM);
    if (!integration) throw new AppError("No WhatsApp integration found for user", 404, "whatsapp_not_connected");

    // Session-based auth: resolve the ACTIVE Baileys socket (restoring it from
    // disk after a server restart) and bind the client to that same session.
    await WhatsAppService.resolveActiveSocket(integration.id);

    logger.debug("WhatsAppService: creating client", logMeta({ integrationId: integration.id }));
    return { client: new WhatsAppClient(integration.id), integration };
  }

  /**
   * Resolve the active Baileys socket for an integration.
   *
   * When the session is not in memory (e.g. after a server restart), restore it
   * from the persisted auth folder via createSession() — idempotent, and it
   * reconnects WITHOUT requiring a new QR scan (creds are saved to disk). Waits
   * up to ~10s for the restored session to reach "open" before giving up.
   */
  static async resolveActiveSocket(integrationId: string) {
    let socket = whatsappSessionManager.getSession(integrationId);
    if (!socket) {
      logger.info("WhatsAppService: restoring session from disk", logMeta({ integrationId }));
      await whatsappSessionManager.createSession(integrationId);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        socket = whatsappSessionManager.getSession(integrationId);
        if (socket) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!socket) {
      throw new AppError(
        "WhatsApp is not connected — scan the QR code to link your device",
        409,
        "whatsapp_not_connected",
      );
    }
    return socket;
  }

  // ── Mappers ────────────────────────────────

  static async toChatSummary(raw: Chat, client: WhatsAppClient): Promise<ChatSummary> {
    const contactName = raw.id ? await client.getContactName(raw.id) : null;
    const lastTs = normalizeNumber(raw.lastMessageRecvTimestamp ?? raw.conversationTimestamp);
    return {
      id: raw.id ?? "",
      name: contactName ?? raw.name ?? "",
      lastMessageAt: toIso(lastTs),
      unreadCount: normalizeNumber(raw.unreadCount),
      // proto.I* fields may be number | boolean — coerce to a real boolean
      pinned: Boolean(raw.pinned ?? false),
      archived: Boolean(raw.archived ?? false),
    };
  }

  static toMessageSummary(raw: WAMessage): MessageSummary {
    const key = raw.key;
    return {
      id: key?.id ?? "",
      chatId: key?.remoteJid ?? "",
      fromMe: key?.fromMe ?? false,
      senderName: key?.fromMe ? "You" : (raw.pushName ?? null),
      text: extractMessageText(raw),
      timestamp: toIso(raw.messageTimestamp),
    };
  }

  // ── Methods ────────────────────────────────

  /**
   * List the chats visible to the live WhatsApp session, most recent first.
   */
  static async listChats(): Promise<ListChatsResult> {
    logger.info("WhatsAppService: listChats request received", logMeta());
    const { client, integration } = await WhatsAppService.createClientForUser();
    try {
      const rawChats = await client.listChats();
      const chats = await Promise.all(rawChats.map((chat) => WhatsAppService.toChatSummary(chat, client)));

      logger.info("WhatsAppService: chats returned", logMeta({ count: chats.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed WhatsApp Chats",
        details: `Viewed ${chats.length} WhatsApp chats`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { chats };
    } catch (err) {
      logger.error("WhatsAppService: listChats failed", logMeta({ error: String(err) }));
      return WhatsAppService.handleError(err);
    }
  }

  /**
   * List messages for a specific chat (jid) from the live session's store,
   * most recent first.
   */
  static async listMessages(params: ListMessagesParams): Promise<ListMessagesResult> {
    logger.info("WhatsAppService: listMessages request received", logMeta({ chatId: params.chatId }));
    const { client, integration } = await WhatsAppService.createClientForUser();
    try {
      const rawMessages = await client.loadMessages(params.chatId, params.limit);
      const messages = rawMessages.map(WhatsAppService.toMessageSummary);

      logger.info("WhatsAppService: messages returned", logMeta({ chatId: params.chatId, count: messages.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed WhatsApp Messages",
        details: `Viewed ${messages.length} messages in chat ${params.chatId}`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { messages };
    } catch (err) {
      logger.error("WhatsAppService: listMessages failed", logMeta({ chatId: params.chatId, error: String(err) }));
      return WhatsAppService.handleError(err);
    }
  }

  /**
   * Search WhatsApp messages (conversation text + captions) in the live
   * session's store with a case-insensitive match.
   */
  static async searchMessages(params: SearchMessagesParams): Promise<SearchMessagesResult> {
    logger.info("WhatsAppService: searchMessages request received", logMeta({ params }));
    // Fail fast on an empty query before resolving the user + integration (DB work)
    const q = params.query.trim();
    if (!q) throw new AppError("Search query is required", 400, "bad_request");

    const { client, integration } = await WhatsAppService.createClientForUser();
    try {
      const chats = await client.listChats();
      const messages = (await client.searchMessages(q))
        .map(WhatsAppService.toMessageSummary)
        .slice(0, params.limit ?? 100);

      logger.info("WhatsAppService: search completed", logMeta({ matches: messages.length, searchedChats: chats.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Searched WhatsApp Messages",
        details: `Searched for "${params.query}" across ${chats.length} chats`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { messages, totalMatches: messages.length, searchedChats: chats.length };
    } catch (err) {
      logger.error("WhatsAppService: searchMessages failed", logMeta({ error: String(err) }));
      return WhatsAppService.handleError(err);
    }
  }

  // ── Error handling ─────────────────────────

  /**
   * Centralize error handling: WhatsAppClient/SessionManager already throw
   * AppError, so rethrow it as-is. There is NO token to invalidate — WhatsApp
   * authenticates via the live session. Wrap unexpected errors generically.
   */
  private static async handleError(err: unknown): Promise<never> {
    if (err instanceof AppError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new AppError("WhatsApp API error", 502, "whatsapp_error", detail);
  }
}

export default WhatsAppService;
