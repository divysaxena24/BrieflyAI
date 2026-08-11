/**
 * Notification & Delivery System — delivery engine (Phase 6D STEP 6).
 *
 * The async orchestration core of the notification layer. The engine is
 * internally mutable-by-replacement (matching the Monitoring/Worker engine
 * composition-root convention): every mutation replaces the engine's own
 * state fields in place and returns `{ engine: this, … }` — the receiver is
 * never conceptually "mutated in a destructive way" (every successor is a
 * fresh value assignment) and every model it stores stays immutable.
 *
 * Pipeline per dispatch pass:
 *
 * ```text
 * send / sendBatch / schedule
 *   → validate + dedupe + render (templates) + create
 *   → enqueue (immediate → pending; future → delayed)
 * dispatchDue(now, limit)
 *   → promote due delayed/retry items → pending
 *   → dequeue → deliver recipients in parallel
 *       (fallback channels, rate limiting, per-recipient receipts)
 *   → settle: delivered / retry (backoff) / dead (dead letter) / cancelled
 *   → record deliveries, attempts, history, failures, metrics
 * ```
 *
 * Guarantees:
 * - **Failure isolation**: a throwing channel never fails the caller — it
 *   becomes a structured per-recipient failure.
 * - **Determinism**: identical inputs + injected `now`/`clockMs` produce
 *   identical state; ordering is deterministic (recipient order, item
 *   order, settlement order).
 * - **Deduplication**: a `dedupeKey` skips re-sends of a non-settled
 *   notification.
 * - **No logging, no wall clock**: timestamps and clocks are injected.
 */

import type {
  Notification,
  NotificationAttachment,
  NotificationBatch,
  NotificationCategory,
  NotificationChannelSendInput,
  NotificationChannelSendOutput,
  NotificationChannelType,
  NotificationConfiguration,
  NotificationDelivery,
  NotificationDeliveryAttempt,
  NotificationError,
  NotificationFailure,
  NotificationFormat,
  NotificationHealth,
  NotificationHistory,
  NotificationHistoryEntry,
  NotificationMetrics,
  NotificationPriority,
  NotificationRecipient,
  NotificationReport,
  NotificationSchedule,
  NotificationSnapshot,
  NotificationStatistics,
  NotificationSummary,
} from "./types";
import {
  cloneNotification,
  createNotification,
  createNotificationBatch,
  createNotificationDelivery,
  createNotificationDeliveryAttempt,
  createNotificationHealth,
  createNotificationHistory,
  createNotificationReport,
  createNotificationSnapshot,
  deliveryIdFor,
  isNotificationDeliverable,
  notificationMetrics,
  notificationStatistics,
  notificationSummary,
  touchNotification,
  touchNotificationDelivery,
} from "./types";
import {
  NotificationQueueSet,
  createNotificationQueueSet,
  type NotificationQueueSetStatistics,
  type NotificationQueueSetSummary,
} from "./queue";
import {
  DeadLetterStore,
  RetryManager,
  createDeadLetterStore,
  createRetryManager,
} from "./retry";
import {
  NotificationChannelRegistry,
  createDefaultNotificationChannels,
  createNotificationChannelRegistry,
} from "./channels";
import { TemplateRegistry, createTemplateRegistry, renderTemplate } from "./templates";

/** A per-recipient delivery outcome of one dispatch pass. */
export interface DeliveryReceipt {
  readonly notificationId: string;
  readonly recipientId: string;
  readonly channel: NotificationChannelType;
  readonly ok: boolean;
  /** Attempts made for this recipient. */
  readonly attempts: number;
  /** Provider message on success. */
  readonly message?: string;
  /** Structured failure detail when not ok. */
  readonly error?: NotificationError;
}

/** The aggregated outcome of one dispatch pass. */
export interface DeliveryRunSummary {
  readonly at: string;
  /** Notifications dispatched this pass. */
  readonly attempted: number;
  /** Notifications fully delivered. */
  readonly delivered: number;
  /** Notifications that failed. */
  readonly failed: number;
  /** Notifications dead-lettered. */
  readonly dead: number;
  /** Notifications scheduled for a retry. */
  readonly retried: number;
  /** Notifications skipped (not stored / not deliverable). */
  readonly skipped: number;
  /** Notifications cancelled this pass. */
  readonly cancelled: number;
  /** Notifications deduplicated this pass. */
  readonly deduplicated: number;
  /** Every per-recipient receipt, in dispatch order. */
  readonly receipts: readonly DeliveryReceipt[];
}

/** The outcome of {@link NotificationDeliveryEngine.send}. */
export interface NotificationSendResult {
  readonly engine: NotificationDeliveryEngine;
  readonly notification: Notification;
  readonly deliveries: readonly NotificationDelivery[];
  /** True when the send was deduplicated against an existing notification. */
  readonly deduplicated: boolean;
  readonly summary?: DeliveryRunSummary;
}

/** The outcome of {@link NotificationDeliveryEngine.sendBatch}. */
export interface NotificationBatchResult {
  readonly engine: NotificationDeliveryEngine;
  readonly notifications: readonly Notification[];
  readonly batch: NotificationBatch;
  readonly summary?: DeliveryRunSummary;
}

/** Input accepted by {@link NotificationDeliveryEngine.send}. */
export interface NotificationSendInput {
  /** Explicit id; derived deterministically when omitted. */
  readonly id?: string;
  readonly userId?: string;
  readonly title: string;
  readonly body: string;
  readonly category?: NotificationCategory;
  readonly priority?: NotificationPriority;
  readonly recipients: readonly NotificationRecipient[];
  readonly schedule?: NotificationSchedule;
  readonly scheduledAt?: string;
  /** Render a registered template over `templateVariables` when provided. */
  readonly templateId?: string;
  readonly templateVariables?: Readonly<Record<string, unknown>>;
  readonly dedupeKey?: string;
  readonly tags?: readonly string[];
  readonly source?: string;
  readonly expiresAt?: string;
  readonly correlationId?: string;
  readonly attachments?: readonly NotificationAttachment[];
  readonly format?: NotificationFormat;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** Input accepted by {@link NotificationDeliveryEngine.schedule}. */
export type NotificationScheduleInput = Omit<NotificationSendInput, "schedule"> & {
  readonly schedule: NotificationSchedule;
};

/** Options accepted by the {@link NotificationDeliveryEngine} constructor. */
export interface NotificationDeliveryEngineOptions {
  /** The channel registry (dependency injection). */
  readonly channels?: NotificationChannelRegistry;
  /** The template registry (dependency injection). */
  readonly templates?: TemplateRegistry;
  /** Global configuration (dependency injection). */
  readonly config?: NotificationConfiguration;
  /** The queue set (dependency injection). */
  readonly queues?: NotificationQueueSet;
  /** The retry manager (dependency injection). */
  readonly retry?: RetryManager;
  /** The dead letter store (dependency injection). */
  readonly deadLetters?: DeadLetterStore;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
  /** Injected millisecond clock for durations; defaults to `Date.now`. */
  readonly clockMs?: () => number;
}

/** A rate-window send record. */
interface RateSend {
  readonly channel: NotificationChannelType;
  readonly at: string;
}

/** Internal per-recipient dispatch outcome. */
interface RecipientDispatch {
  readonly recipient: NotificationRecipient;
  readonly channel: NotificationChannelType;
  readonly ok: boolean;
  readonly attempts: number;
  readonly message?: string;
  readonly error?: NotificationError;
  /** Wall-clock duration of the send in milliseconds. */
  readonly durationMs: number;
}

/**
 * The delivery engine — the composition root of the notification pipeline.
 *
 * State is successor-replaced on every operation; the sub-collections
 * (notifications, deliveries, attempts, histories, failures, batches,
 * queues, retry, dead letters) are all immutable values.
 */
export class NotificationDeliveryEngine {
  private _notifications: readonly Notification[];
  private _deliveries: readonly NotificationDelivery[];
  private _attempts: readonly NotificationDeliveryAttempt[];
  private _histories: readonly NotificationHistory[];
  private _failures: readonly NotificationFailure[];
  private _batches: readonly NotificationBatch[];
  private _queues: NotificationQueueSet;
  private _retry: RetryManager;
  private _deadLetters: DeadLetterStore;
  private _rateSends: readonly RateSend[];

  /** The channel registry (successor-replaced). */
  private _channels: NotificationChannelRegistry;
  /** The template registry (successor-replaced). */
  private _templates: TemplateRegistry;
  /** Global configuration. */
  readonly config: NotificationConfiguration;

  private readonly now: () => string;
  private readonly clockMs: () => number;

  constructor(options: NotificationDeliveryEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.clockMs = options.clockMs ?? (() => Date.now());
    this.config = options.config ?? createDefaultConfiguration();
    this._channels =
      options.channels ??
      createNotificationChannelRegistry({
        channels: createDefaultNotificationChannels(),
      });
    this._templates = options.templates ?? createTemplateRegistry();
    this._queues = options.queues ?? createNotificationQueueSet({ createdAt: this.now() });
    this._retry = options.retry ?? createRetryManager({ policy: this.config.retryPolicy });
    this._deadLetters = options.deadLetters ?? createDeadLetterStore();
    this._notifications = [];
    this._deliveries = [];
    this._attempts = [];
    this._histories = [];
    this._failures = [];
    this._batches = [];
    this._rateSends = [];
  }

  /** The current channel registry. */
  get channels(): NotificationChannelRegistry {
    return this._channels;
  }

  /** The current template registry. */
  get templates(): TemplateRegistry {
    return this._templates;
  }

  /** The current queue set. */
  get queues(): NotificationQueueSet {
    return this._queues;
  }

  /** The current retry manager. */
  get retry(): RetryManager {
    return this._retry;
  }

  /** The current dead letter store. */
  get deadLetters(): DeadLetterStore {
    return this._deadLetters;
  }

  // ─────────────────────────────────────────────────────────────
  // Reads.
  // ─────────────────────────────────────────────────────────────

  /** Detached clones of every notification, in creation order. */
  list(): Notification[] {
    return this._notifications.map(cloneNotification);
  }

  /** Detached clone of the notification, or `undefined`. */
  find(notificationId: string): Notification | undefined {
    const notification = this._notifications.find(
      (candidate) => candidate.id === notificationId,
    );
    return notification === undefined ? undefined : cloneNotification(notification);
  }

  /** Whether a notification is stored. */
  has(notificationId: string): boolean {
    return this._notifications.some((candidate) => candidate.id === notificationId);
  }

  /** Number of stored notifications. */
  count(): number {
    return this._notifications.length;
  }

  /** The notification sharing `dedupeKey` that is not yet settled, or undefined. */
  findByDedupeKey(dedupeKey: string): Notification | undefined {
    const notification = this._notifications.find(
      (candidate) =>
        candidate.metadata.dedupeKey === dedupeKey && !isNotificationSettledLocal(candidate),
    );
    return notification === undefined ? undefined : cloneNotification(notification);
  }

  /** Detached copies of every delivery for `notificationId`, in order. */
  deliveries(notificationId: string): NotificationDelivery[] {
    return this._deliveries
      .filter((delivery) => delivery.notificationId === notificationId)
      .map((delivery) => touchNotificationDelivery(delivery, {}));
  }

  /** Detached copies of every attempt for `deliveryId`, in order. */
  attempts(deliveryId: string): NotificationDeliveryAttempt[] {
    return this._attempts
      .filter((attempt) => attempt.deliveryId === deliveryId)
      .map((attempt) => ({
        ...attempt,
        ...(attempt.error !== undefined ? { error: { ...attempt.error } } : {}),
      }));
  }

  /** The history of `notificationId`, or `undefined`. */
  history(notificationId: string): NotificationHistory | undefined {
    const history = this._histories.find(
      (candidate) => candidate.notificationId === notificationId,
    );
    return history === undefined
      ? undefined
      : createNotificationHistory(notificationId, history.entries);
  }

  /** Detached copies of every failure, oldest first. */
  failures(): NotificationFailure[] {
    return this._failures.map((failure) => ({
      ...failure,
      error: { ...failure.error },
    }));
  }

  /** Detached copies of every batch, in creation order. */
  batches(): NotificationBatch[] {
    return this._batches.map((batch) => ({
      ...batch,
      notificationIds: [...batch.notificationIds],
    }));
  }

  /** The receipts (delivery records) of `notificationId`, as settled. */
  receipts(notificationId: string): readonly DeliveryReceipt[] {
    return this.deliveries(notificationId).map((delivery) => ({
      notificationId: delivery.notificationId,
      recipientId: delivery.recipientId,
      channel: delivery.channel,
      ok: delivery.status === "sent" || delivery.status === "delivered",
      attempts: delivery.attempts,
      ...(delivery.message !== undefined ? { message: delivery.message } : {}),
      ...(delivery.error !== undefined ? { error: delivery.error } : {}),
    }));
  }

  /** Aggregate statistics over the stored notifications. */
  statistics(): NotificationStatistics {
    return notificationStatistics(this._notifications);
  }

  /** Compact summary over the stored notifications. */
  summary(): NotificationSummary {
    return notificationSummary(this._notifications);
  }

  /** Rolled-up metrics over notifications/deliveries/attempts/failures. */
  metrics(): NotificationMetrics {
    return notificationMetrics({
      notifications: this._notifications,
      deliveries: this._deliveries,
      attempts: this._attempts,
      failures: this._failures,
    });
  }

  /** Queue statistics at `now`. */
  queueStatistics(now: string): NotificationQueueSetStatistics {
    return this._queues.statistics(now);
  }

  /** Queue summary. */
  queueSummary(): NotificationQueueSetSummary {
    return this._queues.summary();
  }

  /** A point-in-time snapshot at `now`. */
  snapshot(now: string): NotificationSnapshot {
    return createNotificationSnapshot({
      at: now,
      notifications: this._notifications,
      deliveries: this._deliveries,
    });
  }

  /** A delivery report at `now` (statistics + metrics + health). */
  report(now: string): NotificationReport {
    return createNotificationReport({
      at: now,
      statistics: this.statistics(),
      summary: this.summary(),
      metrics: this.metrics(),
      health: this.health(now),
    });
  }

  /** Health derived deterministically from the pipeline state. */
  health(now: string): NotificationHealth {
    const metrics = this.metrics();
    const failed = metrics.failed + metrics.dead;
    const total = metrics.sent + metrics.delivered + failed + metrics.cancelled;
    const failureRate = total > 0 ? failed / total : 0;
    const queueDepth = this._queues.count();
    if (failureRate >= 0.5 || queueDepth >= this.config.limits.maxRecipients * 10) {
      return createNotificationHealth({
        status: "unhealthy",
        score: Math.max(0, 1 - failureRate),
        lastCheckedAt: now,
        message: "Notification delivery is failing at a high rate",
      });
    }
    if (failureRate >= 0.1) {
      return createNotificationHealth({
        status: "degraded",
        score: 1 - failureRate,
        lastCheckedAt: now,
        message: "Notification delivery is degraded",
      });
    }
    return createNotificationHealth({ status: "healthy", score: 1, lastCheckedAt: now });
  }

  // ─────────────────────────────────────────────────────────────
  // Sending.
  // ─────────────────────────────────────────────────────────────

  /**
   * Create, enqueue and (when due) dispatch a notification. Returns the
   * successor engine plus the created notification and its deliveries.
   * When `dedupeKey` matches a non-settled notification, the send is
   * deduplicated (no new notification is created).
   */
  async send(input: NotificationSendInput, now?: string): Promise<NotificationSendResult> {
    const at = now ?? this.now();
    const validation = this.validateInput(input);
    if (validation.error !== undefined) {
      throw new Error(validation.error);
    }
    if (this.config.dedupeEnabled && input.dedupeKey !== undefined) {
      const existing = this.findByDedupeKey(input.dedupeKey);
      if (existing !== undefined) {
        return {
          engine: this,
          notification: existing,
          deliveries: this.deliveries(existing.id),
          deduplicated: true,
        };
      }
    }

    const notification = this.buildNotification(input, at);
    this.store(notification, at);
    let summary: DeliveryRunSummary | undefined;

    const future = this.isScheduledInFuture(notification, at);
    if (future) {
      const { set } = this._queues.enqueue({
        notificationId: notification.id,
        priority: notification.priority,
        enqueuedAt: at,
        dequeueAt: notification.scheduledAt,
      });
      this._queues = set;
      this.recordHistory(notification.id, {
        at,
        kind: "queued",
        detail: `scheduled for ${notification.scheduledAt ?? ""}`,
      });
    } else {
      const { set } = this._queues.enqueue({
        notificationId: notification.id,
        priority: notification.priority,
        enqueuedAt: at,
      });
      this._queues = set;
      this.recordHistory(notification.id, { at, kind: "queued" });
      const dispatched = await this.dispatchDue(at, undefined, [notification.id]);
      summary = dispatched.summary;
    }

    return {
      engine: this,
      notification: this.find(notification.id) ?? notification,
      deliveries: this.deliveries(notification.id),
      deduplicated: false,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  /**
   * Create and enqueue a notification for a future schedule (scheduled
   * delivery). No dispatch happens — `dispatchDue` delivers when due.
   */
  schedule(input: NotificationScheduleInput, now?: string): NotificationSendResult {
    const at = now ?? this.now();
    const validation = this.validateInput(input);
    if (validation.error !== undefined) {
      throw new Error(validation.error);
    }
    const notification = this.buildNotification(input, at);
    this.store(notification, at);
    const { set } = this._queues.enqueue({
      notificationId: notification.id,
      priority: notification.priority,
      enqueuedAt: at,
      dequeueAt: notification.scheduledAt ?? input.schedule.at,
    });
    this._queues = set;
    this.recordHistory(notification.id, {
      at,
      kind: "queued",
      detail: `scheduled for ${notification.scheduledAt ?? input.schedule.at ?? ""}`,
    });
    return {
      engine: this,
      notification: this.find(notification.id) ?? notification,
      deliveries: [],
      deduplicated: false,
    };
  }

  /**
   * Send many notifications in parallel (batch delivery). Each input is
   * validated/deduped/created independently; failures are isolated per
   * input. Returns the successor engine, the created notifications and a
   * batch record.
   */
  async sendBatch(
    inputs: readonly NotificationSendInput[],
    now?: string,
  ): Promise<NotificationBatchResult> {
    const at = now ?? this.now();
    const results = await Promise.all(inputs.map((input) => this.send(input, at)));
    const notifications = results.map((result) => result.notification);
    const summary = results.find((result) => result.summary !== undefined)?.summary;
    const batch = createNotificationBatch({
      notificationIds: notifications.map((notification) => notification.id),
      createdAt: at,
      status: "completed",
    });
    this._batches = [...this._batches, batch];
    return { engine: this, notifications, batch, ...(summary !== undefined ? { summary } : {}) };
  }

  /**
   * Dispatch everything due at `now` (promote delayed/retry items, then
   * deliver). When `limit` is provided, at most that many notifications are
   * dispatched. `only` restricts the dispatch to specific notification ids
   * (used by `send` to deliver a single notification immediately).
   */
  async dispatchDue(
    now: string,
    limit?: number,
    only?: readonly string[],
  ): Promise<{ engine: NotificationDeliveryEngine; summary: DeliveryRunSummary }> {
    const promoted = this._queues.promoteDue(now);
    this._queues = promoted.set;
    const { set, items } = this._queues.dequeue(
      limit ?? this._queues.pending.count(),
      now,
    );
    this._queues = set;

    const targets =
      only !== undefined
        ? items.filter((item) => only.includes(item.notificationId))
        : items;

    let attempted = 0;
    let delivered = 0;
    let failed = 0;
    let dead = 0;
    let retried = 0;
    let skipped = 0;
    let cancelled = 0;
    const receipts: DeliveryReceipt[] = [];

    for (const item of targets) {
      const notification = this.find(item.notificationId);
      if (notification === undefined) {
        skipped += 1;
        continue;
      }
      if (!isNotificationDeliverable(notification, now)) {
        this.settleExpired(notification, now);
        cancelled += 1;
        continue;
      }

      const outcome = await this.deliverNotification(notification, now);
      receipts.push(...outcome.receipts);
      attempted += 1;
      const status = this.find(notification.id)?.status ?? "failed";
      if (status === "delivered" || status === "sent") {
        delivered += 1;
      } else if (status === "dead") {
        dead += 1;
      } else if (status === "queued" || status === "pending") {
        retried += 1;
      } else {
        failed += 1;
      }
    }

    const summary: DeliveryRunSummary = Object.freeze({
      at: now,
      attempted,
      delivered,
      failed,
      dead,
      retried,
      skipped,
      cancelled,
      deduplicated: 0,
      receipts: Object.freeze(receipts),
    });
    return { engine: this, summary };
  }

  /** Alias of {@link dispatchDue} — the application dispatch entry point. */
  dispatch(now?: string, limit?: number): Promise<{
    engine: NotificationDeliveryEngine;
    summary: DeliveryRunSummary;
  }> {
    return this.dispatchDue(now ?? this.now(), limit);
  }

  // ─────────────────────────────────────────────────────────────
  // Cancellation, replacement.
  // ─────────────────────────────────────────────────────────────

  /**
   * Manually replay a dead-lettered notification: clear its retry state,
   * reset the notification to `queued` and re-enqueue it for a fresh
   * dispatch. No-op when the notification is not dead-lettered.
   */
  replay(
    notificationId: string,
    now?: string,
  ): { engine: NotificationDeliveryEngine; notification?: Notification; replayed: boolean } {
    const at = now ?? this.now();
    const notification = this.find(notificationId);
    if (notification === undefined || !this.deadLetters.hasNotification(notificationId)) {
      return { engine: this, replayed: false };
    }
    this._deadLetters = this._deadLetters.removeNotification(notificationId);
    this._retry = this._retry.replay(notificationId).manager;
    const updated = touchNotification(notification, {
      status: "queued",
      error: null,
      attempts: 0,
    });
    this.replaceNotification(updated);
    const { set } = this._queues.enqueue({
      notificationId,
      priority: updated.priority,
      enqueuedAt: at,
    });
    this._queues = set;
    this.recordHistory(notificationId, {
      at,
      kind: "queued",
      detail: "replayed from dead letter",
    });
    return { engine: this, notification: this.find(notificationId) ?? updated, replayed: true };
  }

  /**
   * Prune settled notifications (delivered/failed/cancelled/dead) whose
   * settlement is older than `retentionMs` at `now`, and clean up expired
   * dead-letter records. Returns the successor engine, the removed ids and
   * the number of expired dead-letter records removed.
   */
  prune(now: string, retentionMs: number): {
    engine: NotificationDeliveryEngine;
    removed: readonly string[];
    deadLettersRemoved: number;
  } {
    const cutoff = Date.parse(now) - retentionMs;
    const removedIds = this._notifications
      .filter((notification) => isNotificationSettledLocal(notification))
      .filter((notification) => {
        const reference = notification.deliveredAt ?? notification.createdAt;
        return Date.parse(reference) < cutoff;
      })
      .map((notification) => notification.id);
    const removed = new Set(removedIds);
    if (removed.size > 0) {
      this._notifications = this._notifications.filter(
        (notification) => !removed.has(notification.id),
      );
      this._deliveries = this._deliveries.filter(
        (delivery) => !removed.has(delivery.notificationId),
      );
      this._attempts = this._attempts.filter((attempt) =>
        this._deliveries.some((candidate) => candidate.id === attempt.deliveryId),
      );
      this._histories = this._histories.filter(
        (history) => !removed.has(history.notificationId),
      );
      this._failures = this._failures.filter(
        (failure) => !removed.has(failure.notificationId),
      );
      this._deadLetters = this._deadLetters.removeNotificationEach(removedIds);
    }
    const { store, entries } = this._deadLetters.cleanup(now, retentionMs);
    this._deadLetters = store;
    return {
      engine: this,
      removed: removedIds,
      deadLettersRemoved: entries.length,
    };
  }

  /** Cancel a queued notification: remove it from every queue, mark cancelled. */
  cancel(
    notificationId: string,
    now?: string,
  ): { engine: NotificationDeliveryEngine; notification: Notification } {
    const at = now ?? this.now();
    const notification = this.find(notificationId);
    if (notification === undefined) {
      throw new Error(`Notification not found: ${notificationId}`);
    }
    if (isNotificationSettledLocal(notification)) {
      return { engine: this, notification };
    }
    this._queues = this._queues.cancel(notificationId);
    this._retry = this._retry.clearPending(notificationId);
    const updated = touchNotification(notification, {
      status: "cancelled",
      error: { code: "cancelled", message: "Notification cancelled" },
    });
    this.replaceNotification(updated);
    this.recordHistory(notificationId, { at, kind: "cancelled" });
    return { engine: this, notification: this.find(notificationId) ?? updated };
  }

  /**
   * Replace the content of a queued notification (same id, same recipients).
   * Settled notifications are returned unchanged.
   */
  replace(
    notificationId: string,
    input: NotificationSendInput,
    now?: string,
  ): { engine: NotificationDeliveryEngine; notification: Notification } {
    const at = now ?? this.now();
    const existing = this.find(notificationId);
    if (existing === undefined) {
      throw new Error(`Notification not found: ${notificationId}`);
    }
    if (isNotificationSettledLocal(existing)) {
      return { engine: this, notification: existing };
    }
    const built = this.buildNotification({ ...input, id: notificationId }, at);
    const updated = touchNotification(built, {
      recipients: existing.recipients,
      status: existing.status,
      createdAt: existing.createdAt,
    });
    this.replaceNotification(updated);
    const item = this._queues.findByNotification(notificationId);
    if (item !== undefined) {
      this._queues = this._queues.replace({ ...item, priority: updated.priority });
    }
    this.recordHistory(notificationId, { at, kind: "replaced" });
    return { engine: this, notification: this.find(notificationId) ?? updated };
  }

  // ─────────────────────────────────────────────────────────────
  // Wiring helpers (successor sub-components).
  // ─────────────────────────────────────────────────────────────

  /** Replace the channel registry (state preserved). */
  withChannels(channels: NotificationChannelRegistry): NotificationDeliveryEngine {
    this._channels = channels;
    return this;
  }

  /** Replace the template registry (state preserved). */
  withTemplates(templates: TemplateRegistry): NotificationDeliveryEngine {
    this._templates = templates;
    return this;
  }

  /** Replace the retry manager (state preserved; restart recovery). */
  withRetry(retry: RetryManager): NotificationDeliveryEngine {
    this._retry = retry;
    return this;
  }

  /** Replace the dead letter store (state preserved; restart recovery). */
  withDeadLetters(deadLetters: DeadLetterStore): NotificationDeliveryEngine {
    this._deadLetters = deadLetters;
    return this;
  }

  /** Replace the queue set (state preserved; restart recovery). */
  withQueues(queues: NotificationQueueSet): NotificationDeliveryEngine {
    this._queues = queues;
    return this;
  }

  /** Restore persisted state wholesale (restart recovery). */
  restoreState(input: {
    readonly notifications: readonly Notification[];
    readonly deliveries: readonly NotificationDelivery[];
    readonly attempts: readonly NotificationDeliveryAttempt[];
    readonly histories: readonly NotificationHistory[];
    readonly failures: readonly NotificationFailure[];
    readonly batches: readonly NotificationBatch[];
  }): NotificationDeliveryEngine {
    this._notifications = input.notifications.map(cloneNotification);
    this._deliveries = input.deliveries.map((delivery) => touchNotificationDelivery(delivery, {}));
    this._attempts = input.attempts.map((attempt) => ({ ...attempt }));
    this._histories = input.histories.map((history) => createNotificationHistory(history.notificationId, history.entries));
    this._failures = input.failures.map((failure) => ({ ...failure, error: { ...failure.error } }));
    this._batches = input.batches.map((batch) => ({ ...batch, notificationIds: [...batch.notificationIds] }));
    return this;
  }

  // ─────────────────────────────────────────────────────────────
  // Internals.
  // ─────────────────────────────────────────────────────────────

  /** Validate a send input against the configured limits. */
  private validateInput(input: NotificationSendInput): { error?: string } {
    if (input.recipients.length === 0) {
      return { error: "A notification must have at least one recipient" };
    }
    if (input.recipients.length > this.config.limits.maxRecipients) {
      return {
        error: `A notification may have at most ${this.config.limits.maxRecipients} recipients`,
      };
    }
    if (input.body.length > this.config.limits.maxBodyLength) {
      return {
        error: `Notification body exceeds the maximum length of ${this.config.limits.maxBodyLength}`,
      };
    }
    if (input.title.length > this.config.limits.maxSubjectLength) {
      return {
        error: `Notification title exceeds the maximum length of ${this.config.limits.maxSubjectLength}`,
      };
    }
    const attachments = input.attachments ?? [];
    if (attachments.length > this.config.limits.maxAttachments) {
      return {
        error: `A notification may carry at most ${this.config.limits.maxAttachments} attachments`,
      };
    }
    return {};
  }

  /** Build a notification from a send input (renders templates when given). */
  private buildNotification(input: NotificationSendInput, at: string): Notification {
    let title = input.title;
    let body = input.body;
    if (input.templateId !== undefined) {
      const template = this._templates.get(input.templateId);
      if (template !== undefined) {
        const rendered = renderTemplate(template, input.templateVariables ?? {}, input.format);
        title = rendered.subject ?? title;
        body = rendered.content;
      }
    }
    return createNotification({
      ...(input.id !== undefined ? { id: input.id } : {}),
      userId: input.userId,
      title,
      body,
      category: input.category ?? this.config.defaultCategory,
      priority: input.priority ?? this.config.defaultPriority,
      recipients: input.recipients,
      schedule: input.schedule,
      scheduledAt: input.scheduledAt ?? input.schedule?.at,
      status: "queued",
      createdAt: at,
      templateId: input.templateId,
      payload:
        input.payload !== undefined
          ? {
              title,
              body,
              ...(input.payload.data !== undefined
                ? { data: input.payload.data as Readonly<Record<string, unknown>> }
                : {}),
            }
          : undefined,
      attachments: input.attachments,
      metadata: {
        tags: input.tags,
        source: input.source,
        expiresAt: input.expiresAt,
        dedupeKey: input.dedupeKey,
        correlationId: input.correlationId,
      },
    });
  }

  /** Whether a notification is scheduled strictly in the future. */
  private isScheduledInFuture(notification: Notification, at: string): boolean {
    return (
      notification.scheduledAt !== undefined &&
      Date.parse(notification.scheduledAt) > Date.parse(at)
    );
  }

  /** Store a fresh notification (deep-cloned) and append a history. */
  private store(notification: Notification, at: string): void {
    this._notifications = [...this._notifications, cloneNotification(notification)];
    this._histories = [
      ...this._histories,
      createNotificationHistory(notification.id, [
        { at, kind: "created", detail: notification.title },
      ]),
    ];
  }

  /** Replace a notification in the collection (position preserved). */
  private replaceNotification(notification: Notification): void {
    this._notifications = this._notifications.map((candidate) =>
      candidate.id === notification.id ? cloneNotification(notification) : candidate,
    );
  }

  /** Append a history entry for `notificationId`. */
  private recordHistory(notificationId: string, entry: NotificationHistoryEntry): void {
    this._histories = this._histories.map((history) =>
      history.notificationId === notificationId
        ? createNotificationHistory(notificationId, [...history.entries, entry])
        : history,
    );
  }

  /** Settle an expired/undeliverable notification as cancelled. */
  private settleExpired(notification: Notification, now: string): void {
    const updated = touchNotification(notification, {
      status: "cancelled",
      error: { code: "expired", message: "Notification expired before delivery" },
    });
    this._queues = this._queues.cancel(notification.id);
    this.replaceNotification(updated);
    this.recordHistory(notification.id, {
      at: now,
      kind: "cancelled",
      detail: "expired",
    });
  }

  /**
   * Deliver a notification to every recipient (in parallel), honoring
   * fallback channels, rate limits and the retry policy. Returns the
   * per-recipient receipts.
   */
  private async deliverNotification(
    notification: Notification,
    now: string,
  ): Promise<{ receipts: readonly DeliveryReceipt[] }> {
    const inFlight = touchNotification(notification, {
      status: "sending",
      sentAt: notification.sentAt ?? now,
      attempts: notification.attempts + 1,
    });
    this.replaceNotification(inFlight);
    this.recordHistory(notification.id, { at: now, kind: "sending" });

    const targets = notification.recipients.filter(
      (recipient) => !this.isRecipientDelivered(notification.id, recipient.id),
    );

    const dispatches = await Promise.all(
      targets.map((recipient) => this.dispatchToRecipient(notification, recipient, now)),
    );

    const receipts: DeliveryReceipt[] = dispatches.map((dispatch) => ({
      notificationId: notification.id,
      recipientId: dispatch.recipient.id,
      channel: dispatch.channel,
      ok: dispatch.ok,
      attempts: dispatch.attempts,
      ...(dispatch.message !== undefined ? { message: dispatch.message } : {}),
      ...(dispatch.error !== undefined ? { error: dispatch.error } : {}),
    }));

    for (const dispatch of dispatches) {
      this.recordDelivery(notification.id, dispatch, now);
    }

    const settled = this.deliveries(notification.id);
    const deliveredCount = settled.filter(
      (delivery) => delivery.status === "sent" || delivery.status === "delivered",
    ).length;
    const failedCount = settled.filter((delivery) => delivery.status === "failed").length;
    const current = this.find(notification.id);
    if (current === undefined) return { receipts };

    if (deliveredCount > 0 && failedCount === 0) {
      const updated = touchNotification(current, {
        status: "delivered",
        deliveredAt: now,
        error: null,
      });
      this.replaceNotification(updated);
      this._retry = this._retry.reset(notification.id);
      this.recordHistory(notification.id, { at: now, kind: "delivered" });
      return { receipts };
    }

    if (failedCount === 0) {
      // Nothing new was attempted (every recipient already delivered).
      const updated = touchNotification(current, { status: "delivered", deliveredAt: now });
      this.replaceNotification(updated);
      this._retry = this._retry.reset(notification.id);
      this.recordHistory(notification.id, { at: now, kind: "delivered" });
      return { receipts };
    }

    // Some recipients failed. Evaluate the retry policy.
    const failedDelivery = settled.find((delivery) => delivery.status === "failed");
    const error =
      failedDelivery?.error ?? { code: "delivery_failed", message: "Delivery failed" };
    const attemptsMade = current.attempts;
    const recorded = this._retry.recordFailure({
      notificationId: notification.id,
      attempt: attemptsMade,
      at: now,
      channel: failedDelivery?.channel,
      error,
      deliveryId: failedDelivery?.id,
    });
    this._retry = recorded.manager;
    this._failures = [...this._failures, recorded.failure];

    // Permanent failures settle immediately as "failed" — never retried and
    // never dead-lettered (a replay cannot fix a non-retryable error).
    if (error.retryable === false) {
      const updated = touchNotification(current, { status: "failed", error });
      this.replaceNotification(updated);
      this.recordHistory(notification.id, { at: now, kind: "failed", error });
      return { receipts };
    }

    if (recorded.decision.retryable && !recorded.dead) {
      const nextAt = recorded.decision.nextRetryAt ?? now;
      const { set, item } = this._queues.retryItem({
        notificationId: notification.id,
        priority: notification.priority,
        at: now,
        dequeueAt: nextAt,
        attempt: attemptsMade,
      });
      if (item !== undefined) {
        this._queues = set;
        const updated = touchNotification(current, { status: "queued", error });
        this.replaceNotification(updated);
        this.recordHistory(notification.id, {
          at: now,
          kind: "retried",
          detail: `retry at ${nextAt}`,
          error,
        });
      } else {
        const updated = touchNotification(current, { status: "failed", error });
        this.replaceNotification(updated);
        this.recordHistory(notification.id, { at: now, kind: "failed", error });
      }
      return { receipts };
    }

    // Dead letter.
    this._deadLetters = this._deadLetters.add(recorded.failure).store;
    const { set } = this._queues.deadLetterItem({
      notificationId: notification.id,
      priority: notification.priority,
      at: now,
      attempt: attemptsMade,
    });
    this._queues = set;
    const updated = touchNotification(current, {
      status: "dead",
      error: recorded.failure.error,
    });
    this.replaceNotification(updated);
    this.recordHistory(notification.id, {
      at: now,
      kind: "dead",
      detail: error.code,
      error,
    });
    return { receipts };
  }

  /** Whether a recipient already has a successful delivery. */
  private isRecipientDelivered(notificationId: string, recipientId: string): boolean {
    return this._deliveries.some(
      (delivery) =>
        delivery.notificationId === notificationId &&
        delivery.recipientId === recipientId &&
        (delivery.status === "sent" || delivery.status === "delivered"),
    );
  }

  /**
   * Dispatch one recipient: try the primary channel, then fallbacks in
   * order; honor rate limits. Never throws.
   */
  private async dispatchToRecipient(
    notification: Notification,
    recipient: NotificationRecipient,
    now: string,
  ): Promise<RecipientDispatch> {
    const chains = [recipient.channel, ...(recipient.fallbackChannels ?? [])];
    for (const channelType of chains) {
      if (!this.rateAcquire(channelType, now)) {
        return this.failDispatch(recipient, channelType, {
          code: "rate_limited",
          message: `Rate limit exceeded for channel "${channelType}"`,
          retryable: true,
        });
      }
      const channel = this._channels.get(channelType);
      if (channel === undefined) {
        return this.failDispatch(recipient, channelType, {
          code: "channel_not_registered",
          message: `No channel registered for "${channelType}"`,
          retryable: false,
        });
      }
      const sendInput = this.buildChannelSendInput(notification, recipient, channelType);
      const started = this.clockMs();
      let output: NotificationChannelSendOutput;
      try {
        output = await channel.send(sendInput, now);
      } catch (caught) {
        // Failure isolation: a throwing channel becomes a structured,
        // retryable failure — never an uncaught rejection.
        output = {
          ok: false,
          error: {
            code: "channel_error",
            message: caught instanceof Error ? caught.message : String(caught),
            retryable: true,
          },
        };
      }
      const durationMs = Math.max(0, this.clockMs() - started);
      if (output.ok) {
        return {
          recipient,
          channel: channelType,
          ok: true,
          attempts: 1,
          ...(output.message !== undefined ? { message: output.message } : {}),
          durationMs,
        };
      }
      const error =
        output.error ?? { code: "send_failed", message: "Channel send failed" };
      // Permanent failures never fall through to the next channel.
      if (!channel.retryHint({ ok: false, error })) {
        return this.failDispatch(recipient, channelType, error);
      }
      // Transient failure → try the next fallback channel.
    }
    return this.failDispatch(recipient, chains[0] ?? recipient.channel, {
      code: "all_channels_failed",
      message: "All channels failed for this recipient",
      retryable: true,
    });
  }

  /** Build a structured failed dispatch. */
  private failDispatch(
    recipient: NotificationRecipient,
    channel: NotificationChannelType,
    error: NotificationError,
  ): RecipientDispatch {
    return { recipient, channel, ok: false, attempts: 1, error, durationMs: 0 };
  }

  /** Build the channel send input for a recipient (subject per channel). */
  private buildChannelSendInput(
    notification: Notification,
    recipient: NotificationRecipient,
    channelType: NotificationChannelType,
  ): NotificationChannelSendInput {
    return {
      recipient: { ...recipient, channel: channelType },
      subject: recipient.label ?? notification.title,
      content: notification.body,
      format: "plain",
      attachments: notification.attachments,
      metadata: {
        notificationId: notification.id,
        category: notification.category,
      },
    };
  }

  /** Acquire a rate-limit slot for a channel; records the send when allowed. */
  private rateAcquire(channel: NotificationChannelType, now: string): boolean {
    const rateLimit = this.config.rateLimit;
    const cutoff = Date.parse(now) - rateLimit.windowMs;
    const within = this._rateSends.filter(
      (send) => send.channel === channel && Date.parse(send.at) > cutoff,
    );
    if (within.length >= rateLimit.maxSends) {
      return false;
    }
    this._rateSends = [...this._rateSends, Object.freeze({ channel, at: now })];
    return true;
  }

  /** Record a delivery (upsert) plus a delivery attempt. */
  private recordDelivery(
    notificationId: string,
    dispatch: RecipientDispatch,
    now: string,
  ): void {
    const deliveryId = deliveryIdFor(notificationId, dispatch.recipient.id);
    const existing = this._deliveries.find((delivery) => delivery.id === deliveryId);
    const attemptNumber = (existing?.attempts ?? 0) + 1;
    const attempt = createNotificationDeliveryAttempt({
      deliveryId,
      attempt: attemptNumber,
      status: dispatch.ok ? "sent" : "failed",
      startedAt: now,
      finishedAt: now,
      ...(dispatch.error !== undefined ? { error: dispatch.error } : {}),
      durationMs: dispatch.durationMs,
    });
    const deliveries = existing
      ? this._deliveries.map((delivery) =>
          delivery.id === deliveryId
            ? touchNotificationDelivery(delivery, {
                status: dispatch.ok ? "sent" : "failed",
                attempts: attemptNumber,
                finishedAt: now,
                sentAt: dispatch.ok ? now : null,
                message: dispatch.ok ? dispatch.message ?? null : null,
                error: dispatch.error ?? null,
              })
            : delivery,
        )
      : [
          ...this._deliveries,
          createNotificationDelivery({
            id: deliveryId,
            notificationId,
            recipientId: dispatch.recipient.id,
            channel: dispatch.channel,
            status: dispatch.ok ? "sent" : "failed",
            attempts: attemptNumber,
            createdAt: now,
            startedAt: now,
            finishedAt: now,
            ...(dispatch.ok && dispatch.message !== undefined
              ? { sentAt: now, message: dispatch.message }
              : {}),
            ...(dispatch.error !== undefined ? { error: dispatch.error } : {}),
          }),
        ];
    this._deliveries = deliveries;
    this._attempts = [...this._attempts, attempt];
  }
}

/** Local settled predicate (mirrors the types module's shared helper). */
function isNotificationSettledLocal(notification: Notification): boolean {
  return (
    notification.status === "delivered" ||
    notification.status === "sent" ||
    notification.status === "failed" ||
    notification.status === "cancelled" ||
    notification.status === "dead"
  );
}

/** Build the default configuration for a fresh engine. */
function createDefaultConfiguration(): NotificationConfiguration {
  return {
    defaultPriority: "normal",
    defaultCategory: "system",
    defaultChannels: ["email", "inapp"],
    retryPolicy: { maxRetries: 0, backoffMs: 0 },
    limits: {
      maxRecipients: 100,
      maxAttachments: 10,
      maxBodyLength: 10_000,
      maxSubjectLength: 200,
    },
    rateLimit: { windowMs: 60_000, maxSends: 100 },
    digestEnabled: true,
    dedupeEnabled: true,
  };
}

/** Re-export for convenience. */
export type { NotificationDelivery, NotificationDeliveryAttempt, NotificationRecipient };
