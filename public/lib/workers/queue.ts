/**
 * Background Worker Infrastructure — immutable queues (Phase 6B STEP 3).
 *
 * `WorkerQueue` is an immutable collection of `WorkerQueueItem`s. Every
 * mutation returns a successor queue (the receiver is never changed), every
 * read returns detached copies, and ordering is fully deterministic:
 * priority (descending) → due time (ascending, `dequeueAt` falling back to
 * the enqueue time) → enqueued time (ascending) → item id (lexicographic).
 *
 * Queue kinds: `priority` (the main pending queue), `fifo` (equal-priority
 * ordering by enqueue time), `retry` (failed tasks awaiting a retry),
 * `scheduled`/`delayed` (tasks with a future `dequeueAt`). The dead-letter
 * queue lives in `./deadLetter` (Phase 6B STEP 9).
 *
 * Complexity:
 * - `enqueue`/`remove`/`replace`/`contains`: O(n) (immutable array copy).
 * - `dequeue`/`peek`: O(n log n) for the deterministic ordering sort.
 * - `statistics`/`summary`/`snapshot`/`hash`: O(n).
 */

import { hashString } from "@/lib/hash";
import {
  PRIORITY_RANK,
  type WorkerQueue as WorkerQueueModel,
  type WorkerQueueItem,
  type WorkerQueueKind,
  type WorkerPriority,
} from "./types";

/** The default capacity of a queue (unbounded growth above is rejected). */
export const DEFAULT_QUEUE_CAPACITY = 10_000;

/** Options accepted by the {@link WorkerQueue} constructor. */
export interface WorkerQueueOptions {
  /** Optional explicit queue id (deterministic default derived from kind). */
  readonly id?: string;
  /** Optional human-readable name. */
  readonly name?: string;
  /** Maximum number of items (default 10,000). */
  readonly capacity?: number;
  /** Creation timestamp (caller-supplied). */
  readonly createdAt: string;
}

/** Statistics of a queue. */
export interface WorkerQueueStatistics {
  readonly kind: WorkerQueueKind;
  readonly total: number;
  readonly pending: number;
  readonly due: number;
  /** Number of items whose `dequeueAt` is in the future. */
  readonly future: number;
  readonly capacity: number;
  readonly available: number;
}

/** Build a deterministic queue id. */
export function queueIdFor(kind: WorkerQueueKind, createdAt: string): string {
  return `queue-${kind}-${hashString(createdAt)}`;
}

/** The default queue id for a kind and timestamp. */
export function defaultQueueId(kind: WorkerQueueKind, createdAt: string): string {
  return queueIdFor(kind, createdAt);
}

/**
 * Deterministic ordering of queue items for dequeue:
 * priority (desc) → due time (asc) → enqueued time (asc) → item id (asc).
 * The input array is never mutated.
 */
export function orderQueueItems(items: readonly WorkerQueueItem[]): WorkerQueueItem[] {
  return [...items].sort((left, right) => {
    const priorityDelta = PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority];
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

/** Immutable worker queue (successor pattern). */
export class WorkerQueue {
  /** The queue kind. */
  readonly kind: WorkerQueueKind;
  /** Maximum number of items. */
  readonly capacity: number;
  /** The immutable item list (never exposed for mutation). */
  readonly items: readonly WorkerQueueItem[];
  /** Creation timestamp. */
  readonly createdAt: string;
  /** Deterministic queue id. */
  readonly id: string;
  /** Human-readable name (defaults to the kind). */
  readonly name: string;

  constructor(
    kind: WorkerQueueKind,
    options: WorkerQueueOptions,
    items: readonly WorkerQueueItem[] = [],
  ) {
    this.kind = kind;
    this.capacity = options.capacity ?? DEFAULT_QUEUE_CAPACITY;
    this.createdAt = options.createdAt;
    this.id = options.id ?? queueIdFor(kind, options.createdAt);
    this.name = options.name ?? kind;
    this.items = Object.freeze([...items]);
  }

  /** Build a successor queue over `items` (internal helper). */
  private next(items: readonly WorkerQueueItem[]): WorkerQueue {
    return new WorkerQueue(
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

  /** Whether an item for `taskId` is stored. */
  containsTask(taskId: string): boolean {
    return this.items.some((item) => item.taskId === taskId);
  }

  /** The stored item with `itemId`, or `undefined`. */
  find(itemId: string): WorkerQueueItem | undefined {
    const item = this.items.find((entry) => entry.id === itemId);
    return item === undefined ? undefined : { ...item };
  }

  /** The stored item for `taskId`, or `undefined`. */
  findByTask(taskId: string): WorkerQueueItem | undefined {
    const item = this.items.find((entry) => entry.taskId === taskId);
    return item === undefined ? undefined : { ...item };
  }

  /** Build a frozen detached copy of an item. */
  private copy(item: WorkerQueueItem): WorkerQueueItem {
    return Object.freeze({ ...item });
  }

  /** Number of pending (due) items at `now`. */
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
  enqueue(item: WorkerQueueItem): { queue: WorkerQueue; item: WorkerQueueItem } {
    if (this.contains(item.id)) {
      throw new Error(`Queue already contains item "${item.id}"`);
    }
    if (this.isFull()) {
      throw new Error(`Queue "${this.name}" is at capacity (${this.capacity})`);
    }
    return { queue: this.next([...this.items, item]), item: Object.freeze({ ...item }) };
  }

  /**
   * Return a successor queue without the item `itemId` (no-op when absent).
   */
  remove(itemId: string): WorkerQueue {
    if (!this.contains(itemId)) return this;
    return this.next(this.items.filter((item) => item.id !== itemId));
  }

  /**
   * Return a successor queue with `item` replacing the stored item with the
   * same id. Throws when the item id is not stored.
   */
  replace(item: WorkerQueueItem): { queue: WorkerQueue; item: WorkerQueueItem } {
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
  peek(now: string): WorkerQueueItem | undefined {
    const due = this.items.filter((item) => this.isDue(item, now));
    if (due.length === 0) return undefined;
    const ordered = orderQueueItems(due);
    return ordered[0] === undefined ? undefined : this.copy(ordered[0]);
  }

  /**
   * Dequeue up to `count` due items at `now`. Returns the successor queue
   * (without the dequeued items) and the detached dequeued items in
   * deterministic order.
   */
  dequeue(
    count: number,
    now: string,
  ): { queue: WorkerQueue; items: WorkerQueueItem[] } {
    if (count <= 0) return { queue: this, items: [] };
    const ordered = orderQueueItems(this.items.filter((item) => this.isDue(item, now)));
    const taken = ordered.slice(0, count);
    if (taken.length === 0) return { queue: this, items: [] };
    const takenIds = new Set(taken.map((item) => item.id));
    return {
      queue: this.next(this.items.filter((item) => !takenIds.has(item.id))),
      items: taken.map((item) => this.copy(item)),
    };
  }

  /** Alias of {@link dequeue} (batch semantics). */
  batchDequeue(
    count: number,
    now: string,
  ): { queue: WorkerQueue; items: WorkerQueueItem[] } {
    return this.dequeue(count, now);
  }

  /** Every stored item as detached copies, in deterministic order. */
  list(): WorkerQueueItem[] {
    return orderQueueItems(this.items).map((item) => this.copy(item));
  }

  /** A detached snapshot of the queue model. */
  model(): WorkerQueueModel {
    return Object.freeze({
      id: this.id,
      name: this.name,
      kind: this.kind,
      capacity: this.capacity,
      itemIds: Object.freeze(this.items.map((item) => item.id)),
      createdAt: this.createdAt,
    });
  }

  /** Queue statistics at `now` (deterministic). */
  statistics(now: string): WorkerQueueStatistics {
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

  /** Deterministic hash of the queue's contents. */
  hashQueue(): string {
    const ids = orderQueueItems(this.items).map((item) => item.id);
    return hashString(`${this.kind}:${ids.join(":")}`);
  }

  /** Whether `item` is due at `now` (no `dequeueAt` or `dequeueAt <= now`). */
  private isDue(item: WorkerQueueItem, now: string): boolean {
    if (item.dequeueAt === undefined) return true;
    return Date.parse(item.dequeueAt) <= Date.parse(now);
  }
}

/** Options accepted by {@link createWorkerQueue}. */
export interface CreateWorkerQueueOptions extends WorkerQueueOptions {
  readonly items?: readonly WorkerQueueItem[];
}

/** Build an immutable queue of the given kind. */
export function createWorkerQueue(
  kind: WorkerQueueKind,
  options: CreateWorkerQueueOptions,
): WorkerQueue {
  return new WorkerQueue(kind, options, options.items);
}

/** Build a queue item (detached; caller supplies timestamps). */
export interface CreateQueueItemInput {
  readonly id?: string;
  readonly taskId: string;
  readonly kind?: WorkerQueueKind;
  readonly priority?: WorkerPriority;
  readonly status?: WorkerQueueItem["status"];
  readonly enqueuedAt: string;
  readonly dequeueAt?: string;
  readonly attempt?: number;
}

/** Build an immutable queue item. */
export function createQueueItem(input: CreateQueueItemInput): WorkerQueueItem {
  return Object.freeze({
    id: input.id ?? `qitem-${hashString(`${input.taskId}:${input.enqueuedAt}`)}`,
    taskId: input.taskId,
    kind: input.kind ?? "priority",
    priority: input.priority ?? "normal",
    status: input.status ?? "pending",
    enqueuedAt: input.enqueuedAt,
    ...(input.dequeueAt !== undefined ? { dequeueAt: input.dequeueAt } : {}),
    attempt: input.attempt ?? 0,
  });
}
