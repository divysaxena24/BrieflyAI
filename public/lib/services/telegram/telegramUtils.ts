/**
 * Generic Telegram Bot API utilities.
 * Designed to be reused by future Chats and Messages services.
 */

const BASE = "https://api.telegram.org";

// ──────────────────────────────────────────────
//  Bot URL builder
// ──────────────────────────────────────────────

/**
 * Build the Bot API URL for a given method with the bot token embedded in the
 * path: https://api.telegram.org/bot<TOKEN>/<method>.
 * The token belongs in the URL path — Telegram has no Authorization-header
 * convention for bots (unlike GitHub/Discord).
 */
export function buildBotUrl(token: string, method: string): string {
  const cleanMethod = method.replace(/^\//, "");
  return `${BASE}/bot${token}/${cleanMethod}`;
}

// ──────────────────────────────────────────────
//  Chat id extraction
// ──────────────────────────────────────────────

/**
 * Extract a chat id from a Telegram share URL ("https://t.me/{chat}"),
 * a numeric chat id, or a "@username" / "username" reference.
 * Returns null when it cannot be determined.
 */
export function parseChatId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full URL form: https://t.me/{chat} or https://telegram.me/{chat}
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "t.me" && url.hostname !== "telegram.me") return null;
      const segments = url.pathname.split("/").filter(Boolean);
      return segments[0] ?? null;
    } catch {
      return null;
    }
  }

  // Numeric chat id or @username reference
  if (/^\d+$/.test(trimmed)) return trimmed;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

// ──────────────────────────────────────────────
//  Message id extraction
// ──────────────────────────────────────────────

/**
 * Extract a message id from a Telegram message URL
 * ("https://t.me/{chat}/{messageId}") or a bare numeric id.
 * Returns null when it cannot be determined.
 */
export function parseMessageId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full URL form: https://t.me/{chat}/{messageId}
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "t.me" && url.hostname !== "telegram.me") return null;
      const segments = url.pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1];
      return last && /^\d+$/.test(last) ? last : null;
    } catch {
      return null;
    }
  }

  // Bare numeric message id
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

// ──────────────────────────────────────────────
//  Chat type predicate
// ──────────────────────────────────────────────

/**
 * True when a Telegram Chat object is a private 1:1 chat (the user's own
 * account). Bots can only read a private chat once the user has started it.
 */
export function isPrivateChat(chat: { type?: string } | null | undefined): boolean {
  return chat?.type === "private";
}

export default {
  buildBotUrl,
  parseChatId,
  parseMessageId,
  isPrivateChat,
};
