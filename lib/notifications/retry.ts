/**
 * Notification & Delivery System — retry & dead letter (Phase 6D STEP 7).
 *
 * Pure retry policy evaluation and a successor-based dead-letter store:
 *
 * - **Retry policy**: `shouldRetry` decides whether a failure may be retried
 *   (retryable codes, budget); `nextRetryDelayMs` computes the exponential
 *   backoff (reusing the shared `retryDelayFor` from the worker layer —
 *   never reimplemented); `nextRetryAt` derives the scheduled retry time.
 * - **RetryManager**: successor-based per-notification retry bookkeeping —
 *   records failures, marks notifications dead when the budget is exhausted,
 *   and supports manual replay + reset. No timers, no wall clock.
 * - **DeadLetterStore**: an immutable collection of `NotificationFailure`
 *   records with add/remove/replay/replayAll/cleanup/statistics/snapshot —
 *   the durable home of dead-lettered notifications.
 *
 * Everything is deterministic; timestamps are caller-supplied.
 */

import { retryDelayFor } from "@/lib/workers/manager";
import { hashString } from "@/lib/hash";
import type {
  NotificationError,
  NotificationFailure,
  NotificationRetryPolicy,
  NotificationChannelType,
} from "./types";
import {
  createNotificationFailure,
} from "./types";

// ─────────────────────────────────────────────────────────────
// Retry policy evaluation.
// ─────────────────────────────────────────────────────────────

/** The outcome of evaluating a failure against a policy. */
export interface RetryDecision {
  readonly retryable: boolean;
  /** Reason when not retryable. */
  readonly reason?: "code_not_retryable" | "budget_exhausted" | "no_policy";
  /** Next retry delay in milliseconds (retryable only). */
  readonly delayMs?: number;
  /** Next retry timestamp (retryable only). */
  readonly nextRetryAt?: string;
}

/**
 * Whether a failed delivery should be retried under `policy` after
 * `attemptsMade` attempts (the attempt that just failed).
 */
export function shouldRetry(
  policy: NotificationRetryPolicy | undefined,
  error: NotificationError,
  attemptsMade: number,
): boolean {
  if (policy === undefined) return false;
  if (attemptsMade >= policy.maxRetries + 1) return false;
  if (policy.retryableCodes !== undefined) {
    return policy.retryableCodes.includes(error.code);
  }
  // Without explicit codes, transient failures are retryable by default and
  // everything else honours the error's own hint.
  return error.retryable !== false;
}

/** The deterministic retry delay for the next attempt (shared backoff). */
export function nextRetryDelayMs(
  policy: NotificationRetryPolicy,
  attemptsMade: number,
): number {
  return retryDelayFor(policy.backoffMs, attemptsMade, policy.maxDelayMs);
}

/** The deterministic next retry timestamp after a failure at `failedAt`. */
export function nextRetryAt(
  policy: NotificationRetryPolicy,
  attemptsMade: number,
  failedAt: string,
): string {
  const delayMs = nextRetryDelayMs(policy, attemptsMade);
  return new Date(Date.parse(failedAt) + delayMs).toISOString();
}

/** Evaluate a failure against a policy (single decision entry point). */
export function decideRetry(
  policy: NotificationRetryPolicy | undefined,
  error: NotificationError,
  attemptsMade: number,
  failedAt: string,
): RetryDecision {
  if (policy === undefined) {
    return { retryable: false, reason: "no_policy" };
  }
  if (attemptsMade >= policy.maxRetries + 1) {
    return { retryable: false, reason: "budget_exhausted" };
  }
  if (policy.retryableCodes !== undefined && !policy.retryableCodes.includes(error.code)) {
    return { retryable: false, reason: "code_not_retryable" };
  }
  const delayMs = nextRetryDelayMs(policy, attemptsMade);
  return {
    retryable: true,
    delayMs,
    nextRetryAt: new Date(Date.parse(failedAt) + delayMs).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Dead letter store.
// ─────────────────────────────────────────────────────────────

/** Options accepted by the {@link DeadLetterStore} constructor. */
export interface DeadLetterStoreOptions {
  readonly entries?: readonly NotificationFailure[];
}

/** Statistics of the dead letter store. */
export interface DeadLetterStatistics {
  readonly total: number;
  /** Entries that have been manually replayed. */
  readonly replayed: number;
  /** Entries whose notification is still dead (not replayed). */
  readonly pending: number;
  readonly byChannel: Readonly<Record<NotificationChannelType, number>>;
}

/** A point-in-time snapshot of the store. */
export interface DeadLetterSnapshot {
  readonly at: string;
  readonly entries: readonly NotificationFailure[];
  readonly statistics: DeadLetterStatistics;
}

/** Per-channel counts. */
function deadLetterByChannel(entries: readonly NotificationFailure[]): Readonly<
  Record<NotificationChannelType, number>
> {
  const counts: Record<NotificationChannelType, number> = {
    email: 0,
    discord: 0,
    telegram: 0,
    webhook: 0,
    push: 0,
    inapp: 0,
    mock: 0,
  };
  for (const entry of entries) {
    if (entry.channel !== undefined) counts[entry.channel] += 1;
  }
  return Object.freeze(counts);
}

/**
 * An immutable dead-letter store (successor pattern). Holds durable
 * `NotificationFailure` records; supports add, remove, replay, replayAll,
 * cleanup, statistics and snapshots.
 */
export class DeadLetterStore {
  readonly entries: readonly NotificationFailure[];

  constructor(options: DeadLetterStoreOptions = {}) {
    this.entries = Object.freeze([...(options.entries ?? [])].map(cloneFailure));
  }

  /** Build a successor store over `entries`. */
  private next(entries: readonly NotificationFailure[]): DeadLetterStore {
    return new DeadLetterStore({ entries });
  }

  /** Number of stored entries. */
  count(): number {
    return this.entries.length;
  }

  /** The entry with `failureId`, or `undefined` (detached copy). */
  find(failureId: string): NotificationFailure | undefined {
    const entry = this.entries.find((candidate) => candidate.id === failureId);
    return entry === undefined ? undefined : cloneFailure(entry);
  }

  /** Every entry for `notificationId` (detached copies). */
  findByNotification(notificationId: string): NotificationFailure[] {
    return this.entries
      .filter((entry) => entry.notificationId === notificationId)
      .map(cloneFailure);
  }

  /** Whether the store holds an entry for `notificationId`. */
  hasNotification(notificationId: string): boolean {
    return this.entries.some((entry) => entry.notificationId === notificationId);
  }

  /** Return a successor store with `entry` stored (no duplicates by id). */
  add(entry: NotificationFailure): {
    store: DeadLetterStore;
    entry: NotificationFailure;
  } {
    if (this.entries.some((candidate) => candidate.id === entry.id)) {
      throw new Error(`Dead letter store already contains "${entry.id}"`);
    }
    const stored = cloneFailure(entry);
    return { store: this.next([...this.entries, stored]), entry: stored };
  }

  /** Return a successor store without the entry `failureId`. */
  remove(failureId: string): DeadLetterStore {
    if (!this.entries.some((entry) => entry.id === failureId)) return this;
    return this.next(this.entries.filter((entry) => entry.id !== failureId));
  }

  /** Remove every entry for `notificationId`. */
  removeNotification(notificationId: string): DeadLetterStore {
    if (!this.hasNotification(notificationId)) return this;
    return this.next(
      this.entries.filter((entry) => entry.notificationId !== notificationId),
    );
  }

  /** Remove every entry whose notification is in `notificationIds`. */
  removeNotificationEach(notificationIds: readonly string[]): DeadLetterStore {
    if (notificationIds.length === 0) return this;
    const removed = new Set(notificationIds);
    return this.next(this.entries.filter((entry) => !removed.has(entry.notificationId)));
  }

  /**
   * Manually replay one entry: remove it (the notification is re-queued by
   * the caller). Returns the successor store plus the replayed entry.
   */
  replay(failureId: string): { store: DeadLetterStore; entry: NotificationFailure } {
    const entry = this.find(failureId);
    if (entry === undefined) {
      throw new Error(`Dead letter entry not found: ${failureId}`);
    }
    return { store: this.remove(failureId), entry };
  }

  /**
   * Replay every entry for `notificationId` at once (manual replay of a
   * whole notification). Returns the successor store plus the replayed
   * entries.
   */
  replayNotification(notificationId: string): {
    store: DeadLetterStore;
    entries: NotificationFailure[];
  } {
    const targets = this.findByNotification(notificationId);
    if (targets.length === 0) return { store: this, entries: [] };
    return { store: this.removeNotification(notificationId), entries: targets };
  }

  /**
   * Replay every entry whose failure is older than `retentionMs` at `now`
   * (automatic replay). Returns the successor store plus replayed entries.
   */
  replayOlderThan(now: string, retentionMs: number): {
    store: DeadLetterStore;
    entries: NotificationFailure[];
  } {
    const cutoff = Date.parse(now) - retentionMs;
    const targets = this.entries.filter((entry) => Date.parse(entry.at) < cutoff);
    if (targets.length === 0) return { store: this, entries: [] };
    const targetIds = new Set(targets.map((entry) => entry.id));
    return {
      store: this.next(this.entries.filter((entry) => !targetIds.has(entry.id))),
      entries: targets.map(cloneFailure),
    };
  }

  /**
   * Cleanup: remove entries whose failure is older than `retentionMs` at
   * `now` (they are expired, not replayed). Returns the successor store and
   * the expired entries.
   */
  cleanup(now: string, retentionMs: number): {
    store: DeadLetterStore;
    entries: NotificationFailure[];
  } {
    const cutoff = Date.parse(now) - retentionMs;
    const expired = this.entries.filter((entry) => Date.parse(entry.at) < cutoff);
    if (expired.length === 0) return { store: this, entries: [] };
    const expiredIds = new Set(expired.map((entry) => entry.id));
    return {
      store: this.next(this.entries.filter((entry) => !expiredIds.has(entry.id))),
      entries: expired.map(cloneFailure),
    };
  }

  /** Every entry as detached copies, oldest first. */
  list(): NotificationFailure[] {
    return [...this.entries]
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
      .map(cloneFailure);
  }

  /** Deterministic statistics. */
  statistics(): DeadLetterStatistics {
    return Object.freeze({
      total: this.entries.length,
      replayed: 0,
      pending: this.entries.length,
      byChannel: deadLetterByChannel(this.entries),
    });
  }

  /** Point-in-time snapshot at `at`. */
  snapshot(at: string): DeadLetterSnapshot {
    return Object.freeze({
      at,
      entries: this.list(),
      statistics: this.statistics(),
    });
  }

  /** Deterministic hash of the store contents. */
  hash(): string {
    return hashString(this.entries.map((entry) => entry.id).join(":"));
  }
}

/** Build a fresh dead letter store. */
export function createDeadLetterStore(
  options: DeadLetterStoreOptions = {},
): DeadLetterStore {
  return new DeadLetterStore(options);
}

// ─────────────────────────────────────────────────────────────
// Retry manager.
// ─────────────────────────────────────────────────────────────

/** Per-notification retry state. */
export interface NotificationRetryState {
  readonly notificationId: string;
  /** Attempts made so far (including the failures recorded). */
  readonly attempts: number;
  /** Failures recorded, oldest first. */
  readonly failures: readonly NotificationFailure[];
  /** The most recent failure detail. */
  readonly lastError?: NotificationError;
  /** Whether the notification is currently scheduled for a retry. */
  readonly pending: boolean;
}

/** Options accepted by the {@link RetryManager} constructor. */
export interface RetryManagerOptions {
  readonly policy?: NotificationRetryPolicy;
  readonly states?: readonly NotificationRetryState[];
}

/** Build an empty retry state for a notification. */
export function createNotificationRetryState(
  notificationId: string,
): NotificationRetryState {
  return Object.freeze({
    notificationId,
    attempts: 0,
    failures: Object.freeze([]),
    pending: false,
  });
}

/** Aggregate statistics of the retry manager. */
export interface RetryManagerStatistics {
  readonly total: number;
  readonly pending: number;
  readonly dead: number;
  /** Total recorded failures. */
  readonly failures: number;
}

/** Point-in-time snapshot of the retry manager. */
export interface RetryManagerSnapshot {
  readonly at: string;
  readonly states: readonly NotificationRetryState[];
  readonly statistics: RetryManagerStatistics;
}

/**
 * Successor-based per-notification retry bookkeeping. `recordFailure`
 * evaluates the policy, appends the failure, and reports whether the
 * notification should be scheduled for a retry or marked dead. No timers,
 * no wall clock — `now` is caller-supplied.
 */
export class RetryManager {
  /** The configured retry policy. */
  readonly policy: NotificationRetryPolicy;
  /** The per-notification states (frozen). */
  readonly states: ReadonlyMap<string, NotificationRetryState>;

  constructor(options: RetryManagerOptions = {}) {
    this.policy = options.policy ?? { maxRetries: 0, backoffMs: 0 };
    const map = new Map<string, NotificationRetryState>();
    for (const state of options.states ?? []) {
      map.set(state.notificationId, freezeRetryState(state));
    }
    this.states = map;
  }

  /** Build a successor manager from partial state. */
  private next(states: ReadonlyMap<string, NotificationRetryState>): RetryManager {
    return new RetryManager({ policy: this.policy, states: [...states.values()] });
  }

  /** The retry state for `notificationId`, or an empty default. */
  state(notificationId: string): NotificationRetryState | undefined {
    const state = this.states.get(notificationId);
    return state === undefined ? undefined : cloneRetryState(state);
  }

  /** Whether a notification has any recorded retry state. */
  has(notificationId: string): boolean {
    return this.states.has(notificationId);
  }

  /** Number of tracked notifications. */
  count(): number {
    return this.states.size;
  }

  /**
   * Record a failure of `notificationId` and evaluate the policy. Returns
   * the successor manager plus the decision:
   * - `retry: true` → the notification should be scheduled for
   *   `nextRetryAt`;
   * - `retry: false` → the notification is dead (`dead: true`) and should
   *   be dead-lettered with the recorded failure.
   */
  recordFailure(input: {
    readonly notificationId: string;
    readonly attempt: number;
    readonly at: string;
    readonly channel?: NotificationChannelType;
    readonly error: NotificationError;
    readonly deliveryId?: string;
  }): {
    manager: RetryManager;
    failure: NotificationFailure;
    decision: RetryDecision;
    dead: boolean;
  } {
    const previous = this.states.get(input.notificationId);
    const attempts = Math.max(input.attempt, (previous?.attempts ?? 0) + 1);
    const failure = createNotificationFailure({
      notificationId: input.notificationId,
      deliveryId: input.deliveryId,
      attempt: attempts,
      at: input.at,
      channel: input.channel,
      error: input.error,
    });
    const decision = decideRetry(this.policy, input.error, attempts, input.at);
    const state: NotificationRetryState = Object.freeze({
      notificationId: input.notificationId,
      attempts,
      failures: Object.freeze([...(previous?.failures ?? []), cloneFailure(failure)]),
      lastError: Object.freeze({ ...input.error }),
      pending: decision.retryable,
    });
    const nextStates = new Map(this.states);
    nextStates.set(input.notificationId, state);
    return {
      manager: this.next(nextStates),
      failure,
      decision,
      dead: !decision.retryable,
    };
  }

  /** Reset the retry state of `notificationId` (e.g. after a success). */
  reset(notificationId: string): RetryManager {
    if (!this.states.has(notificationId)) return this;
    const nextStates = new Map(this.states);
    nextStates.delete(notificationId);
    return this.next(nextStates);
  }

  /**
   * Manually replay a dead notification: clear its state so it may be
   * re-queued from scratch. Returns the successor manager and the cleared
   * state.
   */
  replay(notificationId: string): {
    manager: RetryManager;
    state?: NotificationRetryState;
  } {
    const previous = this.states.get(notificationId);
    if (previous === undefined) return { manager: this };
    const nextStates = new Map(this.states);
    nextStates.delete(notificationId);
    return { manager: this.next(nextStates), state: cloneRetryState(previous) };
  }

  /** Mark a notification as no longer pending a retry (e.g. cancelled). */
  clearPending(notificationId: string): RetryManager {
    const previous = this.states.get(notificationId);
    if (previous === undefined || !previous.pending) return this;
    const state: NotificationRetryState = Object.freeze({
      ...previous,
      pending: false,
    });
    const nextStates = new Map(this.states);
    nextStates.set(notificationId, state);
    return this.next(nextStates);
  }

  /** Detached copies of every tracked state, in insertion order. */
  list(): NotificationRetryState[] {
    return [...this.states.values()].map(cloneRetryState);
  }

  /** Aggregate statistics. */
  statistics(): RetryManagerStatistics {
    const states = [...this.states.values()];
    return Object.freeze({
      total: states.length,
      pending: states.filter((state) => state.pending).length,
      dead: states.filter((state) => !state.pending && state.failures.length > 0).length,
      failures: states.reduce((total, state) => total + state.failures.length, 0),
    });
  }

  /** Point-in-time snapshot at `at`. */
  snapshot(at: string): RetryManagerSnapshot {
    return Object.freeze({
      at,
      states: this.list(),
      statistics: this.statistics(),
    });
  }
}

/** Build a fresh retry manager (dependency-injected policy). */
export function createRetryManager(
  options: RetryManagerOptions = {},
): RetryManager {
  return new RetryManager(options);
}

// ─────────────────────────────────────────────────────────────
// Internal helpers.
// ─────────────────────────────────────────────────────────────

/** Detached copy of a failure record. */
function cloneFailure(failure: NotificationFailure): NotificationFailure {
  return {
    id: failure.id,
    notificationId: failure.notificationId,
    ...(failure.deliveryId !== undefined ? { deliveryId: failure.deliveryId } : {}),
    attempt: failure.attempt,
    at: failure.at,
    ...(failure.channel !== undefined ? { channel: failure.channel } : {}),
    error: { ...failure.error },
  };
}

/** Detached copy of a retry state. */
function cloneRetryState(state: NotificationRetryState): NotificationRetryState {
  return Object.freeze({
    notificationId: state.notificationId,
    attempts: state.attempts,
    failures: Object.freeze(state.failures.map(cloneFailure)),
    ...(state.lastError !== undefined ? { lastError: { ...state.lastError } } : {}),
    pending: state.pending,
  });
}

/** Deep-freeze a retry state in place. */
function freezeRetryState(state: NotificationRetryState): NotificationRetryState {
  for (const failure of state.failures) Object.freeze(failure);
  Object.freeze(state.failures);
  if (state.lastError !== undefined) Object.freeze(state.lastError);
  return Object.freeze(state);
}
