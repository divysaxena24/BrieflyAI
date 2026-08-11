/**
 * Phase 6D STEP 7 — retry & dead letter tests.
 */
import { describe, expect, it } from "vitest";
import {
  shouldRetry,
  decideRetry,
  nextRetryDelayMs,
  nextRetryAt,
  createRetryManager,
  createDeadLetterStore,
  createNotificationRetryState,
} from "@/lib/notifications/retry";
import {
  createNotificationRetryPolicy,
  createNotificationFailure,
} from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

const transient = { code: "timeout", message: "slow", retryable: true };
const permanent = { code: "validation_failed", message: "bad", retryable: false };

describe("shouldRetry", () => {
  it("returns false without a policy", () => {
    expect(shouldRetry(undefined, transient, 1)).toBe(false);
  });

  it("honours the max retry budget", () => {
    const policy = createNotificationRetryPolicy({ maxRetries: 2, backoffMs: 1000 });
    expect(shouldRetry(policy, transient, 1)).toBe(true);
    expect(shouldRetry(policy, transient, 2)).toBe(true);
    expect(shouldRetry(policy, transient, 3)).toBe(false);
  });

  it("respects explicit retryable codes", () => {
    const policy = createNotificationRetryPolicy({
      maxRetries: 1,
      backoffMs: 1000,
      retryableCodes: ["timeout"],
    });
    expect(shouldRetry(policy, transient, 1)).toBe(true);
    expect(shouldRetry(policy, permanent, 1)).toBe(false);
  });

  it("defaults to retryable when no codes and not marked permanent", () => {
    const policy = createNotificationRetryPolicy({ maxRetries: 1, backoffMs: 1000 });
    expect(shouldRetry(policy, { code: "provider_error", message: "x" }, 1)).toBe(true);
    expect(shouldRetry(policy, permanent, 1)).toBe(false);
  });

  it("a zero-retry policy never retries", () => {
    const policy = createNotificationRetryPolicy();
    expect(shouldRetry(policy, transient, 1)).toBe(false);
  });
});

describe("backoff", () => {
  it("computes exponential backoff with the shared helper", () => {
    const policy = createNotificationRetryPolicy({ maxRetries: 3, backoffMs: 1000 });
    expect(nextRetryDelayMs(policy, 1)).toBe(1000);
    expect(nextRetryDelayMs(policy, 2)).toBe(2000);
    expect(nextRetryDelayMs(policy, 3)).toBe(4000);
  });

  it("caps the backoff at maxDelayMs", () => {
    const policy = createNotificationRetryPolicy({ maxRetries: 5, backoffMs: 1000, maxDelayMs: 3000 });
    expect(nextRetryDelayMs(policy, 4)).toBe(3000);
  });

  it("derives the next retry timestamp from the failure time", () => {
    const policy = createNotificationRetryPolicy({ maxRetries: 2, backoffMs: 1000 });
    expect(nextRetryAt(policy, 1, NOW)).toBe("2026-08-11T09:00:01.000Z");
  });

  it("nextRetryAt is deterministic", () => {
    const policy = createNotificationRetryPolicy({ maxRetries: 2, backoffMs: 500 });
    expect(nextRetryAt(policy, 2, NOW)).toBe(nextRetryAt(policy, 2, NOW));
  });
});

describe("decideRetry", () => {
  it("decides retry with delay and next timestamp", () => {
    const policy = createNotificationRetryPolicy({ maxRetries: 1, backoffMs: 1000 });
    const decision = decideRetry(policy, transient, 1, NOW);
    expect(decision.retryable).toBe(true);
    expect(decision.delayMs).toBe(1000);
    expect(decision.nextRetryAt).toBe("2026-08-11T09:00:01.000Z");
  });

  it("reports budget exhaustion", () => {
    const policy = createNotificationRetryPolicy({ maxRetries: 0, backoffMs: 1000 });
    const decision = decideRetry(policy, transient, 1, NOW);
    expect(decision.retryable).toBe(false);
    expect(decision.reason).toBe("budget_exhausted");
  });

  it("reports no-policy", () => {
    expect(decideRetry(undefined, transient, 1, NOW).reason).toBe("no_policy");
  });

  it("reports non-retryable codes", () => {
    const policy = createNotificationRetryPolicy({
      maxRetries: 2,
      backoffMs: 1000,
      retryableCodes: ["timeout"],
    });
    expect(decideRetry(policy, permanent, 1, NOW).reason).toBe("code_not_retryable");
  });
});

describe("RetryManager", () => {
  const manager = () =>
    createRetryManager({ policy: createNotificationRetryPolicy({ maxRetries: 2, backoffMs: 1000 }) });

  it("starts empty with the injected policy", () => {
    const m = manager();
    expect(m.count()).toBe(0);
    expect(m.has("n1")).toBe(false);
    expect(m.statistics().total).toBe(0);
  });

  it("records a failure and schedules a retry within budget", () => {
    const m = manager();
    const { manager: next, failure, decision, dead } = m.recordFailure({
      notificationId: "n1",
      attempt: 1,
      at: NOW,
      channel: "email",
      error: transient,
    });
    expect(dead).toBe(false);
    expect(decision.retryable).toBe(true);
    expect(failure.attempt).toBe(1);
    expect(next.has("n1")).toBe(true);
    expect(next.state("n1")?.pending).toBe(true);
    expect(next.state("n1")?.attempts).toBe(1);
  });

  it("tracks attempt growth across failures", () => {
    let m = manager();
    ({ manager: m } = m.recordFailure({ notificationId: "n1", attempt: 1, at: NOW, error: transient }));
    ({ manager: m } = m.recordFailure({ notificationId: "n1", attempt: 2, at: LATER, error: transient }));
    expect(m.state("n1")?.attempts).toBe(2);
    expect(m.state("n1")?.failures).toHaveLength(2);
  });

  it("marks dead when the budget is exhausted", () => {
    const m = manager();
    const { manager: next, dead, decision } = m.recordFailure({
      notificationId: "n1",
      attempt: 3,
      at: NOW,
      error: transient,
    });
    expect(dead).toBe(true);
    expect(decision.retryable).toBe(false);
    expect(next.state("n1")?.pending).toBe(false);
  });

  it("records the failure with a deterministic id", () => {
    const m = manager();
    const { failure } = m.recordFailure({ notificationId: "n1", attempt: 1, at: NOW, error: transient });
    expect(failure.id).toBe(
      createNotificationFailure({ notificationId: "n1", attempt: 1, at: NOW, error: transient }).id,
    );
    expect(Object.isFrozen(failure.error)).toBe(true);
  });

  it("reset clears a tracked notification", () => {
    let m = manager();
    ({ manager: m } = m.recordFailure({ notificationId: "n1", attempt: 1, at: NOW, error: transient }));
    const next = m.reset("n1");
    expect(next.has("n1")).toBe(false);
    expect(m.has("n1")).toBe(true);
  });

  it("replay clears dead state for a fresh attempt", () => {
    let m = manager();
    ({ manager: m } = m.recordFailure({ notificationId: "n1", attempt: 3, at: NOW, error: transient }));
    const { manager: next, state } = m.replay("n1");
    expect(state?.attempts).toBe(3);
    expect(next.has("n1")).toBe(false);
  });

  it("replay of an unknown notification is a no-op", () => {
    const m = manager();
    const { manager: next, state } = m.replay("nope");
    expect(state).toBeUndefined();
    expect(next).toBe(m);
  });

  it("clearPending clears only the pending flag", () => {
    let m = manager();
    ({ manager: m } = m.recordFailure({ notificationId: "n1", attempt: 1, at: NOW, error: transient }));
    const next = m.clearPending("n1");
    expect(next.state("n1")?.pending).toBe(false);
    expect(next.state("n1")?.failures).toHaveLength(1);
  });

  it("statistics aggregate pending/dead/failures", () => {
    let m = manager();
    ({ manager: m } = m.recordFailure({ notificationId: "n1", attempt: 1, at: NOW, error: transient }));
    ({ manager: m } = m.recordFailure({ notificationId: "n2", attempt: 1, at: NOW, error: transient }));
    ({ manager: m } = m.recordFailure({ notificationId: "n2", attempt: 2, at: NOW, error: transient }));
    const stats = m.statistics();
    expect(stats.total).toBe(2);
    expect(stats.pending).toBe(2);
    expect(stats.failures).toBe(3);
  });

  it("snapshot is frozen and detached", () => {
    const m = manager();
    const snapshot = m.snapshot(NOW);
    expect(snapshot.at).toBe(NOW);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.states).toEqual([]);
  });

  it("mutations are successor-based", () => {
    const m = manager();
    const { manager: next } = m.recordFailure({ notificationId: "n1", attempt: 1, at: NOW, error: transient });
    expect(m.has("n1")).toBe(false);
    expect(next.has("n1")).toBe(true);
  });

  it("createNotificationRetryState builds an empty state", () => {
    const state = createNotificationRetryState("n1");
    expect(state.attempts).toBe(0);
    expect(state.pending).toBe(false);
    expect(Object.isFrozen(state)).toBe(true);
  });
});

describe("DeadLetterStore", () => {
  const failure = (notificationId: string, at = NOW) =>
    createNotificationFailure({
      notificationId,
      attempt: 2,
      at,
      channel: "email",
      error: transient,
    });

  it("adds entries and rejects duplicates", () => {
    const store = createDeadLetterStore();
    const { store: next } = store.add(failure("n1"));
    expect(next.count()).toBe(1);
    expect(() => next.add(failure("n1"))).toThrow(/already contains/);
  });

  it("finds entries by id and notification", () => {
    const store = createDeadLetterStore().add(failure("n1")).store;
    expect(store.find(failure("n1").id)?.notificationId).toBe("n1");
    expect(store.findByNotification("n1")).toHaveLength(1);
    expect(store.hasNotification("n1")).toBe(true);
  });

  it("removes entries and notifications", () => {
    const store = createDeadLetterStore({ entries: [failure("n1"), failure("n2", LATER)] });
    const afterRemove = store.remove(failure("n1").id);
    expect(afterRemove.count()).toBe(1);
    const afterNotification = store.removeNotification("n1");
    expect(afterNotification.count()).toBe(1);
    expect(afterNotification.hasNotification("n1")).toBe(false);
  });

  it("remove is a no-op for absent ids", () => {
    const store = createDeadLetterStore();
    expect(store.remove("missing")).toBe(store);
  });

  it("replay removes a single entry and returns it", () => {
    const store = createDeadLetterStore().add(failure("n1")).store;
    const { store: next, entry } = store.replay(failure("n1").id);
    expect(entry.notificationId).toBe("n1");
    expect(next.count()).toBe(0);
  });

  it("replay throws for unknown ids", () => {
    const store = createDeadLetterStore();
    expect(() => store.replay("missing")).toThrow(/not found/);
  });

  it("replayNotification removes every entry of a notification", () => {
    const store = createDeadLetterStore({ entries: [failure("n1"), failure("n1", LATER), failure("n2")] });
    const { store: next, entries } = store.replayNotification("n1");
    expect(entries).toHaveLength(2);
    expect(next.count()).toBe(1);
    expect(next.hasNotification("n2")).toBe(true);
  });

  it("replayOlderThan replays expired entries", () => {
    const store = createDeadLetterStore({ entries: [failure("old", "2026-08-01T00:00:00.000Z"), failure("new", NOW)] });
    const { store: next, entries } = store.replayOlderThan(NOW, 7 * 24 * 60 * 60 * 1000);
    expect(entries).toHaveLength(1);
    expect(next.count()).toBe(1);
  });

  it("cleanup removes expired entries", () => {
    const store = createDeadLetterStore({ entries: [failure("old", "2026-08-01T00:00:00.000Z"), failure("new", NOW)] });
    const { store: next, entries } = store.cleanup(NOW, 7 * 24 * 60 * 60 * 1000);
    expect(entries).toHaveLength(1);
    expect(next.count()).toBe(1);
    expect(next.hasNotification("new")).toBe(true);
  });

  it("cleanup is a no-op when nothing is expired", () => {
    const store = createDeadLetterStore({ entries: [failure("n1", NOW)] });
    const { store: next, entries } = store.cleanup(NOW, 60_000);
    expect(entries).toHaveLength(0);
    expect(next).toBe(store);
  });

  it("list returns entries oldest first", () => {
    const store = createDeadLetterStore({ entries: [failure("b", LATER), failure("a", NOW)] });
    expect(store.list().map((entry) => entry.notificationId)).toEqual(["a", "b"]);
  });

  it("statistics count by channel", () => {
    const store = createDeadLetterStore({ entries: [failure("n1"), failure("n2", LATER)] });
    const stats = store.statistics();
    expect(stats.total).toBe(2);
    expect(stats.pending).toBe(2);
    expect(stats.byChannel.email).toBe(2);
  });

  it("snapshot is frozen", () => {
    const store = createDeadLetterStore().add(failure("n1")).store;
    const snapshot = store.snapshot(NOW);
    expect(snapshot.at).toBe(NOW);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.entries).toHaveLength(1);
  });

  it("hash is deterministic and content-sensitive", () => {
    const a = createDeadLetterStore({ entries: [failure("n1")] });
    const b = createDeadLetterStore({ entries: [failure("n1")] });
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).not.toBe(createDeadLetterStore({ entries: [failure("n2")] }).hash());
  });

  it("returns detached copies", () => {
    const store = createDeadLetterStore().add(failure("n1")).store;
    const entry = store.find(failure("n1").id);
    if (entry?.error !== undefined) entry.error.message = "mutated";
    expect(store.find(failure("n1").id)?.error.message).toBe("slow");
  });
});
