/**
 * Background Worker Infrastructure — dead letter queue (Phase 6B STEP 9).
 *
 * Stores tasks that exhausted their retry budget, with replay (manual and
 * automatic), expiration, cleanup, history, statistics and immutable
 * snapshots. Every mutation returns a successor queue.
 *
 * Complexity: `add`/`remove`/`replay`/`expire` are O(n); statistics and
 * snapshots are O(n).
 */

import { hashString } from "@/lib/hash";
import type { WorkerError } from "./types";

/** A dead letter entry. */
export interface DeadLetterEntry {
  readonly id: string;
  readonly taskId: string;
  /** The worker that ran the final failed attempt, when known. */
  readonly workerId?: string;
  /** Total attempts made before the task was dead-lettered. */
  readonly attempts: number;
  /** ISO-8601 UTC timestamp of the failure. */
  readonly failedAt: string;
  readonly error: WorkerError;
  /** Whether the entry may be replayed. */
  readonly replayable: boolean;
  /** ISO-8601 UTC timestamp of the replay, when replayed. */
  readonly replayedAt?: string;
  /** Replay outcome, when replayed. */
  readonly replayResult?: "completed" | "failed" | "cancelled";
}

/** Input accepted by {@link createDeadLetterEntry}. */
export interface CreateDeadLetterEntryInput {
  readonly id?: string;
  readonly taskId: string;
  readonly workerId?: string;
  readonly attempts: number;
  readonly failedAt: string;
  readonly error: WorkerError;
  readonly replayable?: boolean;
}

/** Build an immutable dead letter entry (deterministic id). */
export function createDeadLetterEntry(input: CreateDeadLetterEntryInput): DeadLetterEntry {
  return Object.freeze({
    id: input.id ?? `dlq-${hashString(`${input.taskId}:${input.failedAt}`)}`,
    taskId: input.taskId,
    ...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
    attempts: input.attempts,
    failedAt: input.failedAt,
    error: Object.freeze({ ...input.error }),
    replayable: input.replayable ?? true,
  });
}

/** Statistics of the dead letter queue. */
export interface DeadLetterStatistics {
  readonly total: number;
  readonly replayable: number;
  readonly replayed: number;
  readonly failed: number;
}

/** Immutable dead letter queue (successor pattern). */
export class DeadLetterQueue {
  /** The stored entries (frozen). */
  readonly entries: readonly DeadLetterEntry[];

  constructor(entries: readonly DeadLetterEntry[] = []) {
    this.entries = Object.freeze([...entries]);
  }

  /** Build a successor queue over `entries`. */
  private next(entries: readonly DeadLetterEntry[]): DeadLetterQueue {
    return new DeadLetterQueue(entries);
  }

  /** Number of stored entries. */
  count(): number {
    return this.entries.length;
  }

  /** The entry with `entryId`, or `undefined` (detached copy). */
  find(entryId: string): DeadLetterEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    return entry === undefined ? undefined : { ...entry, error: { ...entry.error } };
  }

  /** The entry for `taskId`, or `undefined` (detached copy). */
  findByTask(taskId: string): DeadLetterEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.taskId === taskId);
    return entry === undefined ? undefined : { ...entry, error: { ...entry.error } };
  }

  /** Whether an entry for `taskId` exists. */
  hasTask(taskId: string): boolean {
    return this.entries.some((entry) => entry.taskId === taskId);
  }

  /** Return a successor queue with `entry` stored (no duplicates by id). */
  add(entry: DeadLetterEntry): { queue: DeadLetterQueue; entry: DeadLetterEntry } {
    if (this.entries.some((candidate) => candidate.id === entry.id)) {
      throw new Error(`Dead letter queue already contains entry "${entry.id}"`);
    }
    return { queue: this.next([...this.entries, entry]), entry: { ...entry, error: { ...entry.error } } };
  }

  /** Return a successor queue without the entry `entryId`. */
  remove(entryId: string): DeadLetterQueue {
    if (!this.entries.some((entry) => entry.id === entryId)) return this;
    return this.next(this.entries.filter((entry) => entry.id !== entryId));
  }

  /** Remove every entry for `taskId` (no-op when absent). */
  removeTask(taskId: string): DeadLetterQueue {
    if (!this.hasTask(taskId)) return this;
    return this.next(this.entries.filter((entry) => entry.taskId !== taskId));
  }

  /**
   * Manually replay one entry: mark it replayed. Returns the successor queue
   * plus the replayed entry (a copy). Throws for unknown ids.
   */
  replay(entryId: string, at: string): { queue: DeadLetterQueue; entry: DeadLetterEntry } {
    const entry = this.find(entryId);
    if (entry === undefined) {
      throw new Error(`Dead letter entry not found: ${entryId}`);
    }
    const replayed: DeadLetterEntry = Object.freeze({
      ...entry,
      replayedAt: at,
      replayResult: "completed",
    });
    return {
      queue: this.next(this.entries.map((candidate) => (candidate.id === entryId ? replayed : candidate))),
      entry: { ...replayed, error: { ...replayed.error } },
    };
  }

  /**
   * Automatically replay every replayable entry that has not been replayed.
   * Returns the successor queue plus the replayed entries.
   */
  replayAll(at: string): { queue: DeadLetterQueue; entries: DeadLetterEntry[] } {
    const targets = this.entries.filter(
      (entry) => entry.replayable && entry.replayedAt === undefined,
    );
    if (targets.length === 0) return { queue: this, entries: [] };
    const targetIds = new Set(targets.map((entry) => entry.id));
    const replayed: DeadLetterEntry[] = targets.map((entry) =>
      Object.freeze({ ...entry, replayedAt: at, replayResult: "completed" }),
    );
    return {
      queue: this.next(
        this.entries.map((entry) =>
          targetIds.has(entry.id)
            ? Object.freeze({ ...entry, replayedAt: at, replayResult: "completed" })
            : entry,
        ),
      ),
      entries: replayed.map((entry) => ({ ...entry, error: { ...entry.error } })),
    };
  }

  /** Number of replayable, not-yet-replayed entries. */
  pendingReplayCount(): number {
    return this.entries.filter(
      (entry) => entry.replayable && entry.replayedAt === undefined,
    ).length;
  }

  /**
   * Expire entries whose `failedAt` is older than `retentionMs` at `now`.
   * Returns the successor queue and the expired entries.
   */
  expire(now: string, retentionMs: number): {
    queue: DeadLetterQueue;
    entries: DeadLetterEntry[];
  } {
    const cutoff = Date.parse(now) - retentionMs;
    const expired = this.entries.filter((entry) => Date.parse(entry.failedAt) < cutoff);
    if (expired.length === 0) return { queue: this, entries: [] };
    const expiredIds = new Set(expired.map((entry) => entry.id));
    return {
      queue: this.next(this.entries.filter((entry) => !expiredIds.has(entry.id))),
      entries: expired.map((entry) => ({ ...entry, error: { ...entry.error } })),
    };
  }

  /** Alias of {@link expire} (cleanup semantics). */
  cleanup(now: string, retentionMs: number): {
    queue: DeadLetterQueue;
    entries: DeadLetterEntry[];
  } {
    return this.expire(now, retentionMs);
  }

  /** Every entry as detached copies, oldest first. */
  list(): DeadLetterEntry[] {
    return [...this.entries]
      .sort((a, b) => Date.parse(a.failedAt) - Date.parse(b.failedAt))
      .map((entry) => ({ ...entry, error: { ...entry.error } }));
  }

  /** Deterministic statistics. */
  statistics(): DeadLetterStatistics {
    const replayed = this.entries.filter((entry) => entry.replayedAt !== undefined).length;
    return Object.freeze({
      total: this.entries.length,
      replayable: this.pendingReplayCount(),
      replayed,
      failed: this.entries.length - replayed,
    });
  }

  /** An immutable snapshot of the queue. */
  snapshot(): { at: string; entries: readonly DeadLetterEntry[] } {
    return Object.freeze({ at: "snapshot", entries: Object.freeze([...this.entries]) });
  }

  /** Deterministic hash of the queue contents. */
  hashQueue(): string {
    return hashString(this.entries.map((entry) => entry.id).join(":"));
  }
}
