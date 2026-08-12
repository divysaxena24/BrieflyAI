/**
 * Production delivery — composition (Phase 5J STEP 8).
 *
 * Wires the channel publisher over an injected (or empty) sender registry.
 *
 * STOP CONDITION (documented, per architecture rules): no real sender
 * exists in the repository for Email/Discord/Telegram (the Telegram/Discord
 * services are 501 placeholders, Gmail is read-only, and the notifications
 * service is a 501 placeholder). The
 * application must inject real `ChannelSender`s through the factory; the
 * production singleton ships with an empty registry, so a publish to any
 * channel yields a structured `channel_sender_missing` outcome — never a
 * fabricated sender and never a throw.
 */

import { ChannelPublisher, ChannelPublisherRegistry, type DigestRecipientResolver } from "./channels";
import type { ChannelSender } from "./types";

/** Build a fresh production channel registry over `senders` (empty default). */
export function createProductionChannelRegistry(
  senders: readonly ChannelSender[] = [],
): ChannelPublisherRegistry {
  return new ChannelPublisherRegistry(senders);
}

/**
 * Build a fresh production channel publisher over `senders` (empty default —
 * every channel yields a structured `channel_sender_missing` outcome until
 * the application injects real senders). `resolveRecipients` maps digest
 * recipients to channel recipients (none by default).
 */
export function createProductionChannelPublisher(
  senders: readonly ChannelSender[] = [],
  options: {
    readonly maxRetries?: number;
    readonly retryDelayMs?: number;
    readonly resolveRecipients?: DigestRecipientResolver;
  } = {},
): ChannelPublisher {
  return new ChannelPublisher(createProductionChannelRegistry(senders), options);
}

/**
 * The application's single production channel registry instance.
 * Empty by default (see the documented stop condition above).
 */
const productionChannelRegistry = createProductionChannelRegistry();

/** Return the application's single production channel registry instance. */
export function getProductionChannelRegistry(): ChannelPublisherRegistry {
  return productionChannelRegistry;
}

/**
 * The application's single production channel publisher instance.
 * Empty registry by default — publishing reports `channel_sender_missing`
 * until the application wires real senders.
 */
const productionChannelPublisher = createProductionChannelPublisher();

/** Return the application's single production channel publisher instance. */
export function getProductionChannelPublisher(): ChannelPublisher {
  return productionChannelPublisher;
}
