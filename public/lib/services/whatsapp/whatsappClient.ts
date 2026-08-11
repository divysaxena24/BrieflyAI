import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Chat, WAMessage } from "@whiskeysockets/baileys";
import { whatsappSessionManager } from "./whatsappSessionManager";

/**
 * Structured log meta with the platform tag, mirroring the other service layers.
 */
function logMeta(meta?: Record<string, unknown>) {
  return { platform: "whatsapp", ...(meta ?? {}) };
}

/**
 * Session-based WhatsApp client.
 *
 * WhatsApp authenticates through the LIVE Baileys socket — there are NO
 * oauth_tokens, access tokens, refresh tokens, or token managers. Every read
 * resolves the exact same socket the connect flow established via
 * whatsappSessionManager.getSession(integrationId) and serves data from its
 * in-memory store. No endpoint ever creates a second socket.
 */
export class WhatsAppClient {
  private readonly integrationId: string;

  constructor(integrationId: string) {
    this.integrationId = integrationId;
  }

  /**
   * Ensure the live socket exists (the one and only session). Throws a 409
   * when the session is not open — it is session-based auth, not token-based.
   */
  private requireLiveSocket(): void {
    if (!whatsappSessionManager.getSession(this.integrationId)) {
      logger.warn("WhatsApp: no live session", logMeta({ integrationId: this.integrationId }));
      throw new AppError(
        "WhatsApp is not connected — scan the QR code to link your device",
        409,
        "whatsapp_not_connected",
      );
    }
  }

  /** Chats from the live session's store, most recent first. */
  async listChats(): Promise<Chat[]> {
    this.requireLiveSocket();
    return whatsappSessionManager.getChats(this.integrationId);
  }

  /** Messages for a chat from the live session's store, most recent first. */
  async loadMessages(chatId: string, limit?: number): Promise<WAMessage[]> {
    this.requireLiveSocket();
    return whatsappSessionManager.getMessages(this.integrationId, chatId, limit);
  }

  /** Case-insensitive text search over the live session's stored messages. */
  async searchMessages(query: string): Promise<WAMessage[]> {
    this.requireLiveSocket();
    return whatsappSessionManager.searchMessages(this.integrationId, query);
  }

  /** Resolve a contact name for a jid (used for chat-list display names). */
  async getContactName(jid: string): Promise<string | null> {
    this.requireLiveSocket();
    return whatsappSessionManager.getContactName(this.integrationId, jid);
  }
}

export default WhatsAppClient;
