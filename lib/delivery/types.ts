/**
 * Production delivery — channel types (Phase 5J STEP 8).
 *
 * The delivery abstraction over the digest layer's `DigestPublisher`: a
 * digest is formatted once and dispatched per recipient through a
 * `ChannelSender` — the transport seam for Email/Discord/Telegram/WhatsApp.
 *
 * STOP CONDITION (documented, per architecture rules): no production sender
 * exists in the repository for any of these channels — Telegram/Discord
 * services are 501 placeholders, WhatsApp/Gmail are read-only, and the
 * notifications service is a 501 placeholder. This layer therefore defines
 * the real *adapters* (registry + publisher with failure isolation and
 * config-only retry) and requires senders to be injected; the production
 * wiring ships with an empty registry so a publish to any channel yields a
 * structured `channel_sender_missing` result instead of inventing a sender.
 */

import { hashString } from "@/lib/hash";

/** The four delivery channels the application may deliver to. */
export type DeliveryChannel = "email" | "discord" | "telegram" | "whatsapp";

/** Every delivery channel, in a stable canonical order. */
export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = Object.freeze([
  "email",
  "discord",
  "telegram",
  "whatsapp",
]);

/** A single delivery destination on a channel. */
export interface ChannelRecipient {
  readonly channel: DeliveryChannel;
  /** The destination address (email, chat id, username, phone...). */
  readonly address: string;
  /** Optional human-readable label. */
  readonly label?: string;
}

/** Input accepted by {@link createChannelRecipient}. */
export interface CreateChannelRecipientInput {
  readonly channel: DeliveryChannel;
  readonly address: string;
  readonly label?: string;
}

/** Build an immutable channel recipient (frozen; id deterministic). */
export function createChannelRecipient(input: CreateChannelRecipientInput): ChannelRecipient {
  return Object.freeze({
    channel: input.channel,
    address: input.address,
    ...(input.label !== undefined ? { label: input.label } : {}),
    id: `recipient-${hashString(`${input.channel}:${input.address}`)}`,
  });
}

/** Detached, unfrozen copy of a recipient. */
export function cloneChannelRecipient(recipient: ChannelRecipient): ChannelRecipient {
  return {
    channel: recipient.channel,
    address: recipient.address,
    ...(recipient.label !== undefined ? { label: recipient.label } : {}),
    ...("id" in recipient ? { id: (recipient as { id: string }).id } : {}),
  };
}

/** Stable hash of a recipient's identity (channel + address). */
export function hashChannelRecipient(recipient: ChannelRecipient): string {
  return hashString(`${recipient.channel}:${recipient.address}`);
}

/** Input handed to a {@link ChannelSender.send}. */
export interface ChannelSendInput {
  readonly recipient: ChannelRecipient;
  /** Optional subject line (email) / caption. */
  readonly subject?: string;
  /** The formatted content to deliver. */
  readonly content: string;
}

/** Structured output of a single send attempt. */
export interface ChannelSendOutput {
  readonly ok: boolean;
  /** Provider message on success (e.g. message id). */
  readonly message?: string;
  /** Structured failure detail when not ok. */
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * The transport seam for one channel. Applications implement `send` with a
 * real provider (Gmail API, Telegram Bot API, Discord webhook, WhatsApp
 * Baileys) — none exists in the repository today (documented stop
 * condition), so senders are dependency-injected.
 */
export interface ChannelSender {
  readonly channel: DeliveryChannel;
  send(input: ChannelSendInput): Promise<ChannelSendOutput>;
}
