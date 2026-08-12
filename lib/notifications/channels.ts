/**
 * Notification & Delivery System — delivery channels (Phase 6D STEP 5).
 *
 * The transport seam of the notification layer: a generic
 * `NotificationChannel` contract (types module) plus built-in channel
 * implementations for Email, Discord, Telegram, Webhook, Push, InApp and
 * Mock.
 *
 * Guarantees:
 * - **No SDK logic**: every channel is a pure structural adapter. Real
 *   provider work is dependency-injected through a `NotificationTransport`;
 *   the built-ins default to a deterministic `MockTransport` (documented
 *   stop condition — the application wires real providers through the
 *   factory).
 * - **Never throws**: `send`/`sendBatch`/`health` return structured outputs;
 *   failures are isolated per message.
 * - **Validation**: every channel validates recipients/content/attachments
 *   against its own rules before sending.
 * - **Rate limits & retry hints**: channels expose their `rateLimit` and
 *   decide retryability from a failed output (`retryHint`).
 * - **Immutable registry**: `NotificationChannelRegistry` is successor-based;
 *   `register`/`unregister` return new registries.
 *
 * All timestamps are caller-supplied; all ids are deterministic FNV-1a.
 */

import { hashString } from "@/lib/hash";
import type {
  NotificationAttachment,
  NotificationChannel,
  NotificationChannelSendInput,
  NotificationChannelSendOutput,
  NotificationChannelValidation,
  NotificationChannelType,
  NotificationError,
  NotificationFormat,
  NotificationHealth,
  NotificationProviderCapabilities,
  NotificationProviderResult,
  NotificationRateLimit,
} from "./types";
import {
  createNotificationProviderCapabilities,
  createNotificationHealth,
  createNotificationRateLimit,
} from "./types";

/** A transport: the injected seam between a channel and a real provider. */
export interface NotificationTransport {
  /** Send one message to a provider; never throws. */
  send(input: NotificationTransportInput): Promise<NotificationProviderResult>;
}

/** Input handed to a transport. */
export interface NotificationTransportInput {
  readonly channel: NotificationChannelType;
  readonly recipient: NotificationChannelSendInput["recipient"];
  readonly subject?: string;
  readonly content: string;
  readonly format?: NotificationFormat;
  readonly attachments?: readonly NotificationAttachment[];
  /** ISO-8601 UTC timestamp of the send (caller-supplied). */
  readonly at: string;
  /** Opaque provider extras. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Structured outcome of a channel send attempt. */
export interface ChannelSendAttempt {
  readonly ok: boolean;
  readonly message?: string;
  readonly error?: NotificationError;
  /** Wall-clock duration of the attempt in milliseconds. */
  readonly durationMs?: number;
}

/** Options accepted by channel factories. */
export interface NotificationChannelOptions {
  /** Injected transport; defaults to a deterministic mock transport. */
  readonly transport?: NotificationTransport;
  /** Informational rate limit; defaults to 60/60_000ms. */
  readonly rateLimit?: NotificationRateLimit;
  /** Provider capabilities; defaults per channel. */
  readonly capabilities?: Partial<NotificationProviderCapabilities>;
  /** Maximum attachment size in bytes (validated when provided). */
  readonly maxAttachmentSizeBytes?: number;
  /** Maximum body length in characters. */
  readonly maxBodyLength?: number;
}

/** A recorded mock send (for deterministic assertions). */
export interface MockSendRecord {
  readonly channel: NotificationChannelType;
  readonly address: string;
  readonly subject?: string;
  readonly content: string;
  readonly format: NotificationFormat;
  readonly attachments: readonly NotificationAttachment[];
  readonly at: string;
  readonly messageId: string;
}

/**
 * The deterministic mock transport. Every send succeeds with a message id
 * derived from the input (no randomness, no wall clock beyond the injected
 * `at`). Sends are recorded in an in-memory sink so tests and diagnostics
 * can assert exactly what was "sent".
 */
export class MockTransport {
  private _sends: MockSendRecord[] = [];

  /** Detached copies of every recorded send, oldest first. */
  sends(): MockSendRecord[] {
    return this._sends.map((record) => ({
      ...record,
      attachments: [...record.attachments],
    }));
  }

  /** Number of recorded sends. */
  count(): number {
    return this._sends.length;
  }

  /** Clear the sink (diagnostics only). */
  clear(): void {
    this._sends = [];
  }

  /** The transport handle to inject into channels. */
  get transport(): NotificationTransport {
    return {
      send: (input): Promise<NotificationProviderResult> => {
        const messageId = `mock-${hashString(
          `${input.channel}:${input.recipient.address}:${input.content}:${input.at}`,
        )}`;
        this._sends.push({
          channel: input.channel,
          address: input.recipient.address,
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          content: input.content,
          format: input.format ?? "plain",
          attachments: input.attachments !== undefined ? [...input.attachments] : [],
          at: input.at,
          messageId,
        });
        return Promise.resolve({ ok: true, message: messageId });
      },
    };
  }
}

/** Build a fresh mock transport (single construction path). */
export function createMockTransport(): MockTransport {
  return new MockTransport();
}

/** The default transport: a fresh shared mock (per-channel instance). */
function defaultTransport(): NotificationTransport {
  return new MockTransport().transport;
}

// ─────────────────────────────────────────────────────────────
// Per-channel validation rules.
// ─────────────────────────────────────────────────────────────

/** Validation rules a channel type applies to its inputs. */
interface ChannelRules {
  readonly channel: NotificationChannelType;
  /** Validate a destination address for this channel. */
  readonly isValidAddress: (address: string) => boolean;
  /** When true, a subject is required. */
  readonly subjectRequired?: boolean;
  /** When true, attachments are supported. */
  readonly supportsAttachments?: boolean;
  /** When true, HTML content is supported. */
  readonly supportsHtml?: boolean;
  /** When true, markdown content is supported. */
  readonly supportsMarkdown?: boolean;
  /** When true, batch sends are supported. */
  readonly supportsBatch?: boolean;
}

/** Email address regex (pragmatic, deterministic). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** HTTP(S) URL regex. */
const URL_PATTERN = /^https?:\/\/[^\s]+$/i;

/** Telegram chat id: digits, possibly negative. */
const TELEGRAM_PATTERN = /^-?[0-9]+$/;

/** The per-channel validation rules (deterministic). */
const CHANNEL_RULES: Readonly<Record<NotificationChannelType, ChannelRules>> = Object.freeze({
  email: {
    channel: "email",
    isValidAddress: (address) => EMAIL_PATTERN.test(address),
    subjectRequired: true,
    supportsAttachments: true,
    supportsHtml: true,
    supportsMarkdown: false,
    supportsBatch: true,
  },
  discord: {
    channel: "discord",
    isValidAddress: (address) => address.length > 0 && (URL_PATTERN.test(address) || address.length > 0),
    supportsAttachments: true,
    supportsMarkdown: true,
    supportsBatch: true,
  },
  telegram: {
    channel: "telegram",
    isValidAddress: (address) => TELEGRAM_PATTERN.test(address),
    supportsAttachments: true,
    supportsMarkdown: true,
    supportsBatch: false,
  },
  webhook: {
    channel: "webhook",
    isValidAddress: (address) => URL_PATTERN.test(address),
    supportsAttachments: false,
    supportsHtml: true,
    supportsMarkdown: true,
    supportsBatch: true,
  },
  push: {
    channel: "push",
    isValidAddress: (address) => address.length > 0,
    supportsAttachments: false,
    supportsHtml: false,
    supportsMarkdown: false,
    supportsBatch: true,
  },
  inapp: {
    channel: "inapp",
    isValidAddress: (address) => address.length > 0,
    supportsAttachments: false,
    supportsHtml: true,
    supportsMarkdown: true,
    supportsBatch: true,
  },
  mock: {
    channel: "mock",
    isValidAddress: () => true,
    supportsAttachments: true,
    supportsHtml: true,
    supportsMarkdown: true,
    supportsBatch: true,
  },
});

// ─────────────────────────────────────────────────────────────
// The generic channel implementation.
// ─────────────────────────────────────────────────────────────

/** Default maximum attachment size (10 MB). */
export const DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

/** Default maximum body length (see notification limits). */
export const DEFAULT_MAX_BODY_LENGTH = 10_000;

/**
 * Build a channel for `type` over the shared implementation. Every built-in
 * channel is this one function with per-type rules — no duplicated send /
 * validate / health logic across the eight channels.
 */
export function createNotificationChannel(
  type: NotificationChannelType,
  options: NotificationChannelOptions = {},
): NotificationChannel {
  const rules = CHANNEL_RULES[type];
  const transport = options.transport ?? defaultTransport();
  const capabilities = createNotificationProviderCapabilities({
    supportsAttachments: options.capabilities?.supportsAttachments ?? (rules.supportsAttachments ?? false),
    supportsBatch: options.capabilities?.supportsBatch ?? (rules.supportsBatch ?? false),
    supportsHtml: options.capabilities?.supportsHtml ?? (rules.supportsHtml ?? false),
    supportsMarkdown: options.capabilities?.supportsMarkdown ?? (rules.supportsMarkdown ?? false),
    ...(options.capabilities?.maxBatchSize !== undefined
      ? { maxBatchSize: options.capabilities.maxBatchSize }
      : {}),
  });
  const rateLimit = createNotificationRateLimit(options.rateLimit);
  const maxAttachmentSizeBytes = options.maxAttachmentSizeBytes ?? DEFAULT_MAX_ATTACHMENT_SIZE_BYTES;
  const maxBodyLength = options.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH;

  const validate = (input: NotificationChannelSendInput): NotificationChannelValidation => {
    const errors: string[] = [];
    if (!rules.isValidAddress(input.recipient.address)) {
      errors.push(`Invalid ${type} address "${input.recipient.address}"`);
    }
    if (rules.subjectRequired && input.subject === undefined) {
      errors.push(`Channel "${type}" requires a subject`);
    }
    if (input.content.length > maxBodyLength) {
      errors.push(`Content exceeds the maximum length of ${maxBodyLength} characters`);
    }
    const attachments = input.attachments ?? [];
    for (const attachment of attachments) {
      if (attachment.sizeBytes !== undefined && attachment.sizeBytes > maxAttachmentSizeBytes) {
        errors.push(
          `Attachment "${attachment.name}" exceeds the maximum size of ${maxAttachmentSizeBytes} bytes`,
        );
      }
      if (attachment.name.length === 0) {
        errors.push("Attachment name must not be empty");
      }
    }
    if (attachments.length > 0 && !(rules.supportsAttachments ?? false)) {
      errors.push(`Channel "${type}" does not support attachments`);
    }
    if (input.format === "html" && !(rules.supportsHtml ?? false)) {
      errors.push(`Channel "${type}" does not support HTML content`);
    }
    if (input.format === "markdown" && !(rules.supportsMarkdown ?? false)) {
      errors.push(`Channel "${type}" does not support markdown content`);
    }
    return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
  };

  const dispatch = async (
    input: NotificationChannelSendInput,
    at: string,
  ): Promise<NotificationChannelSendOutput> => {
    const validation = validate(input);
    if (!validation.ok) {
      return {
        ok: false,
        error: { code: "validation_failed", message: validation.errors.join("; ") },
      };
    }
    const result = await transport.send({
      channel: type,
      recipient: input.recipient,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      content: input.content,
      format: input.format,
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      at,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    return {
      ok: result.ok,
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  };

  return {
    channel: type,
    capabilities,
    rateLimit,
    validate,
    send: (input, now) => dispatch(input, now),
    sendBatch: (inputs, now) => Promise.all(inputs.map((input) => dispatch(input, now))),
    health: (now: string): NotificationHealth =>
      createNotificationHealth({ status: "healthy", score: 1, lastCheckedAt: now }),
    retryHint: (result: NotificationChannelSendOutput): boolean => {
      if (result.ok) return false;
      const code = result.error?.code ?? "";
      // Permanent rejections (e.g. a malformed message) are not retryable;
      // transient provider failures are. Deterministic code classification.
      return (
        result.error?.retryable === true ||
        code === "provider_error" ||
        code === "timeout" ||
        code === "rate_limited" ||
        code === "temporary_failure"
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Per-channel convenience factories (single shared implementation).
// ─────────────────────────────────────────────────────────────

/** Build an Email channel (address must be a valid email; subject required). */
export function createEmailChannel(options: NotificationChannelOptions = {}): NotificationChannel {
  return createNotificationChannel("email", options);
}

/** Build a Discord channel (webhook url or channel id). */
export function createDiscordChannel(options: NotificationChannelOptions = {}): NotificationChannel {
  return createNotificationChannel("discord", options);
}

/** Build a Telegram channel (numeric chat id). */
export function createTelegramChannel(options: NotificationChannelOptions = {}): NotificationChannel {
  return createNotificationChannel("telegram", options);
}

/** Build a Webhook channel (http(s) url). */
export function createWebhookChannel(options: NotificationChannelOptions = {}): NotificationChannel {
  return createNotificationChannel("webhook", options);
}

/** Build a Push channel (device token address). */
export function createPushChannel(options: NotificationChannelOptions = {}): NotificationChannel {
  return createNotificationChannel("push", options);
}

/** Build an InApp channel (user/address handle). */
export function createInAppChannel(options: NotificationChannelOptions = {}): NotificationChannel {
  return createNotificationChannel("inapp", options);
}

/** Build a Mock channel (any address; echoes deterministic success). */
export function createMockChannel(options: NotificationChannelOptions = {}): NotificationChannel {
  return createNotificationChannel("mock", options);
}

// ─────────────────────────────────────────────────────────────
// Registry.
// ─────────────────────────────────────────────────────────────

/** Options accepted by the {@link NotificationChannelRegistry} constructor. */
export interface NotificationChannelRegistryOptions {
  readonly channels?: readonly NotificationChannel[];
}

/** Deterministic registry hash over the registered channels. */
export function channelRegistryHash(channels: readonly NotificationChannel[]): string {
  return hashString(channels.map((channel) => channel.channel).join(":"));
}

/**
 * An immutable registry of channels. `register` returns a successor
 * registry; duplicate channel types throw.
 */
export class NotificationChannelRegistry {
  private readonly byType: ReadonlyMap<NotificationChannelType, NotificationChannel>;

  constructor(options: NotificationChannelRegistryOptions = {}) {
    const map = new Map<NotificationChannelType, NotificationChannel>();
    for (const channel of options.channels ?? []) {
      if (map.has(channel.channel)) {
        throw new Error(`Notification channel registry already contains "${channel.channel}"`);
      }
      map.set(channel.channel, channel);
    }
    this.byType = map;
  }

  /** Return a successor registry with `channel` added. */
  register(channel: NotificationChannel): NotificationChannelRegistry {
    if (this.byType.has(channel.channel)) {
      throw new Error(`Notification channel registry already contains "${channel.channel}"`);
    }
    return new NotificationChannelRegistry({ channels: [...this.byType.values(), channel] });
  }

  /** Return a successor registry without the channel `type` (no-op when absent). */
  unregister(type: NotificationChannelType): NotificationChannelRegistry {
    if (!this.byType.has(type)) return this;
    return new NotificationChannelRegistry({
      channels: [...this.byType.values()].filter((channel) => channel.channel !== type),
    });
  }

  /** The channel for `type`, or `undefined`. */
  get(type: NotificationChannelType): NotificationChannel | undefined {
    return this.byType.get(type);
  }

  /** Whether a channel for `type` is registered. */
  has(type: NotificationChannelType): boolean {
    return this.byType.has(type);
  }

  /** Snapshot of the registered channels in registration order. */
  list(): readonly NotificationChannel[] {
    return [...this.byType.values()];
  }

  /** Number of registered channels. */
  count(): number {
    return this.byType.size;
  }

  /** Deterministic content hash of the registry. */
  hash(): string {
    return channelRegistryHash([...this.byType.values()]);
  }
}

/** Build a fresh channel registry. */
export function createNotificationChannelRegistry(
  options: NotificationChannelRegistryOptions = {},
): NotificationChannelRegistry {
  return new NotificationChannelRegistry(options);
}

/** The default production channels: all built-ins. */
export function createDefaultNotificationChannels(): readonly NotificationChannel[] {
  return Object.freeze([
    createEmailChannel(),
    createDiscordChannel(),
    createTelegramChannel(),
    createWebhookChannel(),
    createPushChannel(),
    createInAppChannel(),
    createMockChannel(),
  ]);
}
