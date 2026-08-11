/**
 * Notification & Delivery System — persistence (Phase 6D STEP 11).
 *
 * The durable row-level home of the notification domain, built on the Phase
 * 6A `DatabaseEngine`. Every notification-domain model is persisted as a
 * `DatabaseRecord` envelope in its own collection (the Phase 6D extension of
 * `DatabaseCollectionKind` — see `lib/database/types.ts`):
 *
 * - notifications → `notification`
 * - deliveries / attempts / histories → `notification_delivery`,
 *   `notification_attempt`, `notification_history`
 * - failures → `notification_failure`; dead-letter records →
 *   `notification_deadletter` (distinct collections: a dead-lettered
 *   failure lives in both the failure ledger and the dead-letter store)
 * - batches → `notification_batch`
 * - queue items / retry states → `notification_queue`, `notification_retry`
 * - templates → `notification_template`
 * - preferences / subscriptions / rules → `notification_preference`,
 *   `notification_subscription`, `notification_rule`
 * - metrics / reports → `notification_metric`
 *
 * `save` writes the full snapshot of one domain engine (notifications,
 * templates, preferences) under `scope`; `restore` rebuilds fresh engines
 * from the stored envelopes (restart recovery). Reads are detached clones;
 * writes go through the driver atomically. Everything is deterministic —
 * envelope ids derive from `databaseRecordIdFor`, timestamps are
 * caller-supplied.
 *
 * The module never mutates the source engines; it only reads their state
 * (`list()`, `templates.list()`, …) and rebuilds successors on restore.
 */

import { DatabaseEngine } from "@/lib/database/production";
import {
  canonicalJson,
  createDatabaseRecord,
  databaseRecordIdFor,
  type DatabaseCollectionKind,
} from "@/lib/database/types";
import { hashString } from "@/lib/hash";
import { NotificationDeliveryEngine } from "./delivery";
import { NotificationPreferenceEngine } from "./preferences";
import { TemplateRegistry, createTemplateRegistry } from "./templates";
import {
  createDeadLetterStore,
  createRetryManager,
  type NotificationRetryState,
} from "./retry";
import { createNotificationQueueSet } from "./queue";
import { createNotificationQueue } from "./queue";
import type { NotificationQueueKind } from "./types";
import type {
  Notification,
  NotificationBatch,
  NotificationDelivery,
  NotificationDeliveryAttempt,
  NotificationFailure,
  NotificationHistory,
  NotificationPreference,
  NotificationPreferenceRule,
  NotificationQueueItem,
  NotificationSubscription,
  NotificationTemplate,
} from "./types";

/** Options accepted by the {@link NotificationPersistence} constructor. */
export interface NotificationPersistenceOptions {
  /** The database engine (dependency injection; fresh by default). */
  readonly database?: DatabaseEngine;
}

/** The outcome of one save (per collection). */
export interface NotificationSaveResult {
  /** How many rows were written. */
  readonly written: number;
  /** How many stale rows were removed. */
  readonly removed: number;
  /** Which collections were persisted. */
  readonly collections: readonly string[];
}

/** A per-collection restore failure (failure-isolated batches). */
export interface NotificationRestoreError {
  readonly collection: string;
  readonly message: string;
}

/** Every collection kind owned by the notification domain (Phase 6D). */
export const NOTIFICATION_DATABASE_COLLECTIONS: readonly DatabaseCollectionKind[] = Object.freeze([
  "notification",
  "notification_delivery",
  "notification_attempt",
  "notification_history",
  "notification_failure",
  "notification_deadletter",
  "notification_batch",
  "notification_queue",
  "notification_retry",
  "notification_template",
  "notification_preference",
  "notification_subscription",
  "notification_rule",
  "notification_metric",
]);

/**
 * Row-level persistence for the notification domain over a Phase 6A
 * `DatabaseEngine`. Pure with respect to engines — engines are only read
 * (snapshot) or rebuilt (restore), never mutated.
 */
export class NotificationPersistence {
  /** The wrapped database engine (readonly). */
  readonly database: DatabaseEngine;

  constructor(options: NotificationPersistenceOptions = {}) {
    this.database = options.database ?? new DatabaseEngine();
  }

  // ─────────────────────────────────────────────────────────────
  // Notifications (delivery engine state)
  // ─────────────────────────────────────────────────────────────

  /**
   * Persist the delivery engine's state under `scope`: notifications,
   * deliveries, attempts, histories, failures (incl. dead letters), batches,
   * queue items, retry states. Returns the per-collection save outcome.
   */
  async saveNotifications(
    scope: string,
    engine: NotificationDeliveryEngine,
    now: string,
  ): Promise<NotificationSaveResult> {
    const notifications = engine.list();
    const deliveries = notifications.flatMap((notification) =>
      engine.deliveries(notification.id),
    );
    const attempts = deliveries.flatMap((delivery) => engine.attempts(delivery.id));
    const histories = notifications
      .map((notification) => engine.history(notification.id))
      .filter((history): history is NotificationHistory => history !== undefined);
    const failures = engine.failures();
    const batches = engine.batches();
    const deadLetterEntries = engine.deadLetters.list();
    const retryStates = engine.retry.list();
    const queueItems = this.queueItems(engine);

    const written = await this.writeAll(scope, now, [
      { kind: "notification", records: notifications },
      { kind: "notification_delivery", records: deliveries },
      { kind: "notification_attempt", records: attempts },
      { kind: "notification_history", records: histories },
      { kind: "notification_failure", records: failures },
      { kind: "notification_deadletter", records: deadLetterEntries },
      { kind: "notification_batch", records: batches },
      { kind: "notification_queue", records: queueItems },
      { kind: "notification_retry", records: retryStates },
    ]);
    return written;
  }

  /**
   * Rebuild a fresh delivery engine from the stored state under `scope`
   * (restart recovery). Empty storage restores an empty engine.
   */
  async restoreNotifications(
    scope: string,
    now?: string,
  ): Promise<NotificationDeliveryEngine> {
    const at = now ?? new Date().toISOString();
    const notifications = await this.readCollection<Notification>(scope, "notification");
    const deliveries = await this.readCollection<NotificationDelivery>(
      scope,
      "notification_delivery",
    );
    const attempts = await this.readCollection<NotificationDeliveryAttempt>(
      scope,
      "notification_attempt",
    );
    const histories = await this.readCollection<NotificationHistory>(scope, "notification_history");
    const failures = await this.readCollection<NotificationFailure>(scope, "notification_failure");
    const batches = await this.readCollection<NotificationBatch>(scope, "notification_batch");
    const deadLetterEntries = await this.readCollection<NotificationFailure>(
      scope,
      "notification_deadletter",
    );
    const retryStates = await this.readCollection<NotificationRetryState>(
      scope,
      "notification_retry",
    );
    const queueItems = await this.readCollection<NotificationQueueItem>(
      scope,
      "notification_queue",
    );

    const engine = new NotificationDeliveryEngine({ now: () => at, clockMs: () => 0 });
    engine.restoreState({
      notifications,
      deliveries,
      attempts,
      histories,
      failures,
      batches,
    });
    if (deadLetterEntries.length > 0) {
      engine.withDeadLetters(createDeadLetterStore({ entries: deadLetterEntries }));
    }
    if (retryStates.length > 0) {
      engine.withRetry(createRetryManager({ states: retryStates }));
    }
    if (queueItems.length > 0) {
      engine.withQueues(this.rebuildQueueSet(queueItems, at));
    }
    return engine;
  }

  // ─────────────────────────────────────────────────────────────
  // Templates
  // ─────────────────────────────────────────────────────────────

  /** Persist the template registry under `scope`. */
  async saveTemplates(
    scope: string,
    registry: TemplateRegistry,
    now: string,
  ): Promise<NotificationSaveResult> {
    return this.writeAll(scope, now, [
      { kind: "notification_template", records: registry.list() },
    ]);
  }

  /** Rebuild a fresh template registry from storage (restart recovery). */
  async restoreTemplates(scope: string): Promise<TemplateRegistry> {
    const templates = await this.readCollection<NotificationTemplate>(
      scope,
      "notification_template",
    );
    return createTemplateRegistry({ templates });
  }

  // ─────────────────────────────────────────────────────────────
  // Preferences
  // ─────────────────────────────────────────────────────────────

  /** Persist preferences, subscriptions and rules under `scope`. */
  async savePreferences(
    scope: string,
    engine: NotificationPreferenceEngine,
    now: string,
  ): Promise<NotificationSaveResult> {
    const preferences = engine.listPreferences();
    const subscriptions = engine.listAllSubscriptions();
    const rules = engine.listAllRules();
    return this.writeAll(scope, now, [
      { kind: "notification_preference", records: preferences },
      { kind: "notification_subscription", records: subscriptions },
      { kind: "notification_rule", records: rules },
    ]);
  }

  /** Rebuild a fresh preference engine from storage (restart recovery). */
  async restorePreferences(scope: string): Promise<NotificationPreferenceEngine> {
    const preferences = await this.readCollection<NotificationPreference>(
      scope,
      "notification_preference",
    );
    const subscriptions = await this.readCollection<NotificationSubscription>(
      scope,
      "notification_subscription",
    );
    const rules = await this.readCollection<NotificationPreferenceRule>(
      scope,
      "notification_rule",
    );
    const engine = new NotificationPreferenceEngine();
    engine.restoreState({ preferences, subscriptions, rules });
    return engine;
  }

  // ─────────────────────────────────────────────────────────────
  // Metrics / reports
  // ─────────────────────────────────────────────────────────────

  /**
   * Persist a delivery report snapshot under `scope` (metrics/reports
   * collection, full-replace — the latest report replaces the stored one).
   */
  async saveReport(
    scope: string,
    report: Record<string, unknown>,
    now: string,
  ): Promise<NotificationSaveResult> {
    return this.writeAll(scope, now, [{ kind: "notification_metric", records: [report] }]);
  }

  /** Read every stored report snapshot under `scope`. */
  async restoreReports(scope: string): Promise<readonly Record<string, unknown>[]> {
    return this.readCollection<Record<string, unknown>>(scope, "notification_metric");
  }

  // ─────────────────────────────────────────────────────────────
  // Whole-domain save / restore
  // ─────────────────────────────────────────────────────────────

  /** Persist the whole notification domain (delivery + preferences + templates). */
  async saveAll(
    scope: string,
    input: {
      readonly delivery: NotificationDeliveryEngine;
      readonly preferences: NotificationPreferenceEngine;
      readonly templates: TemplateRegistry;
    },
    now: string,
  ): Promise<{
    results: readonly NotificationSaveResult[];
    errors: readonly NotificationRestoreError[];
  }> {
    const results: NotificationSaveResult[] = [];
    const errors: NotificationRestoreError[] = [];
    const operations: ReadonlyArray<{ collection: string; run: () => Promise<NotificationSaveResult> }> = [
      { collection: "notifications", run: () => this.saveNotifications(scope, input.delivery, now) },
      { collection: "preferences", run: () => this.savePreferences(scope, input.preferences, now) },
      { collection: "templates", run: () => this.saveTemplates(scope, input.templates, now) },
    ];
    for (const operation of operations) {
      try {
        results.push(await operation.run());
      } catch (error) {
        errors.push({
          collection: operation.collection,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results, errors };
  }

  /** Rebuild the whole notification domain from storage (restart recovery). */
  async restoreAll(
    scope: string,
  ): Promise<{
    delivery: NotificationDeliveryEngine;
    preferences: NotificationPreferenceEngine;
    templates: TemplateRegistry;
    errors: readonly NotificationRestoreError[];
  }> {
    const errors: NotificationRestoreError[] = [];
    const delivery = await this.isolated(
      () => this.restoreNotifications(scope),
      "notification",
      errors,
      new NotificationDeliveryEngine(),
    );
    const preferences = await this.isolated(
      () => this.restorePreferences(scope),
      "notification_preference",
      errors,
      new NotificationPreferenceEngine(),
    );
    const templates = await this.isolated(
      () => this.restoreTemplates(scope),
      "notification_template",
      errors,
      createTemplateRegistry(),
    );
    return { delivery, preferences, templates, errors };
  }

  /** Whether any notification-domain rows exist under `scope`. */
  async hasData(scope: string): Promise<boolean> {
    for (const kind of NOTIFICATION_DATABASE_COLLECTIONS) {
      const stored = await this.database.driver.readAll(scope, kind);
      if (stored.length > 0) return true;
    }
    return false;
  }

  /** Remove every notification-domain row under `scope`. */
  async clear(scope: string): Promise<void> {
    for (const kind of NOTIFICATION_DATABASE_COLLECTIONS) {
      await this.database.driver.clearCollection(scope, kind);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────

  /** The queue items of a delivery engine, in deterministic order. */
  private queueItems(engine: NotificationDeliveryEngine): NotificationQueueItem[] {
    return [
      ...engine.queues.pending.list(),
      ...engine.queues.delayed.list(),
      ...engine.queues.retry.list(),
      ...engine.queues.deadLetter.list(),
    ];
  }

  /** Rebuild a queue set from stored items (kind-aware restore). */
  private rebuildQueueSet(
    items: readonly NotificationQueueItem[],
    at: string,
  ): ReturnType<typeof createNotificationQueueSet> {
    const byKind = (kind: NotificationQueueKind): NotificationQueueItem[] =>
      items.filter((item) => item.kind === kind);
    const queue = (kind: NotificationQueueKind, kindItems: NotificationQueueItem[]) =>
      createNotificationQueue(kind, { createdAt: at }, kindItems);
    return createNotificationQueueSet({
      createdAt: at,
      pending: queue("priority", byKind("priority")),
      delayed: queue("delayed", byKind("delayed")),
      retry: queue("retry", byKind("retry")),
      deadLetter: queue("deadLetter", byKind("deadLetter")),
    });
  }

  /** Write one collection's records (full-replace: stale rows removed). */
  private async writeAll(
    scope: string,
    now: string,
    collections: ReadonlyArray<{
      readonly kind: NotificationCollectionKind;
      // Models without a stable `id` (histories, retry states) fall back to
      // a canonical-content hash; the reader casts `data as T` on restore.
      readonly records: readonly object[];
    }>,
  ): Promise<NotificationSaveResult> {
    let written = 0;
    let removed = 0;
    const collectionsPersisted: string[] = [];
    for (const collection of collections) {
      const envelopes = collection.records.map((record) => {
        const recordId =
          (record as { id?: string }).id ?? `record-${hashString(canonicalJson(record))}`;
        return createDatabaseRecord({
          scope,
          collection: collection.kind,
          recordId,
          createdAt: now,
          updatedAt: now,
          data: record as Record<string, unknown>,
          id: databaseRecordIdFor(scope, collection.kind, recordId),
        });
      });
      const stored = await this.database.driver.readAll(scope, collection.kind);
      const storedIds = new Set(stored.map((record) => record.recordId));
      const desiredIds = new Set(envelopes.map((record) => record.recordId));
      const stale = [...storedIds].filter((id) => !desiredIds.has(id));
      if (envelopes.length > 0) {
        await this.database.driver.upsertAll(scope, collection.kind, envelopes);
      }
      if (stale.length > 0) {
        await this.database.driver.deleteMany(scope, collection.kind, stale);
      }
      written += envelopes.length;
      removed += stale.length;
      collectionsPersisted.push(collection.kind);
    }
    return Object.freeze({ written, removed, collections: Object.freeze(collectionsPersisted) });
  }

  /** Read a collection's payloads as detached copies, in stored order. */
  private async readCollection<T>(scope: string, kind: NotificationCollectionKind): Promise<T[]> {
    const stored = await this.database.driver.readAll(scope, kind);
    return stored.map((record) => record.data as T);
  }

  /** Run a restore with per-collection failure isolation. */
  private async isolated<T>(
    run: () => Promise<T>,
    collection: string,
    errors: NotificationRestoreError[],
    fallback: T,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      errors.push({
        collection,
        message: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }
}

/** The notification collection kinds (derived from the Phase 6D extension). */
type NotificationCollectionKind = Extract<DatabaseCollectionKind, `notification${string}`>;

/** Build a fresh notification persistence adapter. */
export function createNotificationPersistence(
  options: NotificationPersistenceOptions = {},
): NotificationPersistence {
  return new NotificationPersistence(options);
}
