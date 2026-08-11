/**
 * Phase 6D STEP 10 — notification background (worker integration) tests.
 */
import { describe, expect, it } from "vitest";
import {
  createNotificationBackgroundEngine,
  NotificationBackgroundEngine,
} from "@/lib/notifications/background";
import {
  NotificationDeliveryEngine,
  type NotificationSendInput,
} from "@/lib/notifications/delivery";
import {
  createEmailChannel,
  createInAppChannel,
  createMockChannel,
  createNotificationChannelRegistry,
  type NotificationTransport,
  type NotificationTransportInput,
} from "@/lib/notifications/channels";
import {
  createNotificationConfiguration,
  createNotificationRecipient,
  createNotificationRetryPolicy,
} from "@/lib/notifications/types";
import { NotificationPreferenceEngine } from "@/lib/notifications/preferences";

const NOW = "2026-08-11T09:00:00.000Z";
const NOW_1S = "2026-08-11T09:00:01.000Z";
const NOW_1M = "2026-08-11T09:01:00.000Z";
const NOW_1D = "2026-08-12T09:00:00.000Z";

/** A scriptable mock transport. */
class ScriptedTransport implements NotificationTransport {
  private readonly records: NotificationTransportInput[] = [];
  constructor(
    private readonly script: (input: NotificationTransportInput) => {
      ok: boolean;
      message?: string;
      error?: { code: string; message: string; retryable?: boolean };
    },
  ) {}

  async send(input: NotificationTransportInput) {
    this.records.push(input);
    const outcome = this.script(input);
    return outcome;
  }

  sent(): NotificationTransportInput[] {
    return [...this.records];
  }
}

function okTransport(): ScriptedTransport {
  return new ScriptedTransport(() => ({ ok: true, message: "ok" }));
}

function failTransport(code: string, retryable = true): ScriptedTransport {
  return new ScriptedTransport(() => ({
    ok: false,
    error: { code, message: `boom:${code}`, retryable },
  }));
}

/** A channel registry (email + inapp + mock) over one transport. */
function channelsFor(transport: NotificationTransport) {
  return createNotificationChannelRegistry({
    channels: [
      createEmailChannel({ transport }),
      createInAppChannel({ transport }),
      createMockChannel({ transport }),
    ],
  });
}

/** Standard send input (single email recipient). */
function sendInput(overrides: Partial<NotificationSendInput> = {}): NotificationSendInput {
  return {
    title: "Hello",
    body: "World",
    recipients: [createNotificationRecipient({ channel: "email", address: "user@example.com" })],
    ...overrides,
  };
}

/** Build a delivery engine over the given transport. */
function deliveryWith(
  transport: NotificationTransport,
  retryMax?: number,
): NotificationDeliveryEngine {
  return new NotificationDeliveryEngine({
    channels: channelsFor(transport),
    config: createNotificationConfiguration({
      retryPolicy:
        retryMax === undefined
          ? undefined
          : createNotificationRetryPolicy({ maxRetries: retryMax, backoffMs: 1000 }),
    }),
    now: () => NOW,
    clockMs: () => 0,
  });
}

/** Build a background engine with all sub-engines injected. */
function backgroundWith(
  transport: NotificationTransport,
  options: { retryMax?: number } = {},
): NotificationBackgroundEngine {
  return createNotificationBackgroundEngine({
    delivery: deliveryWith(transport, options.retryMax),
    now: () => NOW,
  });
}

describe("NotificationBackgroundEngine construction", () => {
  it("builds a fresh engine with empty sub-engines", () => {
    const engine = new NotificationBackgroundEngine({ now: () => NOW });
    expect(engine.delivery.count()).toBe(0);
    expect(engine.preferences.listPreferences()).toHaveLength(0);
    expect(engine.monitoring.queueDepth()).toEqual({
      pending: 0,
      delayed: 0,
      retry: 0,
      deadLetter: 0,
    });
  });

  it("exposes the injected delivery and preference engines", () => {
    const delivery = deliveryWith(okTransport());
    const preferences = new NotificationPreferenceEngine();
    const engine = createNotificationBackgroundEngine({ delivery, preferences, now: () => NOW });
    expect(engine.delivery).toBe(delivery);
    expect(engine.preferences).toBe(preferences);
  });
});

describe("runDispatch (scheduled + retry jobs)", () => {
  it("dispatches a scheduled notification when due", async () => {
    const engine = backgroundWith(okTransport());
    const result = await engine.delivery.send(sendInput({ scheduledAt: NOW_1M }), NOW);
    expect(engine.delivery.find(result.notification.id)?.status).toBe("queued");

    const { engine: next, summary } = await nextRunDispatch(engine, NOW_1M);
    expect(next.delivery.find(result.notification.id)?.status).toBe("delivered");
    expect(summary.attempted).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(summary.at).toBe(NOW_1M);
  });

  it("reports an empty summary when nothing is due", async () => {
    const engine = backgroundWith(okTransport());
    const { summary } = await nextRunDispatch(engine, NOW);
    expect(summary.attempted).toBe(0);
    expect(summary.delivered).toBe(0);
    expect(summary.receipts).toBe(0);
  });

  it("dispatches retried notifications on the retry job", async () => {
    const engine = backgroundWith(failTransport("provider_error", true), { retryMax: 1 });
    await engine.delivery.send(sendInput({ id: "retry-bg" }), NOW);
    expect(engine.delivery.find("retry-bg")?.status).toBe("queued");
    // Retry job: dispatch due at NOW + 1s (backoff 1000ms).
    const { engine: next } = await nextRunDispatch(engine, NOW_1S);
    // Budget exhausted on the second attempt → dead-lettered.
    expect(next.delivery.find("retry-bg")?.status).toBe("dead");
    expect(next.delivery.deadLetters.hasNotification("retry-bg")).toBe(true);
  });

  it("records the queue depth after dispatch", async () => {
    const engine = backgroundWith(okTransport());
    await engine.delivery.send(sendInput({ id: "q-1", scheduledAt: NOW_1M }), NOW);
    await nextRunDispatch(engine, NOW);
    // Nothing due yet: pending stays empty.
    expect(engine.monitoring.queueDepth()).toEqual({
      pending: 0,
      delayed: 1,
      retry: 0,
      deadLetter: 0,
    });
  });
});

describe("runReplay (dead-letter replay job)", () => {
  it("replays dead-lettered notifications into the queue", async () => {
    const engine = backgroundWith(failTransport("provider_error", true), { retryMax: 1 });
    await engine.delivery.send(sendInput({ id: "dead-1" }), NOW);
    await engine.delivery.dispatchDue(NOW_1S);
    expect(engine.delivery.find("dead-1")?.status).toBe("dead");
    expect(engine.delivery.deadLetters.count()).toBe(1);

    const { engine: next, replayed, remaining } = await engine.runReplay(NOW_1S);
    expect(replayed).toEqual(["dead-1"]);
    expect(remaining).toBe(0);
    expect(next.delivery.find("dead-1")?.status).toBe("queued");
    expect(next.delivery.deadLetters.count()).toBe(0);
  });

  it("reports no-op when there is nothing to replay", async () => {
    const engine = backgroundWith(okTransport());
    const { replayed, remaining } = await engine.runReplay(NOW);
    expect(replayed).toEqual([]);
    expect(remaining).toBe(0);
  });

  it("replays each dead-lettered notification once", async () => {
    const engine = backgroundWith(failTransport("provider_error", true), { retryMax: 1 });
    await engine.delivery.send(sendInput({ id: "d-1" }), NOW);
    await engine.delivery.send(sendInput({ id: "d-2" }), NOW);
    await engine.delivery.dispatchDue(NOW_1S);
    expect(engine.delivery.deadLetters.count()).toBe(2);
    const { replayed, remaining } = await engine.runReplay(NOW_1S);
    expect(replayed.sort()).toEqual(["d-1", "d-2"]);
    expect(remaining).toBe(0);
  });
});

describe("runBatch (batch-delivery job)", () => {
  it("delivers a batch of notifications", async () => {
    const engine = backgroundWith(okTransport());
    const inputs = Array.from({ length: 4 }, (_, index) =>
      sendInput({ id: `batch-${index}`, title: `T${index}` }),
    );
    const { engine: next, sent, failed } = await engine.runBatch(inputs, NOW);
    expect(next.delivery.count()).toBe(4);
    expect(sent).toBe(4);
    expect(failed).toBe(0);
  });

  it("isolates failing inputs inside the batch", async () => {
    const engine = backgroundWith(okTransport());
    const bad = sendInput({
      id: "bad-1",
      recipients: [createNotificationRecipient({ channel: "telegram", address: "123" })],
    });
    const good = sendInput({ id: "good-1" });
    const { engine: next, sent, failed } = await engine.runBatch([good, bad], NOW);
    expect(next.delivery.find("good-1")?.status).toBe("delivered");
    expect(next.delivery.find("bad-1")?.status).toBe("failed");
    expect(sent).toBe(1);
    expect(failed).toBe(1);
  });

  // Regression: a dead-lettered batch input counts as a failure, not a send
  // (the terminal status set is `failed` + `dead`).
  it("counts dead-lettered batch inputs as failures", async () => {
    const engine = backgroundWith(failTransport("provider_error", true));
    const { engine: next, sent, failed } = await engine.runBatch(
      [sendInput({ id: "dl-1" })],
      NOW,
    );
    expect(next.delivery.find("dl-1")?.status).toBe("dead");
    expect(sent).toBe(0);
    expect(failed).toBe(1);
  });

  it("counts only the batch's own notifications", async () => {
    const engine = backgroundWith(okTransport());
    // Pre-existing notification unrelated to the batch.
    await engine.delivery.send(sendInput({ id: "prior-1" }), NOW);
    const { engine: next, sent, failed } = await engine.runBatch(
      [sendInput({ id: "fresh-1" })],
      NOW,
    );
    expect(next.delivery.find("fresh-1")?.status).toBe("delivered");
    expect(next.delivery.count()).toBe(2);
    expect(sent).toBe(1);
    expect(failed).toBe(0);
  });
});

describe("runDigest (digest-delivery job)", () => {
  it("aggregates queued notifications of digest users into one digest", async () => {
    const engine = backgroundWith(okTransport());
    const preferences = engine.preferences;
    preferences.setDigestMode("user-1", true, NOW);
    preferences.setPreferredChannels("user-1", ["inapp"], NOW);

    await engine.delivery.schedule(
      { ...sendInput({ id: "n-1", userId: "user-1" }), schedule: { at: NOW_1M } },
      NOW,
    );
    await engine.delivery.schedule(
      { ...sendInput({ id: "n-2", userId: "user-1" }), schedule: { at: NOW_1M } },
      NOW,
    );
    expect(engine.delivery.list().filter((n) => n.status === "queued")).toHaveLength(2);

    const { engine: next, digests, aggregated, cancelled } = await engine.runDigest(NOW);
    expect(aggregated).toBe(2);
    expect(cancelled).toBe(2);
    expect(digests).toHaveLength(1);
    const digest = digests[0];
    expect(digest?.userId).toBe("user-1");
    expect(digest?.category).toBe("digest");
    expect(digest?.title).toContain("2 notifications");
    // Originals cancelled, digest delivered.
    expect(next.delivery.find("n-1")?.status).toBe("cancelled");
    expect(next.delivery.find("n-2")?.status).toBe("cancelled");
  });

  it("skips users who are not in digest mode", async () => {
    const engine = backgroundWith(okTransport());
    await engine.delivery.schedule(
      { ...sendInput({ id: "n-1", userId: "user-1" }), schedule: { at: NOW_1M } },
      NOW,
    );
    const { engine: next, digests, aggregated, cancelled } = await engine.runDigest(NOW);
    expect(digests).toHaveLength(0);
    expect(aggregated).toBe(0);
    expect(cancelled).toBe(0);
    expect(next.delivery.find("n-1")?.status).toBe("queued");
  });

  it("restricts the pass to the given userIds", async () => {
    const engine = backgroundWith(okTransport());
    const preferences = engine.preferences;
    preferences.setDigestMode("user-1", true, NOW);
    preferences.setDigestMode("user-2", true, NOW);
    preferences.setPreferredChannels("user-1", ["inapp"], NOW);
    preferences.setPreferredChannels("user-2", ["inapp"], NOW);

    await engine.delivery.schedule(
      { ...sendInput({ id: "n-1", userId: "user-1" }), schedule: { at: NOW_1M } },
      NOW,
    );
    await engine.delivery.schedule(
      { ...sendInput({ id: "n-2", userId: "user-2" }), schedule: { at: NOW_1M } },
      NOW,
    );
    const { digests } = await engine.runDigest(NOW, ["user-1"]);
    expect(digests).toHaveLength(1);
    expect(digests[0]?.userId).toBe("user-1");
  });
});

describe("runCleanup (notification-cleanup job)", () => {
  it("prunes settled notifications older than the retention window", async () => {
    const engine = backgroundWith(okTransport());
    const result = await engine.delivery.send(sendInput({ id: "old-1" }), NOW);
    expect(result.notification.status).toBe("delivered");

    const { engine: next, removed, deadLettersRemoved } = await engine.runCleanup(NOW_1D, 3600_000);
    expect(removed).toContain("old-1");
    expect(next.delivery.find("old-1")).toBeUndefined();
    expect(deadLettersRemoved).toBe(0);
  });

  it("keeps settled notifications inside the retention window", async () => {
    const engine = backgroundWith(okTransport());
    await engine.delivery.send(sendInput({ id: "fresh-1" }), NOW);
    const { engine: next, removed } = await engine.runCleanup(NOW_1D, 7 * 24 * 3600_000);
    expect(removed).toEqual([]);
    expect(next.delivery.find("fresh-1")?.status).toBe("delivered");
  });

  it("prunes a dead-lettered notification together with its dead-letter record", async () => {
    const engine = backgroundWith(failTransport("provider_error", true), { retryMax: 1 });
    await engine.delivery.send(sendInput({ id: "dl-1" }), NOW);
    await engine.delivery.dispatchDue(NOW_1S);
    expect(engine.delivery.deadLetters.count()).toBe(1);
    const { engine: next, removed } = await engine.runCleanup(NOW_1D, 0);
    expect(removed).toContain("dl-1");
    expect(next.delivery.find("dl-1")).toBeUndefined();
    expect(next.delivery.deadLetters.count()).toBe(0);
  });
});

describe("runAll (full background pipeline)", () => {
  it("runs dispatch, replay, digest and cleanup in one pass", async () => {
    const engine = backgroundWith(okTransport());
    await engine.delivery.send(sendInput({ id: "due-1", scheduledAt: NOW_1S }), NOW);
    const { summary } = await engine.runAll(NOW_1S);
    expect(summary.at).toBe(NOW_1S);
    expect(summary.dispatched).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.replayed).toBe(0);
    expect(summary.digestsSent).toBe(0);
    expect(summary.cleaned).toBe(0);
  });

  it("replays existing dead letters inside the pass", async () => {
    const engine = backgroundWith(failTransport("provider_error", true), { retryMax: 1 });
    // Create a dead letter before the pass: send fails, retry at NOW+1s
    // exhausts the budget on the first dispatch.
    await engine.delivery.send(sendInput({ id: "x-1" }), NOW);
    await engine.delivery.dispatchDue(NOW_1S);
    expect(engine.delivery.find("x-1")?.status).toBe("dead");
    expect(engine.delivery.deadLetters.count()).toBe(1);

    const { summary } = await engine.runAll(NOW_1S);
    // The pass replays the dead letter back into the queue.
    expect(summary.replayed).toBe(1);
    expect(engine.delivery.find("x-1")?.status).toBe("queued");
    expect(engine.delivery.deadLetters.count()).toBe(0);
  });
});

describe("recover (restart recovery)", () => {
  it("dispatches queued work and replays dead letters", async () => {
    const engine = backgroundWith(okTransport());
    await engine.delivery.send(sendInput({ id: "recover-1", scheduledAt: NOW_1S }), NOW);
    const { summary } = await engine.recover(NOW_1S);
    expect(engine.delivery.find("recover-1")?.status).toBe("delivered");
    expect(summary.dispatched).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(summary.replayed).toBe(0);
  });
});

describe("restoreState", () => {
  it("swaps in a restored delivery engine", async () => {
    const original = backgroundWith(okTransport());
    await original.delivery.send(sendInput({ id: "persisted-1" }), NOW);
    const restoredDelivery = new NotificationDeliveryEngine({ now: () => NOW, clockMs: () => 0 });
    restoredDelivery.restoreState({
      notifications: original.delivery.list(),
      deliveries: [],
      attempts: [],
      histories: [],
      failures: [],
      batches: [],
    });
    const engine = createNotificationBackgroundEngine({ now: () => NOW });
    engine.restoreState({ delivery: restoredDelivery });
    expect(engine.delivery.find("persisted-1")?.status).toBe("delivered");
  });
});

describe("determinism & immutability", () => {
  it("produces identical outcomes for identical inputs", async () => {
    const a = backgroundWith(okTransport());
    const b = backgroundWith(okTransport());
    await a.delivery.send(sendInput({ id: "det-1", scheduledAt: NOW_1M }), NOW);
    await b.delivery.send(sendInput({ id: "det-1", scheduledAt: NOW_1M }), NOW);
    const ra = await a.runDispatch(NOW_1M);
    const rb = await b.runDispatch(NOW_1M);
    expect(ra.summary.attempted).toBe(rb.summary.attempted);
    expect(ra.summary.delivered).toBe(rb.summary.delivered);
    expect(a.delivery.find("det-1")?.status).toBe("delivered");
    expect(b.delivery.find("det-1")?.status).toBe("delivered");
  });

  it("does not mutate caller inputs", async () => {
    const engine = backgroundWith(okTransport());
    const input = sendInput({ id: "imm-1" });
    await engine.delivery.send(input, NOW);
    expect(input.recipients[0]?.channel).toBe("email");
    expect(Object.isFrozen(input.recipients[0])).toBe(true);
  });
});

/** Helper: run dispatch on the engine (runDispatch mutates in place). */
async function nextRunDispatch(engine: NotificationBackgroundEngine, at: string) {
  return engine.runDispatch(at);
}
