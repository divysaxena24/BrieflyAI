/**
 * Notification & Delivery System — background jobs (Phase 6D STEP 10).
 *
 * The worker integration of the notification pipeline. A composition-root
 * engine that drives the delivery engine from background runs, reusing the
 * Phase 6B worker conventions where applicable (in-place successor
 * replacement, caller-supplied `now`, deterministic order):
 *
 * - `runDispatch(now)` — dispatch every due scheduled/retry notification
 *   (the worker "scheduled notifications" and "retry queue" jobs).
 * - `runReplay(now)` — replay dead-lettered notifications (dead-letter
 *   replay job).
 * - `runBatch(now, inputs)` — batch delivery (a job sending many
 *   notifications through the delivery engine's `sendBatch`).
 * - `runDigest(now, userIds?)` — digest-mode delivery: aggregate queued
 *   notifications whose user prefers digest mode into one digest
 *   notification per user (delivery channel preference respected).
 * - `runCleanup(now, retentionMs)` — notification cleanup (prune settled
 *   notifications and expired dead letters).
 * - `runAll(now)` — the background pipeline pass over every job above.
 * - `recover(now)` — restart recovery: dispatch everything already queued
 *   and replay dead letters, so a restarted process resumes where it left
 *   off.
 *
 * Every run is deterministic given `now`; the engine holds no wall clock.
 * All sub-engines (delivery, preferences, monitoring) are dependency
 * injected and replaced on mutation.
 */

import { NotificationDeliveryEngine, type DeliveryReceipt as NotificationDeliveryReceipt } from "./delivery";
import { NotificationPreferenceEngine } from "./preferences";
import {
  NotificationMonitoringBridge,
  createNotificationMonitoringBridge,
} from "./monitoring";
import type { NotificationSendInput } from "./delivery";
import {
  createNotificationRecipient,
  type Notification,
} from "./types";

/** Options accepted by the {@link NotificationBackgroundEngine} constructor. */
export interface NotificationBackgroundEngineOptions {
  /** The delivery engine (dependency injection); fresh by default. */
  readonly delivery?: NotificationDeliveryEngine;
  /** The preference engine (dependency injection); fresh by default. */
  readonly preferences?: NotificationPreferenceEngine;
  /** The monitoring bridge (dependency injection); fresh by default. */
  readonly monitoring?: NotificationMonitoringBridge;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
}

/** The outcome of one background pass. */
export interface NotificationBackgroundRunSummary {
  readonly at: string;
  readonly dispatched: number;
  readonly delivered: number;
  readonly failed: number;
  readonly replayed: number;
  readonly digestsSent: number;
  readonly cleaned: number;
  readonly deadLettersRemoved: number;
}

/** The outcome of a digest run. */
export interface DigestRunOutcome {
  readonly engine: NotificationBackgroundEngine;
  readonly digests: readonly Notification[];
  readonly aggregated: number;
  readonly cancelled: number;
}

/** The outcome of a replay run. */
export interface ReplayRunOutcome {
  readonly engine: NotificationBackgroundEngine;
  readonly replayed: readonly string[];
  readonly remaining: number;
}

/** The outcome of a cleanup run. */
export interface CleanupRunOutcome {
  readonly engine: NotificationBackgroundEngine;
  readonly removed: readonly string[];
  readonly deadLettersRemoved: number;
}

/**
 * The notification background engine. State fields are replaced on every
 * mutation (matching the WorkerEngine composition-root convention); the
 * sub-engines are exposed readonly.
 */
export class NotificationBackgroundEngine {
  private _delivery: NotificationDeliveryEngine;
  private _preferences: NotificationPreferenceEngine;
  private _monitoring: NotificationMonitoringBridge;

  private readonly now: () => string;

  constructor(options: NotificationBackgroundEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this._delivery = options.delivery ?? new NotificationDeliveryEngine();
    this._preferences = options.preferences ?? new NotificationPreferenceEngine();
    this._monitoring = options.monitoring ?? createNotificationMonitoringBridge();
  }

  /** The current delivery engine (readonly view). */
  get delivery(): NotificationDeliveryEngine {
    return this._delivery;
  }

  /** The current preference engine (readonly view). */
  get preferences(): NotificationPreferenceEngine {
    return this._preferences;
  }

  /** The current monitoring bridge (readonly view). */
  get monitoring(): NotificationMonitoringBridge {
    return this._monitoring;
  }

  // ── Dispatch jobs ─────────────────────────────────────────────

  /**
   * Dispatch every due scheduled/retry notification at `now` (the worker's
   * "scheduled notifications" + "retry queue" jobs). Returns the successor
   * engine and the delivery run summary.
   */
  async runDispatch(now?: string): Promise<{
    engine: NotificationBackgroundEngine;
    summary: NotificationDeliveryRunView;
  }> {
    const at = now ?? this.now();
    const { engine, summary } = await this._delivery.dispatchDue(at);
    this._delivery = engine;
    this.observeDispatchOutcomes(summary.receipts, at);
    this.observeQueueDepth(at);
    return {
      engine: this,
      summary: Object.freeze({
        at: summary.at,
        attempted: summary.attempted,
        delivered: summary.delivered,
        failed: summary.failed,
        dead: summary.dead,
        retried: summary.retried,
        cancelled: summary.cancelled,
        receipts: summary.receipts.length,
      }),
    };
  }

  // ── Dead-letter replay job ────────────────────────────────────

  /**
   * Replay every dead-lettered notification at `now` (the dead-letter
   * replay job). Returns the successor engine, the replayed ids and the
   * remaining dead-letter count.
   */
  async runReplay(now?: string): Promise<ReplayRunOutcome> {
    const at = now ?? this.now();
    const ids = this._delivery.deadLetters.list().map((entry) => entry.notificationId);
    const unique = [...new Set(ids)];
    const replayed: string[] = [];
    let engine = this._delivery;
    for (const notificationId of unique) {
      const { engine: next, replayed: didReplay } = engine.replay(notificationId, at);
      engine = next;
      if (didReplay) replayed.push(notificationId);
    }
    this._delivery = engine;
    const remaining = engine.deadLetters.count();
    this._monitoring = this._monitoring.log(
      "info",
      `Dead-letter replay: ${replayed.length} replayed, ${remaining} remaining`,
      at,
      { context: { replayed: replayed.length, remaining } },
    );
    return { engine: this, replayed, remaining };
  }

  // ── Batch delivery job ────────────────────────────────────────

  /**
   * Deliver a batch of notifications at `now` (the batch-delivery job).
   * Delegates to the delivery engine's `sendBatch`; failures are isolated
   * per input.
   */
  async runBatch(inputs: readonly NotificationSendInput[], now?: string): Promise<{
    engine: NotificationBackgroundEngine;
    sent: number;
    failed: number;
  }> {
    const at = now ?? this.now();
    const { engine, notifications } = await this._delivery.sendBatch(inputs, at);
    this._delivery = engine;
    // Count only the batch's own notifications (the engine may hold earlier
    // work). Terminal failures include dead-lettered notifications — a batch
    // input whose retry budget is exhausted settles as `dead`, not `failed`.
    const failed = notifications.filter(
      (notification) =>
        notification.status === "failed" || notification.status === "dead",
    ).length;
    const sent = notifications.length - failed;
    this.observeQueueDepth(at);
    return { engine: this, sent, failed };
  }

  // ── Digest-mode aggregation job ───────────────────────────────

  /**
   * Aggregate queued notifications of users in digest mode into one digest
   * notification per user at `now` (the digest-delivery job). Each original
   * notification is cancelled; a single digest notification per user is
   * sent through the delivery engine (respecting the user's preferred
   * channel). `userIds` restricts the pass when provided.
   */
  async runDigest(now?: string, userIds?: readonly string[]): Promise<DigestRunOutcome> {
    const at = now ?? this.now();
    const queued = this._delivery.list().filter(
      (notification) =>
        notification.status === "queued" || notification.status === "pending",
    );
    const targetUsers = new Set(userIds ?? queued.map((notification) => notification.userId ?? ""));
    const digests: Notification[] = [];
    let engine = this._delivery;

    const byUser = new Map<string, Notification[]>();
    for (const notification of queued) {
      const userId = notification.userId ?? "";
      if (!targetUsers.has(userId)) continue;
      const preference = this._preferences.getPreference(userId);
      const digestPreferred = preference?.digestMode === true;
      if (!digestPreferred) continue;
      const bucket = byUser.get(userId);
      if (bucket === undefined) {
        byUser.set(userId, [notification]);
      } else {
        bucket.push(notification);
      }
    }

    let cancelled = 0;
    let aggregated = 0;
    for (const [userId, notifications] of byUser) {
      // Cancel the originals.
      for (const notification of notifications) {
        engine = engine.cancel(notification.id, at).engine;
        cancelled += 1;
      }
      aggregated += notifications.length;
      const body = notifications
        .map((notification, index) => `${index + 1}. ${notification.title}: ${notification.body}`)
        .join("\n");
      const channel = this._preferences.preferredChannels(userId)[0] ?? "inapp";
      const address = this._preferences.getPreference(userId)?.channelConfig[channel]?.address ?? userId;
      const recipient = createNotificationRecipient({
        channel,
        address,
        label: address,
      });
      const { engine: next, notification } = await engine.send(
        {
          userId,
          title: `Digest — ${notifications.length} notification${notifications.length === 1 ? "" : "s"}`,
          body,
          category: "digest",
          priority: "normal",
          recipients: [recipient],
        },
        at,
      );
      engine = next;
      digests.push(notification);
    }

    this._delivery = engine;
    this._monitoring = this._monitoring.increment(
      "notification.digests.sent",
      at,
      digests.length,
    );
    this.observeQueueDepth(at);
    return { engine: this, digests, aggregated, cancelled };
  }

  // ── Cleanup job ───────────────────────────────────────────────

  /**
   * Prune settled notifications older than `retentionMs` at `now` and clean
   * up expired dead-letter records (the notification-cleanup job).
   */
  async runCleanup(now: string, retentionMs: number): Promise<CleanupRunOutcome> {
    const { engine, removed, deadLettersRemoved } = this._delivery.prune(now, retentionMs);
    this._delivery = engine;
    this._monitoring = this._monitoring.increment(
      "notification.cleaned",
      now,
      removed.length,
    );
    this.observeQueueDepth(now);
    return { engine: this, removed, deadLettersRemoved };
  }

  // ── Full pipeline + recovery ──────────────────────────────────

  /**
   * Run the full background pipeline at `now`: dispatch due notifications,
   * replay dead letters, deliver digests, and clean up old records.
   */
  async runAll(now?: string): Promise<{
    engine: NotificationBackgroundEngine;
    summary: NotificationBackgroundRunSummary;
  }> {
    const at = now ?? this.now();
    const dispatch = await this.runDispatch(at);
    const replay = await this.runReplay(at);
    const digest = await this.runDigest(at);
    const cleanup = await this.runCleanup(at, 7 * 24 * 60 * 60 * 1000);
    return {
      engine: this,
      summary: Object.freeze({
        at,
        dispatched: dispatch.summary.attempted,
        delivered: dispatch.summary.delivered,
        failed: dispatch.summary.failed,
        replayed: replay.replayed.length,
        digestsSent: digest.digests.length,
        cleaned: cleanup.removed.length,
        deadLettersRemoved: cleanup.deadLettersRemoved,
      }),
    };
  }

  /**
   * Restart recovery at `now`: dispatch everything already queued (so a
   * restarted process resumes its pending work) and replay dead letters.
   */
  async recover(now?: string): Promise<{
    engine: NotificationBackgroundEngine;
    summary: NotificationBackgroundRunSummary;
  }> {
    const at = now ?? this.now();
    const dispatch = await this.runDispatch(at);
    const replay = await this.runReplay(at);
    return {
      engine: this,
      summary: Object.freeze({
        at,
        dispatched: dispatch.summary.attempted,
        delivered: dispatch.summary.delivered,
        failed: dispatch.summary.failed,
        replayed: replay.replayed.length,
        digestsSent: 0,
        cleaned: 0,
        deadLettersRemoved: 0,
      }),
    };
  }

  /** Restore persisted state wholesale (restart recovery of sub-engines). */
  restoreState(input: {
    readonly delivery: NotificationDeliveryEngine;
    readonly preferences?: NotificationPreferenceEngine;
  }): NotificationBackgroundEngine {
    this._delivery = input.delivery;
    if (input.preferences !== undefined) this._preferences = input.preferences;
    return this;
  }

  // ── Internals ─────────────────────────────────────────────────

  /**
   * Feed the dispatch receipts into monitoring: per-recipient delivery
   * observations and per-notification dead-letter/failure observations.
   * Public so the composition root can observe inline `send`/`sendBatch`
   * dispatches too (every dispatch path records monitoring, not just the
   * worker runs). Each notification's state is resolved at most once.
   */
  observeDispatchOutcomes(
    receipts: readonly NotificationDeliveryReceipt[],
    at: string,
  ): NotificationBackgroundEngine {
    // Resolve each notification's state at most once (receipts repeat per
    // recipient, so a multi-recipient notification is looked up once).
    const settled = new Map<string, Notification | undefined>();
    for (const receipt of receipts) {
      if (!settled.has(receipt.notificationId)) {
        settled.set(receipt.notificationId, this._delivery.find(receipt.notificationId));
      }
      const notification = settled.get(receipt.notificationId);
      this._monitoring = this._monitoring.observeDelivery({
        notificationId: receipt.notificationId,
        ok: receipt.ok,
        durationMs: 0,
        channel: receipt.channel,
        at,
      });
      if (notification === undefined) continue;
      if (notification.status === "dead") {
        this._monitoring = this._monitoring.observeFailure({
          notificationId: receipt.notificationId,
          code: notification.error?.code ?? "dead",
          message: notification.error?.message ?? "Dead-lettered",
          attempt: notification.attempts,
          at,
        });
      } else if (notification.status === "queued" || notification.status === "pending") {
        this._monitoring = this._monitoring.observeRetry(
          receipt.notificationId,
          notification.attempts,
          at,
        );
      }
    }
    return this;
  }

  /** Push the current queue depth into monitoring (deterministic gauges). */
  private observeQueueDepth(at: string): void {
    const stats = this._delivery.queueStatistics(at);
    this._monitoring = this._monitoring.observeQueueDepth({
      at,
      pending: stats.pending.total,
      delayed: stats.delayed.total,
      retry: stats.retry.total,
      deadLetter: stats.deadLetter.total,
    });
  }
}

/** A compact view of a delivery run for background summaries. */
export interface NotificationDeliveryRunView {
  readonly at: string;
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly dead: number;
  readonly retried: number;
  readonly cancelled: number;
  readonly receipts: number;
}

/** Build a fresh notification background engine. */
export function createNotificationBackgroundEngine(
  options: NotificationBackgroundEngineOptions = {},
): NotificationBackgroundEngine {
  return new NotificationBackgroundEngine(options);
}
