/**
 * Notification & Delivery System — immutable queues (Phase 6D STEP 3).
 *
 * `NotificationQueue` is an immutable collection of `NotificationQueueItem`s.
 * Every mutation returns a successor queue (the receiver is never changed),
 * every read returns detached copies, and ordering is fully deterministic:
 * priority (descending) → due time (ascending, `dequeueAt` falling back to
 * the enqueue time) → enqueued time (ascending) → item id (lexicographic).
 *
 * Queue kinds: `priority` (the main pending queue), `fifo` (equal-priority
 * ordering by enqueue time), `delayed` (future `dequeueAt` — scheduled
 * delivery), `retry` (failed notifications awaiting a retry) and
 * `deadLetter` (notifications that exhausted their retry budget).
 *
 * `NotificationQueueSet` composes the four operational queues the delivery
 * engine drives (priority / delayed / retry / deadLetter): it routes
 * enqueues by schedule, promotes due delayed/retry items into `priority`
 * (scheduled delivery), and moves items between queues (cancel, replace,
 * dead-letter). Dead-letter *records* live in the retry module; the queue's
 * dead-letter kind is the scheduling view.
 *
 * Complexity: `enqueue`/`remove`/`replace`/`contains` are O(n); `dequeue`
 * and `peek` are O(n log n) for the deterministic sort; `statistics`,
 * `summary` and `snapshot` are O(n).
 */

import { hashString } from "@/lib/hash";
import {
  createNotificationQueueItem,
  NOTIFICATION_PRIORITY_RANK,
  type NotificationPriority,
  type NotificationQueue as NotificationQueueModel,
  type NotificationQueueItem,
  type NotificationQueueKind,
} from "./types";

/** The default capacity of a queue (unbounded growth above is rejected). */
export const DEFAULT_NOTIFICATION_QUEUE_CAPACITY = 10_000;

/** Options accepted by the {@link NotificationQueue} constructor. */
export interface NotificationQueueOptions {
  /** Optional explicit queue id (deterministic default derived from kind). */
  readonly id?: string;
  /** Optional human-readable name. */
  readonly name?: string;
  /** Maximum number of items (default 10,000). */
  readonly capacity?: number;
  /** Creation timestamp (caller-supplied). */
  readonly createdAt: string;
}

/** Statistics of a queue at a point in time. */
export interface NotificationQueueStatistics {
  readonly kind: NotificationQueueKind;
  readonly total: number;
  readonly pending: number;
  /** Number of items due at `now`. */
  readonly due: number;
  /** Number of items whose `dequeueAt` is in the future. */
  readonly future: number;
  readonly capacity: number;
  readonly available: number;
}

/** Compact summary of a queue. */
export interface NotificationQueueSummary {
  readonly kind: NotificationQueueKind;
  readonly total: number;
  readonly byPriority: Readonly<Record<NotificationPriority, number>>;
  readonly oldestAt?: string;
  readonly newestAt?: string;
}

/** Point-in-time snapshot of a queue. */
export interface NotificationQueueSnapshot {
  readonly at: string;
  readonly queue: NotificationQueueModel;
  readonly items: readonly NotificationQueueItem[];
  readonly statistics: NotificationQueueStatistics;
  readonly summary: NotificationQueueSummary;
}

/** Build a deterministic queue id. */
export function notificationQueueIdFor(kind: NotificationQueueKind, createdAt: string): string {
  return `notification-queue-${kind}-${hashString(createdAt)}`;
}

/**
 * Deterministic ordering of queue items for dequeue:
 * priority (desc) → due time (asc) → enqueued time (asc) → item id (asc).
 * The input array is never mutated.
 */
export function orderNotificationQueueItems(
  items: readonly NotificationQueueItem[],
): NotificationQueueItem[] {
  return [...items].sort((left, right) => {
    const priorityDelta =
      NOTIFICATION_PRIORITY_RANK[right.priority] - NOTIFICATION_PRIORITY_RANK[left.priority];
    if (priorityDelta !== 0) return priorityDelta;
    const leftDue = left.dequeueAt ?? left.enqueuedAt;
    const rightDue = right.dequeueAt ?? right.enqueuedAt;
    const dueDelta = Date.parse(leftDue) - Date.parse(rightDue);
    if (dueDelta !== 0) return dueDelta;
    const enqueuedDelta = Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt);
    if (enqueuedDelta !== 0) return enqueuedDelta;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Aggregate per-priority counts. */
function priorityCounts(items: readonly NotificationQueueItem[]): Readonly<
  Record<NotificationPriority, number>
> {
  return Object.freeze({
    low: items.filter((item) => item.priority === "low").length,
    normal: items.filter((item) => item.priority === "normal").length,
    high: items.filter((item) => item.priority === "high").length,
    critical: items.filter((item) => item.priority === "critical").length,
  });
}

/** Immutable notification queue (successor pattern). */
export class NotificationQueue {
  /** The queue kind. */
  readonly kind: NotificationQueueKind;
  /** Maximum number of items. */
  readonly capacity: number;
  /** The immutable item list (never exposed for mutation). */
  readonly items: readonly NotificationQueueItem[];
  /** Creation timestamp. */
  readonly createdAt: string;
  /** Deterministic queue id. */
  readonly id: string;
  /** Human-readable name (defaults to the kind). */
  readonly name: string;

  constructor(
    kind: NotificationQueueKind,
    options: NotificationQueueOptions,
    items: readonly NotificationQueueItem[] = [],
  ) {
    this.kind = kind;
    this.capacity = options.capacity ?? DEFAULT_NOTIFICATION_QUEUE_CAPACITY;
    this.createdAt = options.createdAt;
    this.id = options.id ?? notificationQueueIdFor(kind, options.createdAt);
    this.name = options.name ?? kind;
    this.items = Object.freeze([...items]);
  }

  /** Build a successor queue over `items` (internal helper). */
  private next(items: readonly NotificationQueueItem[]): NotificationQueue {
    return new NotificationQueue(
      this.kind,
      { id: this.id, name: this.name, capacity: this.capacity, createdAt: this.createdAt },
      items,
    );
  }

  /** Number of stored items. */
  count(): number {
    return this.items.length;
  }

  /** Whether the queue has reached its capacity limit. */
  isFull(): boolean {
    return this.items.length >= this.capacity;
  }

  /** Number of free slots. */
  availableSlots(): number {
    return Math.max(0, this.capacity - this.items.length);
  }

  /** Whether an item with `itemId` is stored. */
  contains(itemId: string): boolean {
    return this.items.some((item) => item.id === itemId);
  }

  /** Whether an item for `notificationId` is stored. */
  containsNotification(notificationId: string): boolean {
    return this.items.some((item) => item.notificationId === notificationId);
  }

  /** The stored item with `itemId`, or `undefined`. */
  find(itemId: string): NotificationQueueItem | undefined {
    const item = this.items.find((entry) => entry.id === itemId);
    return item === undefined ? undefined : { ...item };
  }

  /** The stored item for `notificationId`, or `undefined`. */
  findByNotification(notificationId: string): NotificationQueueItem | undefined {
    const item = this.items.find((entry) => entry.notificationId === notificationId);
    return item === undefined ? undefined : { ...item };
  }

  /** Number of items due at `now`. */
  pendingCount(now: string): number {
    return this.items.filter((item) => this.isDue(item, now)).length;
  }

  /** Number of items with a future `dequeueAt` at `now`. */
  futureCount(now: string): number {
    return this.items.filter((item) => !this.isDue(item, now)).length;
  }

  /**
   * Return a successor queue with `item` stored. Throws when the item id is
   * already present or the queue is at capacity.
   */
  enqueue(item: NotificationQueueItem): { queue: NotificationQueue; item: NotificationQueueItem } {
    if (this.contains(item.id)) {
      throw new Error(`Queue already contains item "${item.id}"`);
    }
    if (this.isFull()) {
      throw new Error(`Queue "${this.name}" is at capacity (${this.capacity})`);
    }
    return { queue: this.next([...this.items, item]), item: { ...item } };
  }

  /**
   * Return a successor queue without the item `itemId` (no-op when absent).
   */
  remove(itemId: string): NotificationQueue {
    if (!this.contains(itemId)) return this;
    return this.next(this.items.filter((item) => item.id !== itemId));
  }

  /** Remove every item for `notificationId` (no-op when absent). */
  removeNotification(notificationId: string): NotificationQueue {
    if (!this.containsNotification(notificationId)) return this;
    return this.next(this.items.filter((item) => item.notificationId !== notificationId));
  }

  /**
   * Return a successor queue with `item` replacing the stored item with the
   * same id. Throws when the item id is not stored.
   */
  replace(item: NotificationQueueItem): { queue: NotificationQueue; item: NotificationQueueItem } {
    if (!this.contains(item.id)) {
      throw new Error(`Queue does not contain item "${item.id}"`);
    }
    return {
      queue: this.next(this.items.map((entry) => (entry.id === item.id ? item : entry))),
      item: { ...item },
    };
  }

  /**
   * Return the next due item at `now` without removing it, or `undefined`.
   */
  peek(now: string): NotificationQueueItem | undefined {
    const due = this.items.filter((item) => this.isDue(item, now));
    if (due.length === 0) return undefined;
    const ordered = orderNotificationQueueItems(due);
    return ordered[0] === undefined ? undefined : { ...ordered[0] };
  }

  /**
   * Dequeue up to `count` due items at `now`. Returns the successor queue
   * (without the dequeued items) and the detached dequeued items in
   * deterministic order.
   */
  dequeue(
    count: number,
    now: string,
  ): { queue: NotificationQueue; items: NotificationQueueItem[] } {
    if (count <= 0) return { queue: this, items: [] };
    const ordered = orderNotificationQueueItems(
      this.items.filter((item) => this.isDue(item, now)),
    );
    const taken = ordered.slice(0, count);
    if (taken.length === 0) return { queue: this, items: [] };
    const takenIds = new Set(taken.map((item) => item.id));
    return {
      queue: this.next(this.items.filter((item) => !takenIds.has(item.id))),
      items: taken.map((item) => ({ ...item })),
    };
  }

  /** Alias of {@link dequeue} (batch semantics). */
  batchDequeue(
    count: number,
    now: string,
  ): { queue: NotificationQueue; items: NotificationQueueItem[] } {
    return this.dequeue(count, now);
  }

  /** Every stored item as detached copies, in deterministic order. */
  list(): NotificationQueueItem[] {
    return orderNotificationQueueItems(this.items).map((item) => ({ ...item }));
  }

  /** A detached snapshot of the queue model. */
  model(): NotificationQueueModel {
    return Object.freeze({
      id: this.id,
      name: this.name,
      kind: this.kind,
      capacity: this.capacity,
      itemIds: Object.freeze(this.items.map((item) => item.notificationId)),
      createdAt: this.createdAt,
    });
  }

  /** Queue statistics at `now` (deterministic). */
  statistics(now: string): NotificationQueueStatistics {
    const due = this.items.filter((item) => this.isDue(item, now)).length;
    return Object.freeze({
      kind: this.kind,
      total: this.items.length,
      pending: this.items.length - due,
      due,
      future: this.items.filter((item) => !this.isDue(item, now)).length,
      capacity: this.capacity,
      available: this.availableSlots(),
    });
  }

  /** Compact summary (deterministic). */
  summary(): NotificationQueueSummary {
    const ordered = orderNotificationQueueItems(this.items);
    const oldest = ordered[0];
    const newest = ordered.length > 0 ? ordered[ordered.length - 1] : undefined;
    return Object.freeze({
      kind: this.kind,
      total: this.items.length,
      byPriority: priorityCounts(this.items),
      ...(oldest !== undefined ? { oldestAt: oldest.enqueuedAt } : {}),
      ...(newest !== undefined ? { newestAt: newest.enqueuedAt } : {}),
    });
  }

  /** Point-in-time snapshot at `now`. */
  snapshot(now: string): NotificationQueueSnapshot {
    return Object.freeze({
      at: now,
      queue: this.model(),
      items: this.list(),
      statistics: this.statistics(now),
      summary: this.summary(),
    });
  }

  /** Deterministic hash of the queue's contents. */
  hashQueue(): string {
    const ids = orderNotificationQueueItems(this.items).map((item) => item.id);
    return hashString(`${this.kind}:${ids.join(":")}`);
  }

  /** Whether `item` is due at `now` (no `dequeueAt` or `dequeueAt <= now`). */
  private isDue(item: NotificationQueueItem, now: string): boolean {
    if (item.dequeueAt === undefined) return true;
    return Date.parse(item.dequeueAt) <= Date.parse(now);
  }
}

/** Build an immutable queue of the given kind. */
export function createNotificationQueue(
  kind: NotificationQueueKind,
  options: NotificationQueueOptions,
  items: readonly NotificationQueueItem[] = [],
): NotificationQueue {
  return new NotificationQueue(kind, options, items);
}

/** Build a deterministic queue item (detached, caller-supplied timestamps). */
export interface CreateNotificationQueueItemInput {
  readonly id?: string;
  readonly notificationId: string;
  readonly kind?: NotificationQueueKind;
  readonly priority?: NotificationPriority;
  readonly status?: NotificationQueueItem["status"];
  readonly enqueuedAt: string;
  readonly dequeueAt?: string;
  readonly attempt?: number;
}

/** Build a queue item via the types module (single implementation). */
export function createQueueItem(input: CreateNotificationQueueItemInput): NotificationQueueItem {
  return createNotificationQueueItem(input);
}

// ─────────────────────────────────────────────────────────────
// NotificationQueueSet — the four operational queues together.
// ─────────────────────────────────────────────────────────────

/** Options accepted by the {@link NotificationQueueSet} constructor. */
export interface NotificationQueueSetOptions {
  /** Creation timestamp (caller-supplied). */
  readonly createdAt: string;
  /** Optional per-queue capacity. */
  readonly capacity?: number;
  readonly pending?: NotificationQueue;
  readonly delayed?: NotificationQueue;
  readonly retry?: NotificationQueue;
  readonly deadLetter?: NotificationQueue;
}

/** Aggregate statistics across the set. */
export interface NotificationQueueSetStatistics {
  readonly pending: NotificationQueueStatistics;
  readonly delayed: NotificationQueueStatistics;
  readonly retry: NotificationQueueStatistics;
  readonly deadLetter: NotificationQueueStatistics;
  /** Total items across every queue. */
  readonly total: number;
}

/** Aggregate summary across the set. */
export interface NotificationQueueSetSummary {
  readonly pending: NotificationQueueSummary;
  readonly delayed: NotificationQueueSummary;
  readonly retry: NotificationQueueSummary;
  readonly deadLetter: NotificationQueueSummary;
  readonly total: number;
}

/** Aggregate snapshot of the set. */
export interface NotificationQueueSetSnapshot {
  readonly at: string;
  readonly statistics: NotificationQueueSetStatistics;
  readonly summary: NotificationQueueSetSummary;
}

/**
 * The four operational queues of the notification layer, held together.
 *
 * Every mutation returns a successor set; the receiver is never changed.
 * `enqueue` routes into `pending` (immediate) or `delayed` (future
 * `dequeueAt`); `promoteDue` advances due delayed/retry items into
 * `pending` (scheduled delivery); `cancel`/`deadLetter` move items between
 * queues. Deterministic given `now`.
 */
export class NotificationQueueSet {
  readonly createdAt: string;
  /** The immediate (priority) queue. */
  readonly pending: NotificationQueue;
  /** Scheduled/future delivery queue. */
  readonly delayed: NotificationQueue;
  /** Failed items awaiting a retry. */
  readonly retry: NotificationQueue;
  /** Dead-lettered items (scheduling view; records live in the retry module). */
  readonly deadLetter: NotificationQueue;

  constructor(options: NotificationQueueSetOptions) {
    this.createdAt = options.createdAt;
    const capacity = options.capacity ?? DEFAULT_NOTIFICATION_QUEUE_CAPACITY;
    this.pending =
      options.pending ?? new NotificationQueue("priority", { createdAt: options.createdAt, capacity });
    this.delayed =
      options.delayed ?? new NotificationQueue("delayed", { createdAt: options.createdAt, capacity });
    this.retry =
      options.retry ?? new NotificationQueue("retry", { createdAt: options.createdAt, capacity });
    this.deadLetter =
      options.deadLetter ??
      new NotificationQueue("deadLetter", { createdAt: options.createdAt, capacity });
  }

  /** Build a successor set from partial state. */
  private next(partial: {
    pending?: NotificationQueue;
    delayed?: NotificationQueue;
    retry?: NotificationQueue;
    deadLetter?: NotificationQueue;
  }): NotificationQueueSet {
    return new NotificationQueueSet({
      createdAt: this.createdAt,
      pending: partial.pending ?? this.pending,
      delayed: partial.delayed ?? this.delayed,
      retry: partial.retry ?? this.retry,
      deadLetter: partial.deadLetter ?? this.deadLetter,
    });
  }

  /** Total items across every queue. */
  count(): number {
    return (
      this.pending.count() + this.delayed.count() + this.retry.count() + this.deadLetter.count()
    );
  }

  /** Whether `notificationId` is present in any queue. */
  containsNotification(notificationId: string): boolean {
    return (
      this.pending.containsNotification(notificationId) ||
      this.delayed.containsNotification(notificationId) ||
      this.retry.containsNotification(notificationId) ||
      this.deadLetter.containsNotification(notificationId)
    );
  }

  /** The queue item for `notificationId` across every queue, or `undefined`. */
  findByNotification(notificationId: string): NotificationQueueItem | undefined {
    return (
      this.pending.findByNotification(notificationId) ??
      this.delayed.findByNotification(notificationId) ??
      this.retry.findByNotification(notificationId) ??
      this.deadLetter.findByNotification(notificationId)
    );
  }

  /** The queue holding `notificationId`, or `undefined`. */
  queueOf(notificationId: string): NotificationQueue | undefined {
    if (this.pending.containsNotification(notificationId)) return this.pending;
    if (this.delayed.containsNotification(notificationId)) return this.delayed;
    if (this.retry.containsNotification(notificationId)) return this.retry;
    if (this.deadLetter.containsNotification(notificationId)) return this.deadLetter;
    return undefined;
  }

  /**
   * Enqueue a notification. When `dequeueAt` is provided and in the future
   * the item is routed into the delayed queue (scheduled delivery);
   * otherwise it is queued immediately in `pending` (priority ordering).
   */
  enqueue(input: {
    readonly notificationId: string;
    readonly priority?: NotificationPriority;
    readonly enqueuedAt: string;
    readonly dequeueAt?: string;
    readonly attempt?: number;
    readonly kind?: NotificationQueueKind;
  }): { set: NotificationQueueSet; item: NotificationQueueItem } {
    const future =
      input.dequeueAt !== undefined && Date.parse(input.dequeueAt) > Date.parse(input.enqueuedAt);
    const item = createNotificationQueueItem({
      notificationId: input.notificationId,
      kind: future ? "delayed" : (input.kind ?? "priority"),
      priority: input.priority ?? "normal",
      status: future ? "delayed" : input.dequeueAt !== undefined ? "scheduled" : "pending",
      enqueuedAt: input.enqueuedAt,
      ...(input.dequeueAt !== undefined ? { dequeueAt: input.dequeueAt } : {}),
      attempt: input.attempt ?? 0,
    });
    if (future) {
      const { queue, item: stored } = this.delayed.enqueue(item);
      return { set: this.next({ delayed: queue }), item: stored };
    }
    const { queue, item: stored } = this.pending.enqueue(item);
    return { set: this.next({ pending: queue }), item: stored };
  }

  /**
   * Promote every due delayed/retry item into `pending` (scheduled delivery
   * and retry advancement). Pure state promotion — no execution happens.
   */
  promoteDue(now: string): {
    set: NotificationQueueSet;
    promoted: NotificationQueueItem[];
  } {
    const delayedDue = this.delayed.dequeue(this.delayed.count(), now);
    const retryDue = this.retry.dequeue(this.retry.count(), now);
    if (delayedDue.items.length === 0 && retryDue.items.length === 0) {
      return { set: this, promoted: [] };
    }
    let pending = this.pending;
    const promoted: NotificationQueueItem[] = [];
    const promote = (item: NotificationQueueItem): void => {
      const reQueued = createNotificationQueueItem({
        id: item.id,
        notificationId: item.notificationId,
        kind: "priority",
        priority: item.priority,
        status: "pending",
        enqueuedAt: item.enqueuedAt,
        attempt: item.attempt,
      });
      pending = pending.enqueue(reQueued).queue;
      promoted.push(reQueued);
    };
    for (const item of delayedDue.items) promote(item);
    for (const item of retryDue.items) promote(item);
    return {
      set: this.next({ pending, delayed: delayedDue.queue, retry: retryDue.queue }),
      promoted,
    };
  }

  /** Re-queue a notification into `pending` for a fresh attempt. */
  requeue(input: {
    readonly notificationId: string;
    readonly priority?: NotificationPriority;
    readonly enqueuedAt: string;
    readonly attempt?: number;
  }): { set: NotificationQueueSet; item: NotificationQueueItem } {
    const item = createNotificationQueueItem({
      notificationId: input.notificationId,
      kind: "priority",
      priority: input.priority ?? "normal",
      status: "pending",
      enqueuedAt: input.enqueuedAt,
      attempt: input.attempt ?? 0,
    });
    const { queue, item: stored } = this.pending.enqueue(item);
    return { set: this.next({ pending: queue }), item: stored };
  }

  /**
   * Schedule a retry for `notificationId`: move its queued item into the
   * retry queue (delayed by `dequeueAt`), or — when the item was already
   * dequeued for dispatch — create a fresh retry item directly. Returns the
   * successor set and the stored item.
   */
  retryItem(input: {
    readonly notificationId: string;
    readonly priority?: NotificationPriority;
    readonly at: string;
    readonly dequeueAt: string;
    readonly attempt: number;
  }): { set: NotificationQueueSet; item?: NotificationQueueItem } {
    const existing = this.findByNotification(input.notificationId);
    const item = createNotificationQueueItem({
      notificationId: input.notificationId,
      kind: "retry",
      priority: input.priority ?? existing?.priority ?? "normal",
      status: "retrying",
      enqueuedAt: input.at,
      dequeueAt: input.dequeueAt,
      attempt: input.attempt,
    });
    if (existing !== undefined) {
      let set = this.remove(input.notificationId);
      const { queue, item: stored } = set.retry.enqueue(item);
      set = set.next({ retry: queue });
      return { set, item: stored };
    }
    const { queue, item: stored } = this.retry.enqueue(item);
    return { set: this.next({ retry: queue }), item: stored };
  }

  /**
   * Dead-letter `notificationId`: move its queued item into the dead-letter
   * queue, or — when the item was already dequeued for dispatch — create a
   * fresh dead-letter item directly. Returns the successor set and the
   * stored item.
   */
  deadLetterItem(input: {
    readonly notificationId: string;
    readonly priority?: NotificationPriority;
    readonly at: string;
    readonly attempt: number;
  }): { set: NotificationQueueSet; item?: NotificationQueueItem } {
    const existing = this.findByNotification(input.notificationId);
    const item = createNotificationQueueItem({
      notificationId: input.notificationId,
      kind: "deadLetter",
      priority: input.priority ?? existing?.priority ?? "normal",
      status: "dead",
      enqueuedAt: input.at,
      attempt: input.attempt,
    });
    if (existing !== undefined) {
      let set = this.remove(input.notificationId);
      const { queue, item: stored } = set.deadLetter.enqueue(item);
      set = set.next({ deadLetter: queue });
      return { set, item: stored };
    }
    const { queue, item: stored } = this.deadLetter.enqueue(item);
    return { set: this.next({ deadLetter: queue }), item: stored };
  }

  /** Remove `notificationId` from every queue. */
  remove(notificationId: string): NotificationQueueSet {
    return this.next({
      pending: this.pending.removeNotification(notificationId),
      delayed: this.delayed.removeNotification(notificationId),
      retry: this.retry.removeNotification(notificationId),
      deadLetter: this.deadLetter.removeNotification(notificationId),
    });
  }

  /** Replace the queue item of `notificationId` (same id required). */
  replace(item: NotificationQueueItem): NotificationQueueSet {
    const queue = this.queueOf(item.notificationId);
    if (queue === undefined) return this;
    const { queue: replaced } = queue.replace(item);
    if (queue.kind === "priority") return this.next({ pending: replaced });
    if (queue.kind === "delayed") return this.next({ delayed: replaced });
    if (queue.kind === "retry") return this.next({ retry: replaced });
    return this.next({ deadLetter: replaced });
  }

  /** Cancel a queued notification: remove it from every queue. */
  cancel(notificationId: string): NotificationQueueSet {
    return this.remove(notificationId);
  }

  /** The next due item across the set at `now`, or `undefined`. */
  peek(now: string): NotificationQueueItem | undefined {
    const candidates = [
      this.pending.peek(now),
      this.delayed.peek(now),
      this.retry.peek(now),
    ].filter((item): item is NotificationQueueItem => item !== undefined);
    if (candidates.length === 0) return undefined;
    const ordered = orderNotificationQueueItems(candidates);
    return ordered[0];
  }

  /**
   * Dequeue up to `count` due items at `now`. Only the pending queue is
   * drained (delayed/retry items must be promoted first). Returns the
   * successor set and the detached dequeued items in deterministic order.
   */
  dequeue(
    count: number,
    now: string,
  ): { set: NotificationQueueSet; items: NotificationQueueItem[] } {
    const { queue, items } = this.pending.dequeue(count, now);
    return { set: this.next({ pending: queue }), items };
  }

  /** Alias of {@link dequeue} (batch semantics). */
  batchDequeue(
    count: number,
    now: string,
  ): { set: NotificationQueueSet; items: NotificationQueueItem[] } {
    return this.dequeue(count, now);
  }

  /** Aggregate statistics at `now`. */
  statistics(now: string): NotificationQueueSetStatistics {
    return Object.freeze({
      pending: this.pending.statistics(now),
      delayed: this.delayed.statistics(now),
      retry: this.retry.statistics(now),
      deadLetter: this.deadLetter.statistics(now),
      total: this.count(),
    });
  }

  /** Aggregate summary. */
  summary(): NotificationQueueSetSummary {
    return Object.freeze({
      pending: this.pending.summary(),
      delayed: this.delayed.summary(),
      retry: this.retry.summary(),
      deadLetter: this.deadLetter.summary(),
      total: this.count(),
    });
  }

  /** Aggregate snapshot at `now`. */
  snapshot(now: string): NotificationQueueSetSnapshot {
    return Object.freeze({
      at: now,
      statistics: this.statistics(now),
      summary: this.summary(),
    });
  }
}

/** Build a fresh queue set (dependency-injected). */
export function createNotificationQueueSet(
  options: NotificationQueueSetOptions,
): NotificationQueueSet {
  return new NotificationQueueSet(options);
}
