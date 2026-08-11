import { promises as fs } from "fs";
import os from "os";
import path from "path";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState as loadMultiFileAuthState,
  type Chat,
  type ConnectionState,
  type Contact,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { extractMessageText, normalizeNumber } from "./whatsappUtils";

/**
 * Structured log meta with the platform tag, mirroring the other service layers.
 */
function logMeta(meta?: Record<string, unknown>) {
  return { platform: "whatsapp", ...(meta ?? {}) };
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export type WhatsAppSessionState = "connecting" | "qr" | "open" | "close" | "logged-out";

/** Snapshot of a session's connection state, consumed by the provider/status route. */
export interface WhatsAppSessionInfo {
  integrationId: string;
  state: WhatsAppSessionState;
  /** Raw QR string (rendered client-side) — null when unavailable or after a scan. */
  qr: string | null;
  /** ISO timestamp of the last successful connection — null before the first open. */
  connectedAt: string | null;
  /** Why the connection last closed: "logged-out", "connection-lost", or null. */
  lastDisconnectReason: string | null;
}

/** Internal per-session bookkeeping. */
interface SessionEntry {
  integrationId: string;
  /** Folder where useMultiFileAuthState() persists creds + signal keys. */
  authFolder: string;
  socket: WASocket | null;
  state: WhatsAppSessionState;
  qr: string | null;
  connectedAt: string | null;
  lastDisconnectReason: string | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  /** True once disconnect()/removeSession() runs — blocks auto-reconnect. */
  disposed: boolean;

  // ── Read store (populated from Baileys events on the live socket) ──
  /** jid → chat, from messaging-history.set / chats.upsert / chats.update */
  chats: Map<string, Chat>;
  /** message key → message, from messaging-history.set / messages.upsert */
  messages: Map<string, WAMessage>;
  /** jid → contact, from messaging-history.set / contacts.upsert / contacts.update */
  contacts: Map<string, Contact>;
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

const DEFAULT_SESSIONS_DIR = path.join(os.tmpdir(), "briefly-whatsapp-sessions");
const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_STORED_MESSAGES = 5_000;

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Extract the Boom statusCode from a Baileys disconnect error when present.
 * Baileys wraps close reasons in @hapi/boom errors carrying `output.statusCode`;
 * plain Errors return null.
 */
function getDisconnectStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const output = (error as { output?: { statusCode?: number } }).output;
  return typeof output?.statusCode === "number" ? output.statusCode : null;
}

// ──────────────────────────────────────────────
//  Session manager
// ──────────────────────────────────────────────

/**
 * Owns one Baileys socket per integration in an in-memory Map.
 *
 * Responsibilities:
 * - Start a WhatsApp session (QR pairing) for an integration.
 * - Persist credentials via useMultiFileAuthState() and save them automatically.
 * - Reconnect automatically after a disconnect, unless the session was logged out.
 * - Expose read/teardown methods for the provider and future service layer.
 *
 * No database access and no provider logic — the provider decides when to call
 * createSession()/removeSession().
 */
export class WhatsAppSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionsDir: string;
  private readonly reconnectDelayMs: number;

  constructor(options?: { sessionsDir?: string; reconnectDelayMs?: number }) {
    this.sessionsDir = options?.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    this.reconnectDelayMs = options?.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  // ── Lifecycle ───────────────────────────────

  /**
   * Start a WhatsApp session for an integration. Idempotent — returns the
   * existing session when one is already active. A previously logged-out
   * session is torn down and restarted fresh (it cannot be revived).
   */
  async createSession(integrationId: string): Promise<WhatsAppSessionInfo> {
    if (!integrationId.trim()) {
      throw new AppError("integrationId is required", 400, "bad_request");
    }

    const existing = this.sessions.get(integrationId);
    if (existing && !existing.disposed && existing.state !== "logged-out") {
      logger.debug("WhatsAppSessionManager: session already exists", logMeta({ integrationId }));
      return this.toSessionInfo(existing);
    }
    if (existing) {
      logger.info("WhatsAppSessionManager: replacing logged-out session", logMeta({ integrationId }));
      this.teardown(existing);
    }

    const entry: SessionEntry = {
      integrationId,
      authFolder: path.join(this.sessionsDir, integrationId),
      socket: null,
      state: "connecting",
      qr: null,
      connectedAt: null,
      lastDisconnectReason: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      disposed: false,
      chats: new Map(),
      messages: new Map(),
      contacts: new Map(),
    };
    this.sessions.set(integrationId, entry);

    try {
      await this.establishSocket(integrationId, entry);
    } catch (err) {
      this.sessions.delete(integrationId);
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("WhatsAppSessionManager: failed to start session", logMeta({ integrationId, error: detail }));
      throw new AppError("Failed to start WhatsApp session", 502, "whatsapp_session_error", detail);
    }

    return this.toSessionInfo(entry);
  }

  /**
   * Gracefully close the socket and drop the in-memory session. Persisted
   * credentials are kept on disk, so a later createSession() reconnects without
   * requiring a new QR scan.
   */
  async disconnect(integrationId: string): Promise<void> {
    const entry = this.getRequiredEntry(integrationId);
    const socket = entry.socket;
    this.teardown(entry);

    if (socket) {
      try {
        await socket.end(undefined);
      } catch (err) {
        logger.warn("WhatsAppSessionManager: socket end failed", logMeta({ integrationId, error: String(err) }));
      }
      // Defensive: make sure the underlying WebSocket is actually closed
      try {
        await socket.ws.close();
      } catch (err) {
        logger.debug("WhatsAppSessionManager: ws close skipped (already closed)", logMeta({ integrationId, error: String(err) }));
      }
    }
    logger.info("WhatsAppSessionManager: session disconnected", logMeta({ integrationId }));
  }

  /**
   * Fully log out of WhatsApp and delete the persisted session (auth folder),
   * so the next connect requires a fresh QR scan. Used when the user
   * disconnects the integration.
   */
  async removeSession(integrationId: string): Promise<void> {
    const entry = this.getRequiredEntry(integrationId);
    const { socket, authFolder } = entry;
    this.teardown(entry);

    if (socket) {
      try {
        await socket.logout();
      } catch (err) {
        logger.warn("WhatsAppSessionManager: logout failed (session may already be invalid)", logMeta({ integrationId, error: String(err) }));
      }
    }

    try {
      await fs.rm(authFolder, { recursive: true, force: true });
      logger.info("WhatsAppSessionManager: session removed", logMeta({ integrationId }));
    } catch (err) {
      logger.warn("WhatsAppSessionManager: failed to delete session folder", logMeta({ integrationId, error: String(err) }));
    }
  }

  // ── Reads ───────────────────────────────────

  /**
   * Return the live socket when the session is open, or null otherwise.
   * Pair with getConnectionState() to distinguish "not started" from
   * "connecting / waiting for QR".
   */
  getSession(integrationId: string): WASocket | null {
    const entry = this.sessions.get(integrationId);
    if (!entry || entry.disposed || entry.state !== "open") return null;
    return entry.socket;
  }

  /** Return the current QR string for a session, or null while none is available. */
  getCurrentQr(integrationId: string): string | null {
    const entry = this.getRequiredEntry(integrationId);
    return entry.qr;
  }

  /** Return a snapshot of the session's connection state, or null when absent. */
  getConnectionState(integrationId: string): WhatsAppSessionInfo | null {
    const entry = this.sessions.get(integrationId);
    if (!entry || entry.disposed) return null;
    return this.toSessionInfo(entry);
  }

  // ── Read store accessors ────────────────────

  /**
   * Chats currently in the live session's store, most recent first.
   * Returns [] until the history sync has delivered data. Reads the same
   * socket's store — never creates a second session.
   */
  getChats(integrationId: string): Chat[] {
    const entry = this.getRequiredEntry(integrationId);
    return Array.from(entry.chats.values()).sort(
      (a, b) =>
        normalizeNumber(b.lastMessageRecvTimestamp ?? b.conversationTimestamp) -
        normalizeNumber(a.lastMessageRecvTimestamp ?? a.conversationTimestamp),
    );
  }

  /**
   * Messages for a single chat (jid), most recent first, optionally limited.
   */
  getMessages(integrationId: string, chatId: string, limit = 50): WAMessage[] {
    const entry = this.getRequiredEntry(integrationId);
    const messages = Array.from(entry.messages.values())
      .filter((m) => m.key?.remoteJid === chatId)
      .sort((a, b) => normalizeNumber(b.messageTimestamp) - normalizeNumber(a.messageTimestamp));
    return limit > 0 ? messages.slice(0, limit) : messages;
  }

  /**
   * Case-insensitive text search over the messages in the live session's store
   * (conversation text, extended text, and media captions).
   */
  searchMessages(integrationId: string, query: string): WAMessage[] {
    const entry = this.getRequiredEntry(integrationId);
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Array.from(entry.messages.values())
      .filter((m) => extractMessageText(m).toLowerCase().includes(q))
      .sort((a, b) => normalizeNumber(b.messageTimestamp) - normalizeNumber(a.messageTimestamp))
      .slice(0, 100);
  }

  /** The contact name for a jid (1:1 chats), or null when unknown. */
  getContactName(integrationId: string, jid: string): string | null {
    const entry = this.getRequiredEntry(integrationId);
    const contact = entry.contacts.get(jid);
    return contact?.name ?? contact?.notify ?? null;
  }

  // ── Store helpers ───────────────────────────

  /** Dedupe key for a stored message (chat + direction + id). */
  private static messageKey(msg: WAMessage): string {
    return `${msg.key?.remoteJid ?? "?"}|${msg.key?.fromMe ? "out" : "in"}|${msg.key?.id ?? "?"}`;
  }

  /** Insert a message into the store, evicting the oldest when over the cap. */
  private addMessage(entry: SessionEntry, msg: WAMessage): void {
    entry.messages.set(WhatsAppSessionManager.messageKey(msg), msg);
    if (entry.messages.size > MAX_STORED_MESSAGES) {
      const oldest = Array.from(entry.messages.values()).sort(
        (a, b) => normalizeNumber(a.messageTimestamp) - normalizeNumber(b.messageTimestamp),
      )[0];
      if (oldest) entry.messages.delete(WhatsAppSessionManager.messageKey(oldest));
    }
  }

  // ── Internals ───────────────────────────────

  /**
   * Create (or re-create) the socket for a session entry and wire the event
   * handlers. Safe to call again on reconnect.
   *
   * TODO(whatsapp): swap useMultiFileAuthState() for a Postgres-backed auth
   * state once deployed on a persistent host — Baileys explicitly recommends a
   * proper DB-backed state for production (file-based state is a stopgap).
   */
  private async establishSocket(integrationId: string, entry: SessionEntry): Promise<void> {
    // Renamed on import (`use`-prefix) so eslint's react-hooks rule doesn't
    // mistake Baileys' helper for a React hook.
    const { state, saveCreds } = await loadMultiFileAuthState(entry.authFolder);

    // Teardown may have run while the auth state was loading — bail without
    // creating a socket so a disposed session never leaks a connection.
    if (entry.disposed) return;

    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      // Ask the phone for full history so AI summaries have more to work with
      syncFullHistory: true,
    });

    entry.socket = socket;
    entry.state = "connecting";
    entry.qr = null;

    // Save credentials automatically whenever Baileys refreshes them
    socket.ev.on("creds.update", () => {
      saveCreds().catch((err) => {
        logger.warn("WhatsAppSessionManager: failed to persist credentials", logMeta({ integrationId, error: String(err) }));
      });
    });

    socket.ev.on("connection.update", (update) => {
      this.handleConnectionUpdate(integrationId, entry, update);
    });

    // ── Read store ────────────────────────────────────────
    // Populate the in-memory chat/message/contact store from Baileys events so
    // the WhatsApp read endpoints (chats/messages/search) can serve data from
    // the SAME live session — no second socket and no OAuth tokens. The full
    // history sync (syncFullHistory) emits messaging-history.set on connect;
    // messages.upsert keeps the store current while connected. After a server
    // restart, the restored session re-syncs and repopulates this store.
    socket.ev.on("messaging-history.set", ({ chats, messages, contacts }) => {
      if (entry.disposed) return;
      entry.chats.clear();
      for (const chat of chats) {
        if (chat.id) entry.chats.set(chat.id, chat);
      }
      entry.contacts.clear();
      for (const contact of contacts) {
        if (contact.id) entry.contacts.set(contact.id, contact);
      }
      entry.messages.clear();
      for (const msg of messages) {
        this.addMessage(entry, msg);
      }
      logger.debug(
        "WhatsAppSessionManager: history store updated",
        logMeta({ integrationId, chats: entry.chats.size, messages: entry.messages.size }),
      );
    });

    socket.ev.on("messages.upsert", ({ messages }) => {
      if (entry.disposed) return;
      for (const msg of messages) {
        this.addMessage(entry, msg);
      }
    });

    socket.ev.on("chats.upsert", (chats) => {
      if (entry.disposed) return;
      for (const chat of chats) {
        if (chat.id) entry.chats.set(chat.id, chat);
      }
    });

    socket.ev.on("chats.update", (updates) => {
      if (entry.disposed) return;
      for (const update of updates) {
        if (!update.id) continue;
        const existing = entry.chats.get(update.id);
        entry.chats.set(update.id, existing ? { ...existing, ...update } as Chat : update as Chat);
      }
    });

    socket.ev.on("chats.delete", (ids) => {
      if (entry.disposed) return;
      for (const id of ids) entry.chats.delete(id);
    });

    socket.ev.on("contacts.upsert", (contacts) => {
      if (entry.disposed) return;
      for (const contact of contacts) {
        if (contact.id) entry.contacts.set(contact.id, contact);
      }
    });

    socket.ev.on("contacts.update", (updates) => {
      if (entry.disposed) return;
      for (const update of updates) {
        if (!update.id) continue;
        const existing = entry.contacts.get(update.id);
        entry.contacts.set(update.id, existing ? { ...existing, ...update } as Contact : update as Contact);
      }
    });

    logger.info("WhatsAppSessionManager: socket created", logMeta({ integrationId }));
  }

  private handleConnectionUpdate(integrationId: string, entry: SessionEntry, update: Partial<ConnectionState>): void {
    if (entry.disposed) return;

    const { connection, qr, lastDisconnect } = update;

    // QR (re-issued every ~20-60s until scanned)
    if (qr) {
      entry.qr = qr;
      entry.state = "qr";
      return;
    }

    if (connection === "open") {
      entry.state = "open";
      entry.qr = null;
      entry.connectedAt = new Date().toISOString();
      entry.lastDisconnectReason = null;
      entry.reconnectAttempts = 0;
      logger.info("WhatsAppSessionManager: connection open", logMeta({ integrationId }));
      return;
    }

    if (connection === "connecting") {
      entry.state = "connecting";
      return;
    }

    if (connection === "close") {
      const statusCode = getDisconnectStatusCode(lastDisconnect?.error);
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      entry.qr = null;
      if (loggedOut) {
        entry.state = "logged-out";
        entry.lastDisconnectReason = "logged-out";
        logger.warn("WhatsAppSessionManager: session logged out", logMeta({ integrationId }));
        return;
      }

      // Unexpected close — reconnect automatically unless the session was torn down
      entry.state = "close";
      entry.lastDisconnectReason = "connection-lost";
      logger.warn("WhatsAppSessionManager: connection closed, reconnecting", logMeta({ integrationId, statusCode }));
      this.scheduleReconnect(integrationId, entry);
    }
  }

  /**
   * Schedule a reconnect with exponential backoff, capped at MAX_RECONNECT_DELAY_MS.
   * Gives up after MAX_RECONNECT_ATTEMPTS consecutive failures (attempts reset on open).
   */
  private scheduleReconnect(integrationId: string, entry: SessionEntry): void {
    if (entry.disposed) return;
    if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      entry.state = "close";
      entry.lastDisconnectReason = "reconnect-failed";
      logger.error(
        "WhatsAppSessionManager: giving up after repeated reconnect failures",
        logMeta({ integrationId, attempts: entry.reconnectAttempts }),
      );
      return;
    }
    const delay = Math.min(
      this.reconnectDelayMs * (2 ** entry.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);

    logger.info("WhatsAppSessionManager: reconnect scheduled", logMeta({ integrationId, delayMs: delay, attempt: entry.reconnectAttempts + 1 }));
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.reconnect(integrationId, entry);
    }, delay);
  }

  private async reconnect(integrationId: string, entry: SessionEntry): Promise<void> {
    if (entry.disposed) return;
    entry.reconnectAttempts += 1;
    try {
      await this.establishSocket(integrationId, entry);
    } catch (err) {
      logger.error("WhatsAppSessionManager: reconnect failed", logMeta({ integrationId, error: String(err) }));
      this.scheduleReconnect(integrationId, entry);
    }
  }

  /** Mark an entry disposed, cancel any pending reconnect, and drop it from the map. */
  private teardown(entry: SessionEntry): void {
    entry.disposed = true;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    this.sessions.delete(entry.integrationId);
    logger.debug("WhatsAppSessionManager: session torn down", logMeta({ integrationId: entry.integrationId }));
  }

  private getRequiredEntry(integrationId: string): SessionEntry {
    const entry = this.sessions.get(integrationId);
    if (!entry || entry.disposed) {
      throw new AppError("WhatsApp session not found", 404, "whatsapp_session_not_found");
    }
    return entry;
  }

  private toSessionInfo(entry: SessionEntry): WhatsAppSessionInfo {
    return {
      integrationId: entry.integrationId,
      state: entry.state,
      qr: entry.qr,
      connectedAt: entry.connectedAt,
      lastDisconnectReason: entry.lastDisconnectReason,
    };
  }
}

// Singleton shared across the server process (mirrors the token managers)
export const whatsappSessionManager = new WhatsAppSessionManager();

export default whatsappSessionManager;
