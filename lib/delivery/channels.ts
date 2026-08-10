/**
 * Production delivery — channel publishers (Phase 5J STEP 8).
 *
 * `ChannelPublisherRegistry` is an immutable registry of `ChannelSender`s
 * (successor `register`, snapshot `list`). `ChannelPublisher` implements the
 * digest layer's `DigestPublisher` contract: it formats each recipient's
 * content, dispatches through the registered sender, and reports a
 * structured per-recipient outcome.
 *
 * Guarantees:
 * - **Failure isolation**: a throwing sender or a `{ ok: false }` result
 *   never fails the other recipients or the caller — `publish` never throws.
 * - **Retry only when configured**: `maxRetries > 0` retries a failed send
 *   with the injected `sleep` (deterministic in tests); default is no
 *   retries (mirroring the job/action executor conventions).
 * - **No invented providers**: an unregistered channel yields a structured
 *   `channel_sender_missing` outcome.
 */

import { formatDigestAsPlain } from "@/lib/digest/delivery";
import type { DigestPublisher } from "@/lib/digest/delivery";
import type { Digest, DigestDelivery, DigestRecipient } from "@/lib/digest/types";
import type { ChannelRecipient, ChannelSender, ChannelSendOutput, DeliveryChannel } from "./types";

/** Error code used when no sender is registered for a channel. */
export const CHANNEL_SENDER_MISSING = "channel_sender_missing";

/**
 * Maps a generic digest recipient to the channel recipients to deliver to.
 * The application injects this resolver (e.g. from per-user channel
 * preferences); the default resolves to none, so a digest delivery carries no
 * channel destinations until wired.
 */
export type DigestRecipientResolver = (recipient: DigestRecipient) => readonly ChannelRecipient[];

/** The default resolver: no channel mapping (documented stop condition). */
const noChannelResolver: DigestRecipientResolver = () => [];

/**
 * Immutable collection of channel senders.
 *
 * `register` returns a *new* registry (throws on a duplicate channel);
 * `list` exposes a snapshot — mirroring the tool/action/handler registry
 * conventions.
 */
export class ChannelPublisherRegistry {
  private readonly senders: ReadonlyMap<DeliveryChannel, ChannelSender>;

  constructor(senders: readonly ChannelSender[] = []) {
    const map = new Map<DeliveryChannel, ChannelSender>();
    for (const sender of senders) {
      if (map.has(sender.channel)) {
        throw new Error(`Channel publisher registry already contains sender "${sender.channel}"`);
      }
      map.set(sender.channel, sender);
    }
    this.senders = map;
  }

  /** Return a new registry with `sender` added. Never mutates `this`. */
  register(sender: ChannelSender): ChannelPublisherRegistry {
    if (this.senders.has(sender.channel)) {
      throw new Error(`Channel publisher registry already contains sender "${sender.channel}"`);
    }
    return new ChannelPublisherRegistry([...this.senders.values(), sender]);
  }

  /** Return a new registry without the sender for `channel` (no-op when absent). */
  unregister(channel: DeliveryChannel): ChannelPublisherRegistry {
    if (!this.senders.has(channel)) return this;
    return new ChannelPublisherRegistry(
      [...this.senders.values()].filter((sender) => sender.channel !== channel),
    );
  }

  /** The sender for `channel`, or `undefined`. */
  get(channel: DeliveryChannel): ChannelSender | undefined {
    return this.senders.get(channel);
  }

  /** Whether a sender for `channel` is registered. */
  has(channel: DeliveryChannel): boolean {
    return this.senders.has(channel);
  }

  /** Snapshot of the registered senders in registration order. */
  list(): readonly ChannelSender[] {
    return [...this.senders.values()];
  }
}

/** Options accepted by the {@link ChannelPublisher} constructor. */
export interface ChannelPublisherOptions {
  /** Retry budget per recipient; defaults to 0 (no retries unless configured). */
  readonly maxRetries?: number;
  /** Delay between retries; defaults to 0. */
  readonly retryDelayMs?: number;
  /** Retry-delay sleeper; defaults to a `setTimeout`-based wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Maps digest recipients to channel recipients (none by default). */
  readonly resolveRecipients?: DigestRecipientResolver;
}

/** The default retry-delay sleeper (real time — overridable in tests). */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Outcome of delivering to one recipient. */
export interface ChannelDeliveryOutcome {
  readonly recipient: ChannelRecipient;
  /** Sends attempted (initial + retries). */
  readonly attemptsMade: number;
  readonly ok: boolean;
  /** Provider message on success. */
  readonly message?: string;
  /** Structured failure detail when not ok. */
  readonly error?: { readonly code: string; readonly message: string };
}

/** Aggregated outcome of a channel delivery pass. */
export interface ChannelPublishSummary {
  readonly outcomes: readonly ChannelDeliveryOutcome[];
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
}

/** Build a summary from per-recipient outcomes. */
function summarize(outcomes: readonly ChannelDeliveryOutcome[]): ChannelPublishSummary {
  return {
    outcomes,
    total: outcomes.length,
    ok: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
  };
}

/**
 * A `DigestPublisher` that dispatches formatted digest content per recipient
 * through the registered channel senders.
 */
export class ChannelPublisher implements DigestPublisher {
  private readonly registry: ChannelPublisherRegistry;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolveRecipients: DigestRecipientResolver;

  constructor(registry: ChannelPublisherRegistry, options: ChannelPublisherOptions = {}) {
    this.registry = registry;
    this.maxRetries = Math.max(0, options.maxRetries ?? 0);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
    this.sleep = options.sleep ?? defaultSleep;
    this.resolveRecipients = options.resolveRecipients ?? noChannelResolver;
  }

  /** The current registry (readonly view). */
  get channelRegistry(): ChannelPublisherRegistry {
    return this.registry;
  }

  /**
   * Deliver formatted content to every channel recipient.
   *
   * Per recipient: resolve the channel sender; when absent, record a
   * `channel_sender_missing` failure. Otherwise attempt `send` up to
   * `maxRetries + 1` times (retries only when configured), isolating every
   * failure. Never throws — returns a structured summary.
   */
  async deliver(
    recipients: readonly ChannelRecipient[],
    content: string | Digest,
  ): Promise<ChannelPublishSummary> {
    const text =
      typeof content === "string" ? content : formatDigestAsPlain(content);
    const outcomes: ChannelDeliveryOutcome[] = [];

    for (const recipient of recipients) {
      const outcome = await this.deliverTo(recipient, text);
      outcomes.push(outcome);
    }
    return summarize(outcomes);
  }

  /**
   * The `DigestPublisher` contract: resolve the digest's recipients to
   * channel recipients (injected resolver) and deliver. Never throws —
   * failures are visible through {@link deliver} with the resolver in play.
   */
  async publish(delivery: DigestDelivery, content: string | Digest): Promise<void> {
    const recipients = delivery.recipients.flatMap((recipient) =>
      this.resolveRecipients(recipient),
    );
    await this.deliver(recipients, content);
  }

  /** Deliver to a single recipient with the configured retry policy. */
  private async deliverTo(
    recipient: ChannelRecipient,
    content: string,
  ): Promise<ChannelDeliveryOutcome> {
    const sender = this.registry.get(recipient.channel);
    if (sender === undefined) {
      return {
        recipient,
        attemptsMade: 0,
        ok: false,
        error: {
          code: CHANNEL_SENDER_MISSING,
          message: `No sender registered for channel "${recipient.channel}"`,
        },
      };
    }

    let attemptsMade = 0;
    let last: ChannelSendOutput = { ok: false, error: { code: "unknown", message: "Send failed" } };
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      attemptsMade = attempt + 1;
      try {
        last = await sender.send({
          recipient,
          content,
          ...(recipient.label !== undefined ? { subject: recipient.label } : {}),
        });
      } catch (err) {
        last = {
          ok: false,
          error: {
            code: "send_threw",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
      if (last.ok) break;
      if (attempt < this.maxRetries && this.retryDelayMs > 0) {
        await this.sleep(this.retryDelayMs);
      }
    }

    return {
      recipient,
      attemptsMade,
      ok: last.ok,
      ...(last.message !== undefined ? { message: last.message } : {}),
      ...(last.error !== undefined ? { error: last.error } : {}),
    };
  }
}

// Re-exported for convenience.
export type { DigestDelivery, Digest };
