/**
 * Daily AI Digest — delivery layer.
 *
 * Formats digests into JSON, Markdown, plain text, or a structured object,
 * and dispatches them through an injected `DigestPublisher` abstraction.
 *
 * There is intentionally **no** real sending here: no Gmail, no Discord, no
 * Slack, no notifications — only formatting and a delivery abstraction the
 * application implements when it wants to actually send. Delivery is recorded
 * on the digest through the immutable `DigestManager` (successor pattern).
 */

import { DigestManager } from "./manager";
import {
  cloneDigest,
  createDigestDelivery,
  estimateDigestTokens,
  type Digest,
  type DigestDelivery,
  type DigestFormat,
  type DigestRecipient,
} from "./types";

/** Default format used by {@link DigestDeliveryEngine.deliver}. */
export const DEFAULT_DELIVERY_FORMAT: DigestFormat = "markdown";

/**
 * Format a digest as JSON (pretty-printed, deterministic).
 */
export function formatDigestAsJson(digest: Digest): string {
  return JSON.stringify(digest, null, 2);
}

/**
 * Format a digest as Markdown: a level-1 heading per digest, then a level-2
 * heading and a bullet list per section.
 */
export function formatDigestAsMarkdown(digest: Digest): string {
  const lines: string[] = [`# ${digest.metadata.title ?? digest.metadata.kind} Digest`];
  for (const section of digest.sections) {
    lines.push("", `## ${section.title}`, "");
    if (section.items.length === 0) {
      lines.push("_No items._");
      continue;
    }
    for (const item of section.items) {
      const importance = item.importance === "normal" ? "" : ` (${item.importance})`;
      const title = item.title.replace(/\n/g, " ");
      const content = item.content.replace(/\n/g, " ");
      lines.push(`- **${title}**${importance}${content.length > 0 ? ` — ${content}` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * Format a digest as plain text: a title line, then a label and indented
 * bullets per section.
 */
export function formatDigestAsPlain(digest: Digest): string {
  const lines: string[] = [
    (digest.metadata.title ?? digest.metadata.kind).toUpperCase(),
    "=".repeat(24),
  ];
  for (const section of digest.sections) {
    lines.push("", section.title.toUpperCase(), "-".repeat(section.title.length));
    if (section.items.length === 0) {
      lines.push("  (no items)");
      continue;
    }
    for (const item of section.items) {
      const title = item.title.replace(/\n/g, " ");
      const content = item.content.replace(/\n/g, " ");
      lines.push(`  • ${title}${content.length > 0 ? ` — ${content}` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * Format a digest as a structured object: a detached clone of the digest.
 */
export function formatDigestAsObject(digest: Digest): Digest {
  return cloneDigest(digest);
}

/**
 * Format a digest in the given format. `"object"` returns a detached clone;
 * every other format returns a string.
 */
export function formatDigest(digest: Digest, format: DigestFormat): string | Digest {
  switch (format) {
    case "json":
      return formatDigestAsJson(digest);
    case "markdown":
      return formatDigestAsMarkdown(digest);
    case "plain":
      return formatDigestAsPlain(digest);
    case "object":
      return formatDigestAsObject(digest);
  }
}

/**
 * Pure digest formatter — the formatting surface of the delivery layer.
 */
export class DigestFormatter {
  /** Format a digest; see {@link formatDigest}. */
  format(digest: Digest, format: DigestFormat): string | Digest {
    return formatDigest(digest, format);
  }

  /** Format a digest as JSON. */
  asJson(digest: Digest): string {
    return formatDigestAsJson(digest);
  }

  /** Format a digest as Markdown. */
  asMarkdown(digest: Digest): string {
    return formatDigestAsMarkdown(digest);
  }

  /** Format a digest as plain text. */
  asPlain(digest: Digest): string {
    return formatDigestAsPlain(digest);
  }

  /** Format a digest as a detached structured object. */
  asObject(digest: Digest): Digest {
    return formatDigestAsObject(digest);
  }
}

/**
 * The delivery abstraction: a publisher receives the formatted content of a
 * delivered digest. Applications implement this to actually send (Gmail,
 * Discord, Slack, notifications) — this layer only calls it.
 */
export interface DigestPublisher {
  /** Deliver the formatted digest content to the delivery's recipients. */
  publish(delivery: DigestDelivery, content: string | Digest): Promise<void>;
}

/** A no-op publisher — the default when no channel is wired. */
export class NoopPublisher implements DigestPublisher {
  async publish(): Promise<void> {
    // Intentionally a no-op: the delivery abstraction without a channel.
  }
}

/** Options accepted by {@link DigestDeliveryEngine.deliver}. */
export interface DeliverOptions {
  /** Output format; defaults to `"markdown"`. */
  readonly format?: DigestFormat;
  /** Recipients of this delivery (copied onto the delivery record). */
  readonly recipients: readonly DigestRecipient[];
  /** Publisher override for this delivery (falls back to the engine's). */
  readonly publisher?: DigestPublisher;
  /** ISO-8601 UTC timestamp of the delivery; defaults to the engine clock. */
  readonly at?: string;
}

/** The structured outcome of a delivery. */
export interface DeliveryResult {
  readonly digestId: string;
  readonly format: DigestFormat;
  /** The formatted content (string, or a detached digest for `"object"`). */
  readonly content: string | Digest;
  readonly recipients: readonly DigestRecipient[];
  /** ISO-8601 UTC timestamp of the delivery. */
  readonly deliveredAt: string;
}

/** Options accepted by the {@link DigestDeliveryEngine} constructor. */
export interface DigestDeliveryEngineOptions {
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
  /** The publisher used when a delivery does not override it. */
  readonly publisher?: DigestPublisher;
}

/**
 * Composes formatting and dispatch: format → publish (through the injected
 * publisher) → record the delivery on the digest (via the successor
 * manager). Returns the successor manager plus the delivery result.
 */
export class DigestDeliveryEngine {
  private readonly manager: DigestManager;
  private readonly publisher: DigestPublisher;
  private readonly now: () => string;
  readonly formatter: DigestFormatter;

  constructor(
    manager: DigestManager,
    options: DigestDeliveryEngineOptions = {},
  ) {
    this.manager = manager;
    this.publisher = options.publisher ?? new NoopPublisher();
    this.now = options.now ?? (() => new Date().toISOString());
    this.formatter = new DigestFormatter();
  }

  /** Format a digest without delivering it. */
  format(digest: Digest, format: DigestFormat): string | Digest {
    return this.formatter.format(digest, format);
  }

  /**
   * Deliver `digest`: format it, publish the formatted content through the
   * (possibly overridden) publisher, and record the delivery on the digest
   * through the successor manager. Never mutates the receiver manager.
   */
  async deliver(
    digest: Digest,
    options: DeliverOptions,
  ): Promise<{ manager: DigestManager; result: DeliveryResult }> {
    const format = options.format ?? DEFAULT_DELIVERY_FORMAT;
    const content = this.format(digest, format);
    const deliveredAt = options.at ?? this.now();

    const delivery = createDigestDelivery({
      format,
      recipients: options.recipients,
      deliveredAt,
    });
    await (options.publisher ?? this.publisher).publish(delivery, content);

    const { manager } = this.manager.markDelivered(digest.id, delivery, deliveredAt);
    return {
      manager,
      result: {
        digestId: digest.id,
        format,
        content,
        recipients: [...options.recipients],
        deliveredAt,
      },
    };
  }
}

/** Estimate the token cost of a digest (re-exported convenience). */
export { estimateDigestTokens };
