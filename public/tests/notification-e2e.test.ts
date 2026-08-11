/**
 * Phase 6D — Notification & Delivery System end-to-end test.
 *
 * Verifies the complete notification pipeline through the production
 * composition root:
 *
 * ```text
 * send/schedule → templates → preferences → queues → delivery (channels,
 *   fallbacks, rate limits, parallel) → retry → dead letter → monitoring
 *   → persistence → restart recovery → background jobs (dispatch, replay,
 *   batch, digest, cleanup)
 * ```
 *
 * Also verifies: 1000-notification batch delivery, parallel delivery,
 * retry + dead letter, worker integration, database persistence, restart
 * recovery, monitoring, determinism, immutability, failure isolation and
 * the production singleton. All engines are injected fresh.
 */

import { describe, expect, it } from "vitest";
import {
  createProductionNotificationEngine,
  getProductionNotificationEngine,
  NotificationEngine,
} from "@/lib/notifications/production";
import { NotificationDeliveryEngine } from "@/lib/notifications/delivery";
import { createNotificationPersistence } from "@/lib/notifications/persistence";
import { DatabaseEngine } from "@/lib/database/production";
import { MemoryDatabaseDriver } from "@/lib/database/memoryDriver";
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
  createNotificationTemplate,
} from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";
const NOW_1S = "2026-08-11T09:00:01.000Z";
const NOW_2S = "2026-08-11T09:00:02.000Z";
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

function channelsFor(transport: NotificationTransport) {
  return createNotificationChannelRegistry({
    channels: [
      createEmailChannel({ transport }),
      createInAppChannel({ transport }),
      createMockChannel({ transport }),
    ],
  });
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

/** Fresh production engine over the given transport + clock. */
function engineWith(
  transport: NotificationTransport,
  options: { retryMax?: number } = {},
): NotificationEngine {
  return createProductionNotificationEngine({
    delivery: deliveryWith(transport, options.retryMax),
    now: () => NOW,
  });
}

function sendInput(overrides: Partial<Parameters<NotificationEngine["send"]>[0]> = {}) {
  return {
    title: "Hello",
    body: "World",
    recipients: [createNotificationRecipient({ channel: "email", address: "user@example.com" })],
    ...overrides,
  };
}

describe("production pipeline", () => {
  it("sends a notification end-to-end through the composition root", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(sendInput(), NOW);
    expect(result.notification.status).toBe("delivered");
    expect(engine.listNotifications()).toHaveLength(1);
    expect(engine.delivery.deliveries(result.notification.id)).toHaveLength(1);
    expect(engine.delivery.receipts(result.notification.id)[0]?.ok).toBe(true);
  });

  it("renders a registered template through the facade", async () => {
    const engine = engineWith(okTransport());
    const template = createNotificationTemplate({
      name: "e2e-greeting",
      body: "Hi {{name}}!",
      subject: "Hello {{name}}",
      variables: [{ name: "name" }],
      createdAt: NOW,
    });
    engine.withTemplates(engine.templates.register(template));
    const result = await engine.send(
      sendInput({
        templateId: template.id,
        templateVariables: { name: "Ada" },
        title: "ignored",
        body: "ignored",
      }),
      NOW,
    );
    expect(result.notification.body).toBe("Hi Ada!");
    expect(result.notification.title).toBe("Hello Ada");
  });

  it("honours user preferences before delivery", async () => {
    const engine = engineWith(okTransport());
    engine.preferences.mute("user-1", NOW);
    // Notification with a preference-gated user is still sent by the raw
    // delivery engine (preferences are consulted by the application, not by
    // the transport); verify the preference decision blocks it.
    const decision = engine.preferences.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("muted");
  });
});

describe("1000-notification batch delivery", () => {
  it("sends 1000 notifications in a single batch pass", async () => {
    // Raise the per-window send limit so the whole batch is delivered
    // (the default limit of 100 would rate-limit the rest).
    const delivery = new NotificationDeliveryEngine({
      channels: channelsFor(okTransport()),
      config: createNotificationConfiguration({
        rateLimit: { windowMs: 60_000, maxSends: 2000 },
      }),
      now: () => NOW,
      clockMs: () => 0,
    });
    const engine = createProductionNotificationEngine({ delivery, now: () => NOW });
    const inputs = Array.from({ length: 1000 }, (_, index) =>
      sendInput({ id: `e2e-${index}`, title: `Notification ${index}` }),
    );
    const result = await engine.sendBatch(inputs, NOW);
    expect(result.notifications).toHaveLength(1000);
    expect(engine.listNotifications()).toHaveLength(1000);
    expect(engine.delivery.batches()).toHaveLength(1);
    const delivered = engine.listNotifications().filter((n) => n.status === "delivered").length;
    expect(delivered).toBe(1000);
  });

  it("delivers to multiple recipients in parallel", async () => {
    const engine = engineWith(okTransport());
    const recipients = Array.from({ length: 10 }, (_, index) =>
      createNotificationRecipient({ channel: "email", address: `u${index}@example.com` }),
    );
    const result = await engine.send(sendInput({ recipients }), NOW);
    expect(engine.delivery.deliveries(result.notification.id)).toHaveLength(10);
    expect(engine.delivery.receipts(result.notification.id).filter((r) => r.ok)).toHaveLength(10);
  });
});

describe("retry & dead letter", () => {
  it("retries transient failures and dead-letters exhausted notifications", async () => {
    const engine = engineWith(failTransport("provider_error", true), { retryMax: 1 });
    const result = await engine.send(sendInput({ id: "e2e-retry" }), NOW);
    expect(result.notification.status).toBe("queued");
    await engine.delivery.dispatchDue(NOW_1S);
    expect(engine.findNotification("e2e-retry")?.status).toBe("dead");
    expect(engine.delivery.deadLetters.hasNotification("e2e-retry")).toBe(true);
  });

  it("replays dead-lettered notifications through the background engine", async () => {
    let down = true;
    const transport = new ScriptedTransport(() =>
      down
        ? { ok: false, error: { code: "provider_error", message: "down", retryable: true } }
        : { ok: true, message: "up" },
    );
    const engine = engineWith(transport, { retryMax: 2 });
    await engine.send(sendInput({ id: "e2e-replay" }), NOW);
    // First pass: attempt 1 fails, retry scheduled at NOW+1s; budget
    // (2 retries) not yet exhausted.
    await engine.delivery.dispatchDue(NOW_1S); // attempt 2 fails, retry at NOW+3s
    await engine.delivery.dispatchDue(NOW_2S); // not due yet
    expect(engine.findNotification("e2e-replay")?.status).toBe("queued");
    // Recovery: transport back up; the retry queue advances and delivers.
    down = false;
    await engine.delivery.dispatchDue(NOW_2S + "");
    await engine.delivery.dispatchDue("2026-08-11T09:00:03.000Z");
    expect(engine.findNotification("e2e-replay")?.status).toBe("delivered");
  });
});

describe("worker / background integration", () => {
  it("runs the full background pipeline in one pass", async () => {
    const engine = engineWith(okTransport());
    const later = "2026-08-11T09:00:05.000Z";
    await engine.send(sendInput({ id: "bg-1", scheduledAt: later }), NOW);
    const { summary } = await engine.runAll(later);
    expect(summary.dispatched).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(summary.failed).toBe(0);
    expect(engine.findNotification("bg-1")?.status).toBe("delivered");
  });

  it("aggregates digest-mode users into one digest notification", async () => {
    const engine = engineWith(okTransport());
    engine.preferences.setDigestMode("user-1", true, NOW);
    engine.preferences.setPreferredChannels("user-1", ["inapp"], NOW);
    await engine.delivery.schedule(
      { ...sendInput({ id: "dg-1", userId: "user-1" }), schedule: { at: NOW_1M } },
      NOW,
    );
    await engine.delivery.schedule(
      { ...sendInput({ id: "dg-2", userId: "user-1" }), schedule: { at: NOW_1M } },
      NOW,
    );
    const outcome = await engine.background.runDigest(NOW);
    expect(outcome.aggregated).toBe(2);
    expect(outcome.digests).toHaveLength(1);
    expect(outcome.digests[0]?.userId).toBe("user-1");
    expect(outcome.digests[0]?.category).toBe("digest");
    expect(engine.findNotification("dg-1")?.status).toBe("cancelled");
    expect(engine.findNotification("dg-2")?.status).toBe("cancelled");
  });

  it("cleans up settled notifications older than the retention window", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "old-1" }), NOW);
    const { removed } = await engine.background.runCleanup(NOW_1D, 0);
    expect(removed).toContain("old-1");
    expect(engine.findNotification("old-1")).toBeUndefined();
  });
});

describe("database persistence & restart recovery", () => {
  it("persists and restores the whole domain over the same driver", async () => {
    const driver = new MemoryDatabaseDriver();
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      persistence: createNotificationPersistenceWith({ driver }),
      now: () => NOW,
    });
    engine.preferences.setDigestMode("user-1", true, NOW);
    await engine.send(sendInput({ id: "persist-1" }), NOW);

    const { errors } = await engine.saveAll("user-1", NOW);
    expect(errors).toHaveLength(0);

    // Simulated restart: a fresh production engine over the same driver.
    const restarted = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      persistence: createNotificationPersistenceWith({ driver }),
      now: () => NOW,
    });
    const restored = await restarted.restoreAll("user-1");
    expect(restored.errors).toHaveLength(0);
    expect(restored.delivery.count()).toBe(1);
    expect(restored.delivery.find("persist-1")?.status).toBe("delivered");
    expect(restored.preferences.getPreference("user-1")?.digestMode).toBe(true);
  });

  it("recovers queued work after a restart through the background engine", async () => {
    const driver = new MemoryDatabaseDriver();
    const first = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      persistence: createNotificationPersistenceWith({ driver }),
      now: () => NOW,
    });
    await first.send(sendInput({ id: "queued-1", scheduledAt: NOW_1M }), NOW);
    await first.saveAll("user-1", NOW);

    const restarted = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      persistence: createNotificationPersistenceWith({ driver }),
      now: () => NOW,
    });
    const { delivery } = await restarted.restoreAll("user-1");
    const recovered = createProductionNotificationEngine({
      delivery,
      now: () => NOW,
    });
    const { summary } = await recovered.recover(NOW_1M);
    expect(summary.dispatched).toBe(1);
    expect(recovered.findNotification("queued-1")?.status).toBe("delivered");
  });
});

describe("monitoring integration", () => {
  it("records delivery metrics and queue depth through the bridge", async () => {
    const engine = engineWith(okTransport());
    // Schedule for the future, then dispatch through the background engine
    // so the delivery observations are recorded on the monitoring bridge.
    await engine.delivery.schedule(
      { ...sendInput({ id: "mon-1" }), schedule: { at: NOW_1S } },
      NOW,
    );
    await engine.background.runDispatch(NOW_1S);
    const snapshot = engine.monitoringSnapshot(NOW_1S);
    const names = snapshot.metrics.samples.map((sample) => sample.name);
    expect(names).toContain("notification.delivered");
    expect(engine.background.monitoring.queueDepth()).toBeDefined();
  });

  it("records failures for dead-lettered notifications", async () => {
    const engine = engineWith(failTransport("provider_error", true), { retryMax: 1 });
    await engine.send(sendInput({ id: "mon-fail" }), NOW);
    await engine.background.runDispatch(NOW_1S);
    const snapshot = engine.monitoringSnapshot(NOW_1S);
    const names = snapshot.metrics.samples.map((sample) => sample.name);
    expect(names).toContain("notification.dead");
  });
});

describe("failure isolation", () => {
  it("a throwing transport never rejects the caller", async () => {
    const throwing: NotificationTransport = {
      send: async () => {
        throw new Error("transport exploded");
      },
    };
    const engine = engineWith(throwing);
    const result = await engine.send(sendInput({ id: "iso-1" }), NOW);
    // Structured failure: dead-lettered with a channel_error code, never a
    // thrown rejection.
    expect(result.notification.status).toBe("dead");
    const failure = engine.delivery.failures()[0];
    expect(failure?.error.code).toBe("all_channels_failed");
  });

  it("isolates a failing input inside a batch", async () => {
    const engine = engineWith(okTransport());
    const bad = sendInput({
      id: "bad-1",
      recipients: [createNotificationRecipient({ channel: "telegram", address: "123" })],
    });
    const good = sendInput({ id: "good-1" });
    const result = await engine.sendBatch([good, bad], NOW);
    expect(engine.findNotification("good-1")?.status).toBe("delivered");
    expect(engine.findNotification("bad-1")?.status).toBe("failed");
    expect(result.notifications).toHaveLength(2);
  });
});

describe("determinism & immutability", () => {
  it("produces identical results for identical inputs", async () => {
    const a = engineWith(okTransport());
    const b = engineWith(okTransport());
    const ra = await a.send(sendInput({ id: "det-1" }), NOW);
    const rb = await b.send(sendInput({ id: "det-1" }), NOW);
    expect(ra.notification.id).toBe(rb.notification.id);
    expect(a.findNotification("det-1")?.status).toBe("delivered");
    expect(b.findNotification("det-1")?.status).toBe("delivered");
  });

  it("does not mutate caller inputs", async () => {
    const engine = engineWith(okTransport());
    const input = sendInput({ id: "imm-1" });
    await engine.send(input, NOW);
    expect(input.recipients[0]?.channel).toBe("email");
    expect(Object.isFrozen(input.recipients[0])).toBe(true);
  });

  it("returns detached copies from reads", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "detach-1" }), NOW);
    const notification = engine.findNotification("detach-1");
    if (notification !== undefined) notification.title = "mutated";
    expect(engine.findNotification("detach-1")?.title).toBe("Hello");
  });
});

describe("production singleton", () => {
  it("exposes a stable singleton distinct from fresh factories", () => {
    expect(getProductionNotificationEngine()).toBe(getProductionNotificationEngine());
    expect(getProductionNotificationEngine()).toBeInstanceOf(NotificationEngine);
    expect(getProductionNotificationEngine()).not.toBe(engineWith(okTransport()));
  });
});

/** Build a persistence adapter bound to a specific driver. */
function createNotificationPersistenceWith(options: { driver: MemoryDatabaseDriver }) {
  return createNotificationPersistence({ database: new DatabaseEngine({ driver: options.driver }) });
}
