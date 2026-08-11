import type { WAMessage } from "@whiskeysockets/baileys";

/**
 * Normalize a protobuf numeric value to a plain number.
 * WhatsApp protobuf fields are `number | Long | string | null` — this covers
 * Long objects (via .toNumber()) and numeric strings.
 */
export function normalizeNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Convert a WhatsApp epoch-seconds timestamp to an ISO string.
 * Returns null when the value is missing/zero or cannot be parsed.
 */
export function toIso(seconds: unknown): string | null {
  const s = normalizeNumber(seconds);
  if (!s) return null;
  const date = new Date(s * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Extract the user-visible text from a WhatsApp message.
 * Covers plain conversation text, extended text messages, and media captions.
 */
export function extractMessageText(msg: WAMessage): string {
  const body = msg.message;
  if (!body) return "";
  return (
    body.conversation ??
    body.extendedTextMessage?.text ??
    body.imageMessage?.caption ??
    body.videoMessage?.caption ??
    body.documentMessage?.caption ??
    body.buttonsResponseMessage?.selectedButtonId ??
    body.contactMessage?.displayName ??
    ""
  );
}

/**
 * Format a WhatsApp JID as a clean phone number.
 *
 * Raw JIDs include the domain and a device suffix, e.g.
 * "917024296567:96@s.whatsapp.net" → "917024296567". Returns null when the
 * JID does not look like a phone number (e.g. group ids, status broadcasts).
 */
export function formatWhatsAppPhone(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const local = jid.split("@")[0] ?? "";
  // Drop the ":<device>" suffix ("917024296567:96" → "917024296567")
  const phone = local.split(":")[0];
  return /^\d{5,15}$/.test(phone) ? phone : null;
}
