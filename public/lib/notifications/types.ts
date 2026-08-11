/**
 * Notification & Delivery System — immutable domain models (Phase 6D STEP 2).
 *
 * The pure, readonly vocabulary of the notification layer: notifications,
 * recipients, templates, deliveries, attempts, retry/dead-letter records,
 * preferences, subscriptions, queues, batches, schedules, rules, statistics,
 * snapshots, metrics, providers and configuration.
 *
 * Every model is deep-frozen, every id is deterministic (derived via the
 * shared FNV-1a `hashString` from `@/lib/hash` — never duplicated), every
 * timestamp is caller-supplied (no `Date.now()`, no `Math.random()`), and
 * every helper is a pure function: constructors, deep clone, deep freeze,
 * deterministic ids, hashes, summaries, statistics and snapshots. No
 * services, no timers, no side effects live here — only data and pure
 * functions.
 */

import { hashString } from "@/lib/hash";

// ─────────────────────────────────────────────────────────────
// Core value types.
// ─────────────────────────────────────────────────────────────

/** The transport channels a notification can be delivered through. */
export type NotificationChannelType =
  | "email"
  | "discord"
  | "telegram"
  | "whatsapp"
  | "webhook"
  | "push"
  | "inapp"
  | "mock";

/** Every channel type, in a stable canonical order. */
export const NOTIFICATION_CHANNEL_TYPES: readonly NotificationChannelType[] = Object.freeze([
  "email",
  "discord",
  "telegram",
  "whatsapp",
  "webhook",
  "push",
  "inapp",
  "mock",
]);

/** Execution priority of a notification — drives queue ordering. */
export type NotificationPriority = "low" | "normal" | "high" | "critical";

/** Deterministic ordering rank of each priority (higher runs first). */
export const NOTIFICATION_PRIORITY_RANK: Readonly<Record<NotificationPriority, number>> =
  Object.freeze({
    low: 0,
    normal: 1,
    high: 2,
    critical: 3,
  });

/** Default priority assigned by `createNotification`. */
export const DEFAULT_NOTIFICATION_PRIORITY: NotificationPriority = "normal";

/** Lifecycle status of a notification. */
export type NotificationStatus =
  | "pending"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "cancelled"
  | "dead";

/** Every notification status, in a stable canonical order. */
export const NOTIFICATION_STATUSES: readonly NotificationStatus[] = Object.freeze([
  "pending",
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "cancelled",
  "dead",
]);

/** The category a notification belongs to (drives preferences/audit). */
export type NotificationCategory =
  | "digest"
  | "memory"
  | "conversation"
  | "workflow"
  | "action"
  | "job"
  | "system"
  | "marketing";

/** Every notification category, in a stable canonical order. */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = Object.freeze([
  "digest",
  "memory",
  "conversation",
  "workflow",
  "action",
  "job",
  "system",
  "marketing",
]);

/** Default category assigned by `createNotification`. */
export const DEFAULT_NOTIFICATION_CATEGORY: NotificationCategory = "system";

/** The content formats the template engine can render. */
export type NotificationFormat = "plain" | "markdown" | "html";

/** Every content format, in a stable canonical order. */
export const NOTIFICATION_FORMATS: readonly NotificationFormat[] = Object.freeze([
  "plain",
  "markdown",
  "html",
]);

/** A stable notification id (opaque string). */
export type NotificationId = string;

/** A structured failure/error detail. */
export interface NotificationError {
  /** Stable machine-readable code, e.g. "provider_rejected", "timeout". */
  readonly code: string;
  /** Human-readable detail. */
  readonly message: string;
  /** When true, a retry is likely to succeed (drives the retry policy). */
  readonly retryable?: boolean;
}

/** A one-time or recurring delivery schedule (pure data — no cron engine). */
export interface NotificationSchedule {
  /** ISO-8601 UTC timestamp of the single occurrence (one-time schedules). */
  readonly at?: string;
  /** Interval between occurrences in milliseconds (recurring schedules). */
  readonly everyMs?: number;
  /** ISO-8601 UTC timestamp of the first recurring occurrence. */
  readonly startsAt?: string;
}

// ─────────────────────────────────────────────────────────────
// Recipients, attachments, payload, metadata.
// ─────────────────────────────────────────────────────────────

/** A single delivery destination for a notification. */
export interface NotificationRecipient {
  /** Stable recipient id derived from channel + address. */
  readonly id: string;
  readonly channel: NotificationChannelType;
  /** The destination address (email, chat id, webhook url, phone…). */
  readonly address: string;
  /** Optional human-readable label (also used as the email subject). */
  readonly label?: string;
  /** Channels tried in order when the primary channel fails. */
  readonly fallbackChannels?: readonly NotificationChannelType[];
  /** Opaque per-recipient transport configuration. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Input accepted by {@link createNotificationRecipient}. */
export interface CreateNotificationRecipientInput {
  readonly channel: NotificationChannelType;
  readonly address: string;
  readonly label?: string;
  readonly fallbackChannels?: readonly NotificationChannelType[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Deterministic recipient id. */
export function recipientIdFor(channel: NotificationChannelType, address: string): string {
  return `recipient-${hashString(`${channel}:${address}`)}`;
}

/** Build an immutable notification recipient (deep-frozen). */
export function createNotificationRecipient(input: CreateNotificationRecipientInput): NotificationRecipient {
  return deepFreeze({
    id: recipientIdFor(input.channel, input.address),
    channel: input.channel,
    address: input.address,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.fallbackChannels !== undefined
      ? { fallbackChannels: [...input.fallbackChannels] }
      : {}),
    ...(input.metadata !== undefined ? { metadata: { ...input.metadata } } : {}),
  });
}

/** Return a deep, detached copy of a recipient (never frozen). */
export function cloneNotificationRecipient(recipient: NotificationRecipient): NotificationRecipient {
  return {
    id: recipient.id,
    channel: recipient.channel,
    address: recipient.address,
    ...(recipient.label !== undefined ? { label: recipient.label } : {}),
    ...(recipient.fallbackChannels !== undefined
      ? { fallbackChannels: [...recipient.fallbackChannels] }
      : {}),
    ...(recipient.metadata !== undefined ? { metadata: { ...recipient.metadata } } : {}),
  };
}

/** Stable hash of a recipient's identity (channel + address). */
export function hashNotificationRecipient(recipient: NotificationRecipient): string {
  return hashString(`${recipient.channel}:${recipient.address}`);
}

/** An attachment carried by a notification message. */
export interface NotificationAttachment {
  /** Stable attachment id derived from name + mimeType. */
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  /** Estimated size in bytes (deterministic validation input). */
  readonly sizeBytes?: number;
  /** Public URL (when the payload is referenced rather than embedded). */
  readonly url?: string;
  /** Opaque content reference (base64/url — transport decides). */
  readonly content?: string;
}

/** Input accepted by {@link createNotificationAttachment}. */
export interface CreateNotificationAttachmentInput {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly url?: string;
  readonly content?: string;
}

/** Deterministic attachment id. */
export function attachmentIdFor(name: string, mimeType: string): string {
  return `attachment-${hashString(`${name}:${mimeType}`)}`;
}

/** Build an immutable attachment (deep-frozen). */
export function createNotificationAttachment(input: CreateNotificationAttachmentInput): NotificationAttachment {
  return deepFreeze({
    id: attachmentIdFor(input.name, input.mimeType),
    name: input.name,
    mimeType: input.mimeType,
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
  });
}

/** Structured payload of a notification (rendered data + opaque context). */
export interface NotificationPayload {
  readonly title?: string;
  readonly body: string;
  /** Opaque structured data forwarded to transports/audit. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Input accepted by {@link createNotificationPayload}. */
export interface CreateNotificationPayloadInput {
  readonly title?: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Build an immutable payload (deep-frozen). */
export function createNotificationPayload(input: CreateNotificationPayloadInput): NotificationPayload {
  return deepFreeze({
    ...(input.title !== undefined ? { title: input.title } : {}),
    body: input.body,
    ...(input.data !== undefined ? { data: { ...input.data } } : {}),
  });
}

/** Immutable metadata attached to a notification. */
export interface NotificationMetadata {
  readonly tags: readonly string[];
  /** Opaque origin label, e.g. "digest", "worker", "api". */
  readonly source?: string;
  /** ISO-8601 UTC expiry timestamp (expired notifications are never sent). */
  readonly expiresAt?: string;
  /** Deduplication key (identical keys within a window merge). */
  readonly dedupeKey?: string;
  /** Optional user-supplied correlation id. */
  readonly correlationId?: string;
}

/** Input accepted by {@link createNotificationMetadata}. */
export interface CreateNotificationMetadataInput {
  readonly tags?: readonly string[];
  readonly source?: string;
  readonly expiresAt?: string;
  readonly dedupeKey?: string;
  readonly correlationId?: string;
}

/** Build immutable notification metadata (deep-frozen). */
export function createNotificationMetadata(input: CreateNotificationMetadataInput = {}): NotificationMetadata {
  return deepFreeze({
    tags: input.tags !== undefined ? [...input.tags] : [],
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });
}

// ─────────────────────────────────────────────────────────────
// The Notification entity.
// ─────────────────────────────────────────────────────────────

/** An immutable notification. */
export interface Notification {
  /** Stable id; deterministic when derived by {@link notificationIdFor}. */
  readonly id: NotificationId;
  /** Owner user id, when user-scoped. */
  readonly userId?: string;
  readonly title: string;
  readonly body: string;
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  /** Every destination, each with its own channel + fallbacks. */
  readonly recipients: readonly NotificationRecipient[];
  /** Lifecycle status. */
  readonly status: NotificationStatus;
  /** Delivery schedule (one-time `at` / recurring `everyMs`). */
  readonly schedule?: NotificationSchedule;
  /** ISO-8601 UTC timestamp of the next/only scheduled run. */
  readonly scheduledAt?: string;
  /** ISO-8601 UTC timestamp of creation (caller-supplied). */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the first dispatch. */
  readonly sentAt?: string;
  /** ISO-8601 UTC timestamp of the last (successful) delivery. */
  readonly deliveredAt?: string;
  /** Number of dispatch attempts made. */
  readonly attempts: number;
  /** Referenced template id, when rendered from one. */
  readonly templateId?: string;
  /** Structured failure detail of the most recent run. */
  readonly error?: NotificationError;
  readonly payload?: NotificationPayload;
  readonly attachments: readonly NotificationAttachment[];
  readonly metadata: NotificationMetadata;
}

/** Options accepted by {@link createNotification}. */
export interface CreateNotificationInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: NotificationId;
  readonly userId?: string;
  readonly title: string;
  readonly body: string;
  readonly category?: NotificationCategory;
  readonly priority?: NotificationPriority;
  readonly recipients: readonly NotificationRecipient[];
  readonly status?: NotificationStatus;
  readonly schedule?: NotificationSchedule;
  readonly scheduledAt?: string;
  /** ISO-8601 UTC timestamp of creation (required — caller-supplied). */
  readonly createdAt: string;
  readonly sentAt?: string;
  readonly deliveredAt?: string;
  readonly attempts?: number;
  readonly templateId?: string;
  readonly error?: NotificationError;
  readonly payload?: CreateNotificationPayloadInput;
  readonly attachments?: readonly NotificationAttachment[];
  readonly metadata?: CreateNotificationMetadataInput;
}

/** Deterministic notification id. */
export function notificationIdFor(
  userId: string | undefined,
  title: string,
  category: NotificationCategory,
  priority: NotificationPriority,
  createdAt: string,
): NotificationId {
  return `notification-${hashString(
    `${userId ?? ""}:${title}:${category}:${priority}:${createdAt}`,
  )}`;
}

/**
 * Build a new immutable notification.
 *
 * `id` defaults to a deterministic hash of userId + title + category +
 * priority + createdAt; derived ids are stable but not guaranteed unique
 * across identical inputs — pass an explicit `id` when uniqueness matters.
 * `recipients`, `attachments`, and `metadata.tags` are copied as new arrays;
 * the returned object is deep-frozen and detached from all inputs.
 */
export function createNotification(input: CreateNotificationInput): Notification {
  return deepFreeze({
    id:
      input.id ??
      notificationIdFor(
        input.userId,
        input.title,
        input.category ?? DEFAULT_NOTIFICATION_CATEGORY,
        input.priority ?? DEFAULT_NOTIFICATION_PRIORITY,
        input.createdAt,
      ),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    title: input.title,
    body: input.body,
    category: input.category ?? DEFAULT_NOTIFICATION_CATEGORY,
    priority: input.priority ?? DEFAULT_NOTIFICATION_PRIORITY,
    recipients: input.recipients.map(cloneNotificationRecipient),
    status: input.status ?? "pending",
    ...(input.schedule !== undefined ? { schedule: cloneSchedule(input.schedule) } : {}),
    ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
    createdAt: input.createdAt,
    ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
    ...(input.deliveredAt !== undefined ? { deliveredAt: input.deliveredAt } : {}),
    attempts: input.attempts ?? 0,
    ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
    ...(input.error !== undefined ? { error: { ...input.error } } : {}),
    ...(input.payload !== undefined ? { payload: createNotificationPayload(input.payload) } : {}),
    attachments:
      input.attachments !== undefined ? input.attachments.map(cloneAttachment) : [],
    metadata: createNotificationMetadata(input.metadata),
  });
}

/** A partial patch applied by {@link touchNotification}. */
export interface NotificationPatch {
  readonly userId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly category?: NotificationCategory;
  readonly priority?: NotificationPriority;
  readonly recipients?: readonly NotificationRecipient[];
  readonly status?: NotificationStatus;
  readonly schedule?: NotificationSchedule | null;
  readonly scheduledAt?: string | null;
  readonly sentAt?: string | null;
  readonly deliveredAt?: string | null;
  readonly createdAt?: string;
  readonly attempts?: number;
  readonly templateId?: string | null;
  readonly error?: NotificationError | null;
  readonly payload?: NotificationPayload | null;
  readonly attachments?: readonly NotificationAttachment[];
  readonly metadata?: NotificationMetadata;
}

/**
 * Return the successor notification with the patch applied.
 * Missing patch keys are preserved; arrays are copied; a `null` value
 * clears an optional field. Deterministic — the input is never mutated.
 */
export function touchNotification(notification: Notification, patch: NotificationPatch): Notification {
  return {
    id: notification.id,
    ...(patch.userId !== undefined
      ? { userId: patch.userId }
      : notification.userId !== undefined
        ? { userId: notification.userId }
        : {}),
    title: patch.title ?? notification.title,
    body: patch.body ?? notification.body,
    category: patch.category ?? notification.category,
    priority: patch.priority ?? notification.priority,
    recipients:
      patch.recipients !== undefined
        ? patch.recipients.map(cloneNotificationRecipient)
        : notification.recipients.map(cloneNotificationRecipient),
    status: patch.status ?? notification.status,
    ...(patch.schedule !== undefined
      ? patch.schedule !== null
        ? { schedule: cloneSchedule(patch.schedule) }
        : {}
      : notification.schedule !== undefined
        ? { schedule: cloneSchedule(notification.schedule) }
        : {}),
    ...(patch.scheduledAt !== undefined
      ? patch.scheduledAt !== null
        ? { scheduledAt: patch.scheduledAt }
        : {}
      : notification.scheduledAt !== undefined
        ? { scheduledAt: notification.scheduledAt }
        : {}),
    createdAt: patch.createdAt ?? notification.createdAt,
    ...(patch.sentAt !== undefined
      ? patch.sentAt !== null
        ? { sentAt: patch.sentAt }
        : {}
      : notification.sentAt !== undefined
        ? { sentAt: notification.sentAt }
        : {}),
    ...(patch.deliveredAt !== undefined
      ? patch.deliveredAt !== null
        ? { deliveredAt: patch.deliveredAt }
        : {}
      : notification.deliveredAt !== undefined
        ? { deliveredAt: notification.deliveredAt }
        : {}),
    attempts: patch.attempts ?? notification.attempts,
    ...(patch.templateId !== undefined
      ? patch.templateId !== null
        ? { templateId: patch.templateId }
        : {}
      : notification.templateId !== undefined
        ? { templateId: notification.templateId }
        : {}),
    ...(patch.error !== undefined
      ? patch.error !== null
        ? { error: { ...patch.error } }
        : {}
      : notification.error !== undefined
        ? { error: { ...notification.error } }
        : {}),
    ...(patch.payload !== undefined
      ? patch.payload !== null
        ? { payload: clonePayload(patch.payload) }
        : {}
      : notification.payload !== undefined
        ? { payload: clonePayload(notification.payload) }
        : {}),
    attachments:
      patch.attachments !== undefined
        ? patch.attachments.map(cloneAttachment)
        : notification.attachments.map(cloneAttachment),
    metadata: patch.metadata !== undefined ? cloneMetadata(patch.metadata) : cloneMetadata(notification.metadata),
  };
}

/** Return a deep, detached copy of a notification (never frozen). */
export function cloneNotification(notification: Notification): Notification {
  return touchNotification(notification, {});
}

// ─────────────────────────────────────────────────────────────
// Templates.
// ─────────────────────────────────────────────────────────────

/** A declared variable of a template. */
export interface NotificationTemplateVariable {
  /** Dot-path into the variables object, e.g. "user.name". */
  readonly name: string;
  readonly required?: boolean;
  readonly default?: string;
}

/** An immutable notification template (rendered by the template engine). */
export interface NotificationTemplate {
  /** Stable template id; deterministic when derived by {@link templateIdFor}. */
  readonly id: string;
  readonly name: string;
  readonly format: NotificationFormat;
  /** Optional subject line (used by subject-bearing channels). */
  readonly subject?: string;
  /** Template body with `{{variable}}` interpolation points. */
  readonly body: string;
  /** Declared variables (validation reference). */
  readonly variables: readonly NotificationTemplateVariable[];
  /** Deterministic content version (bumps when the body/subject changes). */
  readonly version: number;
  /** ISO-8601 UTC timestamp of creation (caller-supplied). */
  readonly createdAt: string;
}

/** Input accepted by {@link createNotificationTemplate}. */
export interface CreateNotificationTemplateInput {
  readonly id?: string;
  readonly name: string;
  readonly format?: NotificationFormat;
  readonly subject?: string;
  readonly body: string;
  readonly variables?: readonly NotificationTemplateVariable[];
  /** Explicit version; when omitted, derived from the content. */
  readonly version?: number;
  /** ISO-8601 UTC timestamp of creation (caller-supplied). */
  readonly createdAt: string;
}

/** Deterministic template id. */
export function templateIdFor(name: string, createdAt: string): string {
  return `template-${hashString(`${name}:${createdAt}`)}`;
}

/** Deterministic content version (hash of subject + body + variables). */
export function templateVersionFor(input: {
  readonly subject?: string;
  readonly body: string;
  readonly variables: readonly NotificationTemplateVariable[];
}): number {
  const value = hashString(
    `${input.subject ?? ""}:${input.body}:${input.variables
      .map((variable) => `${variable.name}:${variable.required ?? false}:${variable.default ?? ""}`)
      .join("|")}`,
  );
  // Derive a stable positive integer version from the hex digest.
  return parseInt(value.slice(0, 8), 16) % 1_000_000;
}

/** Build a new immutable template (deep-frozen, deterministic version). */
export function createNotificationTemplate(
  input: CreateNotificationTemplateInput,
): NotificationTemplate {
  const variables = input.variables ?? [];
  const version =
    input.version ??
    templateVersionFor({
      subject: input.subject,
      body: input.body,
      variables,
    });
  return deepFreeze({
    id: input.id ?? templateIdFor(input.name, input.createdAt),
    name: input.name,
    format: input.format ?? "plain",
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    body: input.body,
    variables: variables.map((variable) => ({
      name: variable.name,
      ...(variable.required !== undefined ? { required: variable.required } : {}),
      ...(variable.default !== undefined ? { default: variable.default } : {}),
    })),
    version,
    createdAt: input.createdAt,
  });
}

/** A partial patch applied by {@link touchNotificationTemplate}. */
export interface NotificationTemplatePatch {
  readonly name?: string;
  readonly format?: NotificationFormat;
  readonly subject?: string | null;
  readonly body?: string;
  readonly variables?: readonly NotificationTemplateVariable[];
}

/** Return the successor template with the patch applied (version recomputed). */
export function touchNotificationTemplate(
  template: NotificationTemplate,
  patch: NotificationTemplatePatch,
): NotificationTemplate {
  const subject =
    patch.subject !== undefined
      ? patch.subject !== null
        ? patch.subject
        : undefined
      : template.subject;
  const body = patch.body ?? template.body;
  const variables =
    patch.variables !== undefined ? patch.variables : template.variables;
  const version = templateVersionFor({ subject, body, variables });
  return createNotificationTemplate({
    id: template.id,
    name: patch.name ?? template.name,
    format: patch.format ?? template.format,
    ...(subject !== undefined ? { subject } : {}),
    body,
    variables,
    version,
    createdAt: template.createdAt,
  });
}

/** Return a deep, detached copy of a template (never frozen). */
export function cloneNotificationTemplate(template: NotificationTemplate): NotificationTemplate {
  return {
    id: template.id,
    name: template.name,
    format: template.format,
    ...(template.subject !== undefined ? { subject: template.subject } : {}),
    body: template.body,
    variables: template.variables.map((variable) => ({ ...variable })),
    version: template.version,
    createdAt: template.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────
// Messages, deliveries, attempts, history.
// ─────────────────────────────────────────────────────────────

/** A rendered message ready for one recipient on one channel. */
export interface NotificationMessage {
  /** Stable message id derived from notification + channel + recipient. */
  readonly id: string;
  readonly notificationId: NotificationId;
  readonly recipientId: string;
  readonly channel: NotificationChannelType;
  readonly subject?: string;
  readonly content: string;
  readonly format: NotificationFormat;
  readonly attachments: readonly NotificationAttachment[];
}

/** Input accepted by {@link createNotificationMessage}. */
export interface CreateNotificationMessageInput {
  readonly notificationId: NotificationId;
  readonly recipientId: string;
  readonly channel: NotificationChannelType;
  readonly subject?: string;
  readonly content: string;
  readonly format?: NotificationFormat;
  readonly attachments?: readonly NotificationAttachment[];
}

/** Deterministic message id. */
export function messageIdFor(
  notificationId: NotificationId,
  recipientId: string,
  channel: NotificationChannelType,
): string {
  return `message-${hashString(`${notificationId}:${recipientId}:${channel}`)}`;
}

/** Build an immutable message (deep-frozen). */
export function createNotificationMessage(input: CreateNotificationMessageInput): NotificationMessage {
  return deepFreeze({
    id: messageIdFor(input.notificationId, input.recipientId, input.channel),
    notificationId: input.notificationId,
    recipientId: input.recipientId,
    channel: input.channel,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    content: input.content,
    format: input.format ?? "plain",
    attachments:
      input.attachments !== undefined ? input.attachments.map(cloneAttachment) : [],
  });
}

/** Per-recipient delivery status. */
export type NotificationDeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "cancelled";

/** An immutable per-recipient delivery record. */
export interface NotificationDelivery {
  /** Stable delivery id derived from notification + recipient. */
  readonly id: string;
  readonly notificationId: NotificationId;
  readonly recipientId: string;
  readonly channel: NotificationChannelType;
  readonly status: NotificationDeliveryStatus;
  /** Number of attempts made. */
  readonly attempts: number;
  /** ISO-8601 UTC timestamp of the delivery's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the first dispatch. */
  readonly startedAt?: string;
  /** ISO-8601 UTC timestamp of the last settlement. */
  readonly finishedAt?: string;
  /** ISO-8601 UTC timestamp of a successful send. */
  readonly sentAt?: string;
  /** Provider message on success. */
  readonly message?: string;
  /** Structured failure detail when not delivered. */
  readonly error?: NotificationError;
}

/** Input accepted by {@link createNotificationDelivery}. */
export interface CreateNotificationDeliveryInput {
  readonly id?: string;
  readonly notificationId: NotificationId;
  readonly recipientId: string;
  readonly channel: NotificationChannelType;
  readonly status?: NotificationDeliveryStatus;
  readonly attempts?: number;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly sentAt?: string;
  readonly message?: string;
  readonly error?: NotificationError;
}

/** Deterministic delivery id. */
export function deliveryIdFor(notificationId: NotificationId, recipientId: string): string {
  return `delivery-${hashString(`${notificationId}:${recipientId}`)}`;
}

/** Build a new immutable delivery record (deep-frozen). */
export function createNotificationDelivery(
  input: CreateNotificationDeliveryInput,
): NotificationDelivery {
  return deepFreeze({
    id: input.id ?? deliveryIdFor(input.notificationId, input.recipientId),
    notificationId: input.notificationId,
    recipientId: input.recipientId,
    channel: input.channel,
    status: input.status ?? "pending",
    attempts: input.attempts ?? 0,
    createdAt: input.createdAt,
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.error !== undefined ? { error: { ...input.error } } : {}),
  });
}

/** A partial patch applied by {@link touchNotificationDelivery}. */
export interface NotificationDeliveryPatch {
  readonly status?: NotificationDeliveryStatus;
  readonly attempts?: number;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly sentAt?: string | null;
  readonly message?: string | null;
  readonly error?: NotificationError | null;
}

/** Return the successor delivery with the patch applied (never mutates). */
export function touchNotificationDelivery(
  delivery: NotificationDelivery,
  patch: NotificationDeliveryPatch,
): NotificationDelivery {
  return {
    id: delivery.id,
    notificationId: delivery.notificationId,
    recipientId: delivery.recipientId,
    channel: delivery.channel,
    status: patch.status ?? delivery.status,
    attempts: patch.attempts ?? delivery.attempts,
    createdAt: delivery.createdAt,
    ...(patch.startedAt !== undefined
      ? patch.startedAt !== null
        ? { startedAt: patch.startedAt }
        : {}
      : delivery.startedAt !== undefined
        ? { startedAt: delivery.startedAt }
        : {}),
    ...(patch.finishedAt !== undefined
      ? patch.finishedAt !== null
        ? { finishedAt: patch.finishedAt }
        : {}
      : delivery.finishedAt !== undefined
        ? { finishedAt: delivery.finishedAt }
        : {}),
    ...(patch.sentAt !== undefined
      ? patch.sentAt !== null
        ? { sentAt: patch.sentAt }
        : {}
      : delivery.sentAt !== undefined
        ? { sentAt: delivery.sentAt }
        : {}),
    ...(patch.message !== undefined
      ? patch.message !== null
        ? { message: patch.message }
        : {}
      : delivery.message !== undefined
        ? { message: delivery.message }
        : {}),
    ...(patch.error !== undefined
      ? patch.error !== null
        ? { error: { ...patch.error } }
        : {}
      : delivery.error !== undefined
        ? { error: { ...delivery.error } }
        : {}),
  };
}

/** Return a deep, detached copy of a delivery record (never frozen). */
export function cloneNotificationDelivery(delivery: NotificationDelivery): NotificationDelivery {
  return touchNotificationDelivery(delivery, {});
}

/** A single attempt of a delivery. */
export interface NotificationDeliveryAttempt {
  /** Stable attempt id derived from delivery + attempt + startedAt. */
  readonly id: string;
  readonly deliveryId: string;
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly status: "sending" | "sent" | "failed" | "cancelled";
  /** ISO-8601 UTC timestamp of the attempt's start. */
  readonly startedAt: string;
  /** ISO-8601 UTC timestamp of the attempt's settlement. */
  readonly finishedAt?: string;
  readonly error?: NotificationError;
  /** Wall-clock duration of the attempt in milliseconds. */
  readonly durationMs?: number;
}

/** Input accepted by {@link createNotificationDeliveryAttempt}. */
export interface CreateNotificationDeliveryAttemptInput {
  readonly id?: string;
  readonly deliveryId: string;
  readonly attempt: number;
  readonly status: NotificationDeliveryAttempt["status"];
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: NotificationError;
  readonly durationMs?: number;
}

/** Deterministic attempt id. */
export function attemptIdFor(deliveryId: string, attempt: number, startedAt: string): string {
  return `attempt-${hashString(`${deliveryId}:${attempt}:${startedAt}`)}`;
}

/** Build a new immutable attempt record (deep-frozen). */
export function createNotificationDeliveryAttempt(
  input: CreateNotificationDeliveryAttemptInput,
): NotificationDeliveryAttempt {
  return deepFreeze({
    id: input.id ?? attemptIdFor(input.deliveryId, input.attempt, input.startedAt),
    deliveryId: input.deliveryId,
    attempt: input.attempt,
    status: input.status,
    startedAt: input.startedAt,
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    ...(input.error !== undefined ? { error: { ...input.error } } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  });
}

/** A history entry of one notification's lifecycle. */
export interface NotificationHistoryEntry {
  /** ISO-8601 UTC timestamp of the transition. */
  readonly at: string;
  /** Transition kind, e.g. "queued", "sending", "delivered", "retried". */
  readonly kind: string;
  readonly detail?: string;
  readonly error?: NotificationError;
}

/** The run history of a single notification. */
export interface NotificationHistory {
  readonly notificationId: NotificationId;
  /** Oldest first. */
  readonly entries: readonly NotificationHistoryEntry[];
}

/** Build an immutable history record. */
export function createNotificationHistory(
  notificationId: NotificationId,
  entries: readonly NotificationHistoryEntry[] = [],
): NotificationHistory {
  return deepFreeze({
    notificationId,
    entries: entries.map((entry) =>
      deepFreeze({
        at: entry.at,
        kind: entry.kind,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        ...(entry.error !== undefined ? { error: { ...entry.error } } : {}),
      }),
    ),
  });
}

// ─────────────────────────────────────────────────────────────
// Failures, results, references, batches, queue models.
// ─────────────────────────────────────────────────────────────

/** A durable failure record (dead-letter candidate). */
export interface NotificationFailure {
  /** Stable failure id derived from notification + attempt + at. */
  readonly id: string;
  readonly notificationId: NotificationId;
  readonly deliveryId?: string;
  readonly attempt: number;
  readonly at: string;
  readonly channel?: NotificationChannelType;
  readonly error: NotificationError;
}

/** Input accepted by {@link createNotificationFailure}. */
export interface CreateNotificationFailureInput {
  readonly id?: string;
  readonly notificationId: NotificationId;
  readonly deliveryId?: string;
  readonly attempt: number;
  readonly at: string;
  readonly channel?: NotificationChannelType;
  readonly error: NotificationError;
}

/** Deterministic failure id. */
export function failureIdFor(
  notificationId: NotificationId,
  attempt: number,
  at: string,
): string {
  return `failure-${hashString(`${notificationId}:${attempt}:${at}`)}`;
}

/** Build a new immutable failure record (deep-frozen). */
export function createNotificationFailure(input: CreateNotificationFailureInput): NotificationFailure {
  return deepFreeze({
    id: input.id ?? failureIdFor(input.notificationId, input.attempt, input.at),
    notificationId: input.notificationId,
    ...(input.deliveryId !== undefined ? { deliveryId: input.deliveryId } : {}),
    attempt: input.attempt,
    at: input.at,
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    error: { ...input.error },
  });
}

/** Structured outcome of delivering one notification. */
export interface NotificationResult {
  readonly notificationId: NotificationId;
  readonly ok: boolean;
  readonly deliveryId?: string;
  readonly error?: NotificationError;
}

/** A stable reference to a notification (list/overview views). */
export interface NotificationReference {
  readonly id: NotificationId;
  readonly title: string;
  readonly status: NotificationStatus;
  readonly priority: NotificationPriority;
  /** ISO-8601 UTC timestamp of creation. */
  readonly createdAt: string;
}

/** A batch of notifications scheduled/delivered together. */
export interface NotificationBatch {
  /** Stable batch id derived from the member ids + createdAt. */
  readonly id: string;
  readonly notificationIds: readonly NotificationId[];
  /** ISO-8601 UTC timestamp of creation (caller-supplied). */
  readonly createdAt: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "cancelled";
}

/** Input accepted by {@link createNotificationBatch}. */
export interface CreateNotificationBatchInput {
  readonly id?: string;
  readonly notificationIds: readonly NotificationId[];
  readonly createdAt: string;
  readonly status?: NotificationBatch["status"];
}

/** Deterministic batch id. */
export function batchIdFor(notificationIds: readonly NotificationId[], createdAt: string): string {
  return `batch-${hashString(`${[...notificationIds].join(":")}:${createdAt}`)}`;
}

/** Build a new immutable batch (deep-frozen). */
export function createNotificationBatch(input: CreateNotificationBatchInput): NotificationBatch {
  return deepFreeze({
    id: input.id ?? batchIdFor(input.notificationIds, input.createdAt),
    notificationIds: [...input.notificationIds],
    createdAt: input.createdAt,
    status: input.status ?? "pending",
  });
}

/** The kinds of queues the notification layer can hold. */
export type NotificationQueueKind = "priority" | "fifo" | "delayed" | "retry" | "deadLetter";

/** Every queue kind, in a stable canonical order. */
export const NOTIFICATION_QUEUE_KINDS: readonly NotificationQueueKind[] = Object.freeze([
  "priority",
  "fifo",
  "delayed",
  "retry",
  "deadLetter",
]);

/** A queue item (a notification reference inside a queue). */
export interface NotificationQueueItem {
  /** Stable item id derived from notification + enqueuedAt. */
  readonly id: string;
  readonly notificationId: NotificationId;
  readonly kind: NotificationQueueKind;
  readonly priority: NotificationPriority;
  readonly status: "pending" | "scheduled" | "delayed" | "retrying" | "dead";
  /** ISO-8601 UTC timestamp of the enqueue. */
  readonly enqueuedAt: string;
  /** When due (delayed/retry queues). */
  readonly dequeueAt?: string;
  /** Attempts made so far. */
  readonly attempt: number;
}

/** Input accepted by {@link createNotificationQueueItem}. */
export interface CreateNotificationQueueItemInput {
  readonly id?: string;
  readonly notificationId: NotificationId;
  readonly kind?: NotificationQueueKind;
  readonly priority?: NotificationPriority;
  readonly status?: NotificationQueueItem["status"];
  readonly enqueuedAt: string;
  readonly dequeueAt?: string;
  readonly attempt?: number;
}

/** Deterministic queue item id. */
export function queueItemIdFor(notificationId: NotificationId, enqueuedAt: string): string {
  return `qitem-${hashString(`${notificationId}:${enqueuedAt}`)}`;
}

/** Build a new immutable queue item (deep-frozen). */
export function createNotificationQueueItem(
  input: CreateNotificationQueueItemInput,
): NotificationQueueItem {
  return deepFreeze({
    id: input.id ?? queueItemIdFor(input.notificationId, input.enqueuedAt),
    notificationId: input.notificationId,
    kind: input.kind ?? "priority",
    priority: input.priority ?? "normal",
    status: input.status ?? "pending",
    enqueuedAt: input.enqueuedAt,
    ...(input.dequeueAt !== undefined ? { dequeueAt: input.dequeueAt } : {}),
    attempt: input.attempt ?? 0,
  });
}

/** A queue model (snapshot view of one queue). */
export interface NotificationQueue {
  readonly id: string;
  readonly name: string;
  readonly kind: NotificationQueueKind;
  readonly capacity: number;
  readonly itemIds: readonly NotificationId[];
  /** ISO-8601 UTC timestamp of creation. */
  readonly createdAt: string;
}

// ─────────────────────────────────────────────────────────────
// Preferences, subscriptions, rules.
// ─────────────────────────────────────────────────────────────

/** Per-channel user configuration. */
export interface NotificationChannelConfig {
  readonly channel: NotificationChannelType;
  /** When false, this channel is disabled for the user. */
  readonly enabled: boolean;
  /** Optional per-channel override address. */
  readonly address?: string;
  /** Optional per-channel quiet hours (ISO HH:mm strings). */
  readonly quietHours?: { readonly start: string; readonly end: string };
}

/** Immutable per-user notification preferences. */
export interface NotificationPreference {
  /** Stable preference id derived from the user id. */
  readonly id: string;
  readonly userId: string;
  /** Enabled channels (empty = all allowed channels). */
  readonly channels: readonly NotificationChannelType[];
  /** Mute state (temporary or permanent). */
  readonly muted: boolean;
  /** ISO-8601 UTC timestamp until which the user is muted. */
  readonly mutedUntil?: string;
  /** Quiet hours (local time — HH:mm). */
  readonly quietHours?: { readonly start: string; readonly end: string };
  /** When true, notifications are aggregated into a digest instead of sent. */
  readonly digestMode: boolean;
  /** IETF language tag, e.g. "en". */
  readonly language?: string;
  /** IANA timezone, e.g. "UTC". */
  readonly timezone?: string;
  /** Per-category enablement. */
  readonly categories: Readonly<Record<NotificationCategory, boolean>>;
  /** Per-priority enablement. */
  readonly priorities: Readonly<Record<NotificationPriority, boolean>>;
  /** Per-channel configuration. */
  readonly channelConfig: Readonly<Record<NotificationChannelType, NotificationChannelConfig>>;
  /** ISO-8601 UTC timestamp of the most recent update. */
  readonly updatedAt: string;
}

/** Input accepted by {@link createNotificationPreference}. */
export interface CreateNotificationPreferenceInput {
  readonly id?: string;
  readonly userId: string;
  readonly channels?: readonly NotificationChannelType[];
  readonly muted?: boolean;
  readonly mutedUntil?: string;
  readonly quietHours?: { readonly start: string; readonly end: string };
  readonly digestMode?: boolean;
  readonly language?: string;
  readonly timezone?: string;
  readonly categories?: Partial<Record<NotificationCategory, boolean>>;
  readonly priorities?: Partial<Record<NotificationPriority, boolean>>;
  readonly channelConfig?: Partial<Record<NotificationChannelType, Partial<NotificationChannelConfig>>>;
  /** ISO-8601 UTC timestamp of the update. */
  readonly updatedAt: string;
}

/** Deterministic preference id. */
export function preferenceIdFor(userId: string): string {
  return `preference-${hashString(userId)}`;
}

/** Build default per-category enablement (everything on). */
export function defaultPreferenceCategories(): Readonly<Record<NotificationCategory, boolean>> {
  return deepFreeze(
    Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, true])) as Record<
      NotificationCategory,
      boolean
    >,
  );
}

/** Build default per-priority enablement (everything on). */
export function defaultPreferencePriorities(): Readonly<Record<NotificationPriority, boolean>> {
  return deepFreeze(
    Object.fromEntries(
      (["low", "normal", "high", "critical"] as const).map((priority) => [priority, true]),
    ) as Record<NotificationPriority, boolean>,
  );
}

/** Build default per-channel configuration (all enabled). */
export function defaultPreferenceChannelConfig(): Readonly<
  Record<NotificationChannelType, NotificationChannelConfig>
> {
  return deepFreeze(
    Object.fromEntries(
      NOTIFICATION_CHANNEL_TYPES.map((channel) => [channel, { channel, enabled: true }]),
    ) as Record<NotificationChannelType, NotificationChannelConfig>,
  );
}

/** Build a new immutable preference (deep-frozen). */
export function createNotificationPreference(
  input: CreateNotificationPreferenceInput,
): NotificationPreference {
  const categories = defaultPreferenceCategories();
  const priorities = defaultPreferencePriorities();
  const channelConfig = defaultPreferenceChannelConfig();
  return deepFreeze({
    id: input.id ?? preferenceIdFor(input.userId),
    userId: input.userId,
    channels: input.channels !== undefined ? [...input.channels] : [],
    muted: input.muted ?? false,
    ...(input.mutedUntil !== undefined ? { mutedUntil: input.mutedUntil } : {}),
    ...(input.quietHours !== undefined ? { quietHours: { ...input.quietHours } } : {}),
    digestMode: input.digestMode ?? false,
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    categories: deepFreeze({
      ...categories,
      ...(input.categories ?? {}),
    }),
    priorities: deepFreeze({
      ...priorities,
      ...(input.priorities ?? {}),
    }),
    channelConfig: deepFreeze(
      Object.fromEntries(
        NOTIFICATION_CHANNEL_TYPES.map((channel) => {
          const existing = channelConfig[channel];
          const patch = input.channelConfig?.[channel] ?? {};
          return [
            channel,
            deepFreeze({
              channel,
              enabled: patch.enabled ?? existing.enabled,
              ...(patch.address !== undefined ? { address: patch.address } : {}),
              ...(patch.quietHours !== undefined
                ? { quietHours: { ...patch.quietHours } }
                : existing.quietHours !== undefined
                  ? { quietHours: { ...existing.quietHours } }
                  : {}),
            }),
          ];
        }),
      ) as Record<NotificationChannelType, NotificationChannelConfig>,
    ),
    updatedAt: input.updatedAt,
  });
}

/** A partial patch applied by {@link touchNotificationPreference}. */
export interface NotificationPreferencePatch {
  readonly channels?: readonly NotificationChannelType[];
  readonly muted?: boolean;
  readonly mutedUntil?: string | null;
  readonly quietHours?: { readonly start: string; readonly end: string } | null;
  readonly digestMode?: boolean;
  readonly language?: string | null;
  readonly timezone?: string | null;
  readonly categories?: Partial<Record<NotificationCategory, boolean>>;
  readonly priorities?: Partial<Record<NotificationPriority, boolean>>;
  readonly channelConfig?: Partial<Record<NotificationChannelType, Partial<NotificationChannelConfig>>>;
  readonly updatedAt?: string;
}

/** Return the successor preference with the patch applied (never mutates). */
export function touchNotificationPreference(
  preference: NotificationPreference,
  patch: NotificationPreferencePatch,
): NotificationPreference {
  const categories = { ...preference.categories, ...(patch.categories ?? {}) };
  const priorities = { ...preference.priorities, ...(patch.priorities ?? {}) };
  const channelConfig = Object.fromEntries(
    NOTIFICATION_CHANNEL_TYPES.map((channel) => {
      const existing = preference.channelConfig[channel];
      const update = patch.channelConfig?.[channel] ?? {};
      const patched: NotificationChannelConfig = {
        channel,
        enabled: update.enabled ?? existing.enabled,
        ...(update.address !== undefined ? { address: update.address } : {}),
        ...(update.quietHours !== undefined
          ? { quietHours: { ...update.quietHours } }
          : existing.quietHours !== undefined
            ? { quietHours: { ...existing.quietHours } }
            : {}),
      };
      return [channel, patched];
    }),
  ) as Record<NotificationChannelType, NotificationChannelConfig>;
  return createNotificationPreference({
    id: preference.id,
    userId: preference.userId,
    channels: patch.channels !== undefined ? patch.channels : preference.channels,
    muted: patch.muted ?? preference.muted,
    ...(patch.mutedUntil !== undefined
      ? patch.mutedUntil !== null
        ? { mutedUntil: patch.mutedUntil }
        : {}
      : preference.mutedUntil !== undefined
        ? { mutedUntil: preference.mutedUntil }
        : {}),
    ...(patch.quietHours !== undefined
      ? patch.quietHours !== null
        ? { quietHours: patch.quietHours }
        : {}
      : preference.quietHours !== undefined
        ? { quietHours: preference.quietHours }
        : {}),
    digestMode: patch.digestMode ?? preference.digestMode,
    ...(patch.language !== undefined
      ? patch.language !== null
        ? { language: patch.language }
        : {}
      : preference.language !== undefined
        ? { language: preference.language }
        : {}),
    ...(patch.timezone !== undefined
      ? patch.timezone !== null
        ? { timezone: patch.timezone }
        : {}
      : preference.timezone !== undefined
        ? { timezone: preference.timezone }
        : {}),
    categories,
    priorities,
    channelConfig,
    updatedAt: patch.updatedAt ?? preference.updatedAt,
  });
}

/** A per-user topic subscription. */
export interface NotificationSubscription {
  /** Stable subscription id derived from user + topic. */
  readonly id: string;
  readonly userId: string;
  readonly topic: string;
  readonly channels: readonly NotificationChannelType[];
  readonly active: boolean;
  /** ISO-8601 UTC timestamp of creation. */
  readonly createdAt: string;
}

/** Input accepted by {@link createNotificationSubscription}. */
export interface CreateNotificationSubscriptionInput {
  readonly id?: string;
  readonly userId: string;
  readonly topic: string;
  readonly channels?: readonly NotificationChannelType[];
  readonly active?: boolean;
  readonly createdAt: string;
}

/** Deterministic subscription id. */
export function subscriptionIdFor(userId: string, topic: string): string {
  return `subscription-${hashString(`${userId}:${topic}`)}`;
}

/** Build a new immutable subscription (deep-frozen). */
export function createNotificationSubscription(
  input: CreateNotificationSubscriptionInput,
): NotificationSubscription {
  return deepFreeze({
    id: input.id ?? subscriptionIdFor(input.userId, input.topic),
    userId: input.userId,
    topic: input.topic,
    channels: input.channels !== undefined ? [...input.channels] : [],
    active: input.active ?? true,
    createdAt: input.createdAt,
  });
}

/** A user-level preference rule (channel/category/priority filter). */
export interface NotificationPreferenceRule {
  /** Stable rule id derived from the rule's identity. */
  readonly id: string;
  readonly userId: string;
  /** When set, the rule applies only to this channel. */
  readonly channel?: NotificationChannelType;
  /** When set, the rule applies only to this category. */
  readonly category?: NotificationCategory;
  /** When set, the rule applies only to this priority. */
  readonly priority?: NotificationPriority;
  /** Whether the rule allows or blocks delivery. */
  readonly enabled: boolean;
  /** ISO-8601 UTC timestamp of creation. */
  readonly createdAt: string;
}

/** Input accepted by {@link createNotificationPreferenceRule}. */
export interface CreateNotificationPreferenceRuleInput {
  readonly id?: string;
  readonly userId: string;
  readonly channel?: NotificationChannelType;
  readonly category?: NotificationCategory;
  readonly priority?: NotificationPriority;
  readonly enabled: boolean;
  readonly createdAt: string;
}

/** Deterministic preference rule id. */
export function preferenceRuleIdFor(input: {
  readonly userId: string;
  readonly channel?: NotificationChannelType;
  readonly category?: NotificationCategory;
  readonly priority?: NotificationPriority;
}): string {
  return `rule-${hashString(
    `${input.userId}:${input.channel ?? ""}:${input.category ?? ""}:${input.priority ?? ""}`,
  )}`;
}

/** Build a new immutable preference rule (deep-frozen). */
export function createNotificationPreferenceRule(
  input: CreateNotificationPreferenceRuleInput,
): NotificationPreferenceRule {
  return deepFreeze({
    id:
      input.id ??
      preferenceRuleIdFor({
        userId: input.userId,
        channel: input.channel,
        category: input.category,
        priority: input.priority,
      }),
    userId: input.userId,
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    enabled: input.enabled,
    createdAt: input.createdAt,
  });
}

/** A trigger rule mapping an application event to a notification. */
export interface NotificationRule {
  /** Stable rule id derived from name + event + createdAt. */
  readonly id: string;
  readonly name: string;
  /** Opaque event kind the rule listens to, e.g. "digest.published". */
  readonly event: string;
  readonly templateId?: string;
  readonly channels: readonly NotificationChannelType[];
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  /** ISO-8601 UTC timestamp of creation. */
  readonly createdAt: string;
  readonly active: boolean;
}

/** Input accepted by {@link createNotificationRule}. */
export interface CreateNotificationRuleInput {
  readonly id?: string;
  readonly name: string;
  readonly event: string;
  readonly templateId?: string;
  readonly channels?: readonly NotificationChannelType[];
  readonly category?: NotificationCategory;
  readonly priority?: NotificationPriority;
  readonly createdAt: string;
  readonly active?: boolean;
}

/** Deterministic notification rule id. */
export function notificationRuleIdFor(name: string, event: string, createdAt: string): string {
  return `rule-${hashString(`${name}:${event}:${createdAt}`)}`;
}

/** Build a new immutable notification rule (deep-frozen). */
export function createNotificationRule(input: CreateNotificationRuleInput): NotificationRule {
  return deepFreeze({
    id: input.id ?? notificationRuleIdFor(input.name, input.event, input.createdAt),
    name: input.name,
    event: input.event,
    ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
    channels: input.channels !== undefined ? [...input.channels] : [],
    category: input.category ?? "system",
    priority: input.priority ?? "normal",
    createdAt: input.createdAt,
    active: input.active ?? true,
  });
}

// ─────────────────────────────────────────────────────────────
// Statistics, summaries, snapshots, metrics.
// ─────────────────────────────────────────────────────────────

/** Aggregate statistics over a set of notifications. */
export interface NotificationStatistics {
  readonly total: number;
  readonly byStatus: Readonly<Record<NotificationStatus, number>>;
  readonly byPriority: Readonly<Record<NotificationPriority, number>>;
  readonly byCategory: Readonly<Record<NotificationCategory, number>>;
  readonly byChannel: Readonly<Record<NotificationChannelType, number>>;
}

/** Compact summary of the notification layer. */
export interface NotificationSummary {
  readonly total: number;
  readonly pending: number;
  readonly queued: number;
  readonly sending: number;
  readonly sent: number;
  readonly delivered: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly dead: number;
  /** Aggregate status derived from the counts (worst wins). */
  readonly overall: NotificationStatus;
}

/** Point-in-time snapshot of the notification layer. */
export interface NotificationSnapshot {
  readonly at: string;
  readonly notifications: readonly Notification[];
  readonly deliveries: readonly NotificationDelivery[];
  readonly statistics: NotificationStatistics;
  readonly summary: NotificationSummary;
}

/** Rolled-up delivery metrics of the notification layer. */
export interface NotificationMetrics {
  readonly sent: number;
  readonly delivered: number;
  readonly failed: number;
  readonly retried: number;
  readonly dead: number;
  readonly cancelled: number;
  readonly deduplicated: number;
  /** Average delivery latency in milliseconds (measured via injected clock). */
  readonly averageLatencyMs?: number;
  /** Maximum delivery latency in milliseconds. */
  readonly maxLatencyMs?: number;
  /** Total delivery attempts made. */
  readonly totalAttempts: number;
  /** Failure rate over settled attempts (0..1), or undefined when none. */
  readonly failureRate?: number;
}

/** Build deterministic statistics from notifications. */
export function notificationStatistics(
  notifications: readonly Notification[],
): NotificationStatistics {
  const byStatus = Object.fromEntries(
    NOTIFICATION_STATUSES.map((status) => [status, 0]),
  ) as Record<NotificationStatus, number>;
  const byPriority = Object.fromEntries(
    (["low", "normal", "high", "critical"] as const).map((priority) => [priority, 0]),
  ) as Record<NotificationPriority, number>;
  const byCategory = Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [category, 0]),
  ) as Record<NotificationCategory, number>;
  const byChannel = Object.fromEntries(
    NOTIFICATION_CHANNEL_TYPES.map((channel) => [channel, 0]),
  ) as Record<NotificationChannelType, number>;
  for (const notification of notifications) {
    byStatus[notification.status] += 1;
    byPriority[notification.priority] += 1;
    byCategory[notification.category] += 1;
    for (const recipient of notification.recipients) {
      byChannel[recipient.channel] += 1;
    }
  }
  return deepFreeze({ total: notifications.length, byStatus, byPriority, byCategory, byChannel });
}

/** Build a compact summary from notifications. */
export function notificationSummary(notifications: readonly Notification[]): NotificationSummary {
  const stats = notificationStatistics(notifications);
  const count = (status: NotificationStatus): number => stats.byStatus[status];
  const overall: NotificationStatus =
    count("dead") > 0
      ? "dead"
      : count("failed") > 0
        ? "failed"
        : count("cancelled") > 0
          ? "cancelled"
          : count("sending") > 0
            ? "sending"
            : count("queued") > 0
              ? "queued"
              : count("pending") > 0
                ? "pending"
                : count("delivered") > 0
                  ? "delivered"
                  : count("sent") > 0
                    ? "sent"
                    : "pending";
  return deepFreeze({
    total: stats.total,
    pending: count("pending"),
    queued: count("queued"),
    sending: count("sending"),
    sent: count("sent"),
    delivered: count("delivered"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    dead: count("dead"),
    overall,
  });
}

/** Build a point-in-time snapshot (deep-frozen). */
export function createNotificationSnapshot(input: {
  readonly at: string;
  readonly notifications: readonly Notification[];
  readonly deliveries: readonly NotificationDelivery[];
}): NotificationSnapshot {
  const statistics = notificationStatistics(input.notifications);
  return deepFreeze({
    at: input.at,
    notifications: input.notifications.map(cloneNotification),
    deliveries: input.deliveries.map(cloneNotificationDelivery),
    statistics,
    summary: notificationSummary(input.notifications),
  });
}

/** Build rolled-up metrics from notifications, deliveries and attempts. */
export function notificationMetrics(input: {
  readonly notifications: readonly Notification[];
  readonly deliveries: readonly NotificationDelivery[];
  readonly attempts: readonly NotificationDeliveryAttempt[];
  readonly failures: readonly NotificationFailure[];
}): NotificationMetrics {
  const notifications = input.notifications;
  const deliveries = input.deliveries;
  const attempts = input.attempts;
  const failures = input.failures;
  const sent = notifications.filter((notification) => notification.status === "sent").length;
  const delivered = notifications.filter((notification) => notification.status === "delivered").length;
  const failed = notifications.filter((notification) => notification.status === "failed").length;
  const dead = notifications.filter((notification) => notification.status === "dead").length;
  const cancelled = notifications.filter((notification) => notification.status === "cancelled").length;
  const retried = failures.filter((failure) => failure.attempt > 1).length;
  const deduplicated = deliveries.filter((delivery) => delivery.status === "cancelled" && delivery.error?.code === "deduplicated").length;
  const durations = attempts
    .filter((attempt) => attempt.durationMs !== undefined)
    .map((attempt) => attempt.durationMs as number);
  const sorted = [...durations].sort((a, b) => a - b);
  const totalAttempts = attempts.length;
  const settled = deliveries.filter(
    (delivery) => delivery.status === "sent" || delivery.status === "failed",
  ).length;
  const settledFailures = deliveries.filter(
    (delivery) => delivery.status === "failed",
  ).length;
  return deepFreeze({
    sent,
    delivered,
    failed,
    retried,
    dead,
    cancelled,
    deduplicated,
    ...(durations.length > 0
      ? {
          averageLatencyMs:
            durations.reduce((total, value) => total + value, 0) / durations.length,
          maxLatencyMs: sorted[sorted.length - 1],
        }
      : {}),
    totalAttempts,
    ...(settled > 0 ? { failureRate: settledFailures / settled } : {}),
  });
}

// ─────────────────────────────────────────────────────────────
// Retry / dead-letter models.
// ─────────────────────────────────────────────────────────────

/** Retry policy applied to failed deliveries. */
export interface NotificationRetryPolicy {
  /** Total retries after the first attempt (0 = no retries unless configured). */
  readonly maxRetries: number;
  /** Base delay between attempts, in milliseconds. */
  readonly backoffMs: number;
  /** Cap on the effective backoff. */
  readonly maxDelayMs?: number;
  /** When defined, only these error codes are retried. */
  readonly retryableCodes?: readonly string[];
}

/** Default retry policy: no retries unless configured. */
export function createNotificationRetryPolicy(
  input: Partial<NotificationRetryPolicy> = {},
): NotificationRetryPolicy {
  return deepFreeze({
    maxRetries: input.maxRetries ?? 0,
    backoffMs: input.backoffMs ?? 0,
    ...(input.maxDelayMs !== undefined ? { maxDelayMs: input.maxDelayMs } : {}),
    ...(input.retryableCodes !== undefined ? { retryableCodes: [...input.retryableCodes] } : {}),
  });
}

// ─────────────────────────────────────────────────────────────
// Limits, configuration, rate limits.
// ─────────────────────────────────────────────────────────────

/** Hard limits applied to notification sends. */
export interface NotificationLimits {
  /** Maximum recipients per notification. */
  readonly maxRecipients: number;
  /** Maximum attachments per notification. */
  readonly maxAttachments: number;
  /** Maximum body length in characters. */
  readonly maxBodyLength: number;
  /** Maximum subject length in characters. */
  readonly maxSubjectLength: number;
}

/** Default notification limits. */
export const DEFAULT_NOTIFICATION_LIMITS: NotificationLimits = deepFreeze({
  maxRecipients: 100,
  maxAttachments: 10,
  maxBodyLength: 10_000,
  maxSubjectLength: 200,
});

/** A rate limit window. */
export interface NotificationRateLimit {
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Maximum sends per window. */
  readonly maxSends: number;
}

/** Build a rate limit (deep-frozen). */
export function createNotificationRateLimit(
  input: Partial<NotificationRateLimit> = {},
): NotificationRateLimit {
  return deepFreeze({
    windowMs: input.windowMs ?? 60_000,
    maxSends: input.maxSends ?? 100,
  });
}

/** Global notification configuration (dependency-injected defaults). */
export interface NotificationConfiguration {
  readonly defaultPriority: NotificationPriority;
  readonly defaultCategory: NotificationCategory;
  readonly defaultChannels: readonly NotificationChannelType[];
  readonly retryPolicy: NotificationRetryPolicy;
  readonly limits: NotificationLimits;
  readonly rateLimit: NotificationRateLimit;
  /** When true, digests are enabled (aggregation path). */
  readonly digestEnabled: boolean;
  /** When true, sends with a `dedupeKey` are deduplicated. */
  readonly dedupeEnabled: boolean;
}

/** Build the default notification configuration. */
export function createNotificationConfiguration(
  input: Partial<Omit<NotificationConfiguration, "retryPolicy" | "limits" | "rateLimit">> & {
    readonly retryPolicy?: Partial<NotificationRetryPolicy>;
    readonly limits?: Partial<NotificationLimits>;
    readonly rateLimit?: Partial<NotificationRateLimit>;
  } = {},
): NotificationConfiguration {
  return deepFreeze({
    defaultPriority: input.defaultPriority ?? "normal",
    defaultCategory: input.defaultCategory ?? "system",
    defaultChannels:
      input.defaultChannels !== undefined ? [...input.defaultChannels] : ["email", "inapp"],
    retryPolicy: createNotificationRetryPolicy(input.retryPolicy),
    limits: { ...DEFAULT_NOTIFICATION_LIMITS, ...(input.limits ?? {}) },
    rateLimit: createNotificationRateLimit(input.rateLimit),
    digestEnabled: input.digestEnabled ?? true,
    dedupeEnabled: input.dedupeEnabled ?? true,
  });
}

// ─────────────────────────────────────────────────────────────
// Health, reports, providers.
// ─────────────────────────────────────────────────────────────

/** Health status of the notification layer. */
export type NotificationHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

/** Health of the notification layer at a point in time. */
export interface NotificationHealth {
  readonly status: NotificationHealthStatus;
  /** Score 0..1 (1 = fully healthy), derived deterministically. */
  readonly score: number;
  /** ISO-8601 UTC timestamp of the last check. */
  readonly lastCheckedAt?: string;
  readonly message?: string;
}

/** Build an immutable health record. */
export function createNotificationHealth(
  input: Partial<NotificationHealth> = {},
): NotificationHealth {
  return deepFreeze({
    status: input.status ?? "unknown",
    score: input.score ?? 1,
    ...(input.lastCheckedAt !== undefined ? { lastCheckedAt: input.lastCheckedAt } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
  });
}

/** A delivery report over a time period. */
export interface NotificationReport {
  /** Stable report id derived from scope + at. */
  readonly id: string;
  /** ISO-8601 UTC timestamp of the report. */
  readonly at: string;
  /** ISO-8601 UTC timestamp of the period start. */
  readonly from?: string;
  /** ISO-8601 UTC timestamp of the period end. */
  readonly to?: string;
  readonly statistics: NotificationStatistics;
  readonly summary: NotificationSummary;
  readonly metrics: NotificationMetrics;
  /** Open alerts/health at report time. */
  readonly health?: NotificationHealth;
}

/** Input accepted by {@link createNotificationReport}. */
export interface CreateNotificationReportInput {
  readonly id?: string;
  readonly at: string;
  readonly from?: string;
  readonly to?: string;
  readonly statistics: NotificationStatistics;
  readonly summary: NotificationSummary;
  readonly metrics: NotificationMetrics;
  readonly health?: NotificationHealth;
}

/** Deterministic report id. */
export function reportIdFor(scope: string, at: string): string {
  return `report-${hashString(`${scope}:${at}`)}`;
}

/** Build an immutable report (deep-frozen). */
export function createNotificationReport(input: CreateNotificationReportInput): NotificationReport {
  return deepFreeze({
    id: input.id ?? reportIdFor("app", input.at),
    at: input.at,
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
    statistics: input.statistics,
    summary: input.summary,
    metrics: input.metrics,
    ...(input.health !== undefined ? { health: { ...input.health } } : {}),
  });
}

/** A notification provider (transport behind a channel). */
export interface NotificationProvider {
  /** Stable provider id derived from channel + name. */
  readonly id: string;
  readonly channel: NotificationChannelType;
  readonly name: string;
  readonly capabilities: NotificationProviderCapabilities;
}

/** Capabilities a provider/channel exposes. */
export interface NotificationProviderCapabilities {
  readonly supportsAttachments: boolean;
  readonly supportsBatch: boolean;
  readonly supportsHtml: boolean;
  readonly supportsMarkdown: boolean;
  /** Maximum messages per batch. */
  readonly maxBatchSize?: number;
}

/** Build provider capabilities. */
export function createNotificationProviderCapabilities(
  input: Partial<NotificationProviderCapabilities> = {},
): NotificationProviderCapabilities {
  return deepFreeze({
    supportsAttachments: input.supportsAttachments ?? false,
    supportsBatch: input.supportsBatch ?? false,
    supportsHtml: input.supportsHtml ?? false,
    supportsMarkdown: input.supportsMarkdown ?? false,
    ...(input.maxBatchSize !== undefined ? { maxBatchSize: input.maxBatchSize } : {}),
  });
}

/** Deterministic provider id. */
export function providerIdFor(channel: NotificationChannelType, name: string): string {
  return `provider-${hashString(`${channel}:${name}`)}`;
}

/** Build an immutable provider record. */
export function createNotificationProvider(input: {
  readonly channel: NotificationChannelType;
  readonly name: string;
  readonly capabilities: NotificationProviderCapabilities;
}): NotificationProvider {
  return deepFreeze({
    id: providerIdFor(input.channel, input.name),
    channel: input.channel,
    name: input.name,
    capabilities: { ...input.capabilities },
  });
}

/** Structured outcome of a transport send. */
export interface NotificationProviderResult {
  readonly ok: boolean;
  /** Provider message on success (e.g. a message id). */
  readonly message?: string;
  /** Structured failure detail when not ok. */
  readonly error?: NotificationError;
}

/** A provider result scoped to its provider. */
export interface NotificationProviderResultScoped {
  readonly providerId: string;
  readonly result: NotificationProviderResult;
}

// ─────────────────────────────────────────────────────────────
// Runtime context + channel contract.
// ─────────────────────────────────────────────────────────────

/** Runtime context handed to the delivery pipeline. */
export interface NotificationContext {
  readonly userId?: string;
  /** ISO-8601 UTC timestamp (injected, deterministic). */
  readonly now: string;
  readonly correlationId?: string;
  readonly locale?: string;
  readonly timezone?: string;
}

/** Input handed to a channel's `send`. */
export interface NotificationChannelSendInput {
  readonly recipient: NotificationRecipient;
  readonly subject?: string;
  readonly content: string;
  readonly format?: NotificationFormat;
  readonly attachments?: readonly NotificationAttachment[];
  /** Provider-specific opaque extras. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Structured output of a single channel send. */
export interface NotificationChannelSendOutput {
  readonly ok: boolean;
  /** Provider message on success. */
  readonly message?: string;
  /** Structured failure detail when not ok. */
  readonly error?: NotificationError;
  /** Wall-clock duration of the send in milliseconds. */
  readonly durationMs?: number;
}

/** Structured validation result of a channel input. */
export interface NotificationChannelValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * The transport seam of one channel. Implementations are dependency-injected
 * (no SDK logic lives in this layer); built-ins default to a deterministic
 * mock transport. Applications wire real providers through `send`.
 */
export interface NotificationChannel {
  readonly channel: NotificationChannelType;
  readonly capabilities: NotificationProviderCapabilities;
  /** Informational rate limit exposed by the channel. */
  readonly rateLimit?: NotificationRateLimit;
  /** Validate an input before sending (pure; never throws). */
  validate(input: NotificationChannelSendInput): NotificationChannelValidation;
  /** Send one message; never throws — returns a structured output. */
  send(input: NotificationChannelSendInput, now: string): Promise<NotificationChannelSendOutput>;
  /** Send many messages in parallel; never throws. */
  sendBatch(
    inputs: readonly NotificationChannelSendInput[],
    now: string,
  ): Promise<NotificationChannelSendOutput[]>;
  /** Health of the channel at `now` (never throws). */
  health(now: string): NotificationHealth;
  /** Whether a failed output is worth retrying. */
  retryHint(result: NotificationChannelSendOutput): boolean;
}

// ─────────────────────────────────────────────────────────────
// Shared deep-clone/deep-freeze helpers.
// ─────────────────────────────────────────────────────────────

/** Deep-freeze a JSON value in place and return it (idempotent). */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value) as unknown as T;
  }
  return value;
}

/** Detached copy of a schedule. */
function cloneSchedule(schedule: NotificationSchedule): NotificationSchedule {
  return {
    ...(schedule.at !== undefined ? { at: schedule.at } : {}),
    ...(schedule.everyMs !== undefined ? { everyMs: schedule.everyMs } : {}),
    ...(schedule.startsAt !== undefined ? { startsAt: schedule.startsAt } : {}),
  };
}

/** Detached copy of an attachment. */
function cloneAttachment(attachment: NotificationAttachment): NotificationAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    ...(attachment.url !== undefined ? { url: attachment.url } : {}),
    ...(attachment.content !== undefined ? { content: attachment.content } : {}),
  };
}

/** Detached copy of a payload. */
function clonePayload(payload: NotificationPayload): NotificationPayload {
  return deepFreeze({
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    body: payload.body,
    ...(payload.data !== undefined ? { data: { ...payload.data } } : {}),
  });
}

/** Detached copy of metadata. */
function cloneMetadata(metadata: NotificationMetadata): NotificationMetadata {
  return createNotificationMetadata({
    tags: metadata.tags,
    source: metadata.source,
    expiresAt: metadata.expiresAt,
    dedupeKey: metadata.dedupeKey,
    correlationId: metadata.correlationId,
  });
}

/** Whether a notification is settled (no further delivery will happen). */
export function isNotificationSettled(notification: Notification): boolean {
  return (
    notification.status === "delivered" ||
    notification.status === "sent" ||
    notification.status === "failed" ||
    notification.status === "cancelled" ||
    notification.status === "dead"
  );
}

/** Whether a one-time schedule is due at `now`. */
export function isScheduleDue(schedule: NotificationSchedule, now: string): boolean {
  if (schedule.at !== undefined) return Date.parse(schedule.at) <= Date.parse(now);
  if (schedule.everyMs !== undefined && schedule.everyMs > 0 && schedule.startsAt !== undefined) {
    const startsAtMs = Date.parse(schedule.startsAt);
    const everyMs = schedule.everyMs;
    const nowMs = Date.parse(now);
    return nowMs >= startsAtMs && (nowMs - startsAtMs) % everyMs < 60_000;
  }
  return false;
}

/** Whether a notification is deliverable at `now` (not settled/expired). */
export function isNotificationDeliverable(notification: Notification, now: string): boolean {
  if (isNotificationSettled(notification)) return false;
  if (notification.metadata.expiresAt !== undefined) {
    if (Date.parse(notification.metadata.expiresAt) <= Date.parse(now)) return false;
  }
  if (notification.scheduledAt !== undefined) {
    if (Date.parse(notification.scheduledAt) > Date.parse(now)) return false;
  }
  return true;
}
