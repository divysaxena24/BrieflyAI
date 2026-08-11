/**
 * Phase 6D STEP 6 — delivery engine tests.
 */
import { describe, expect, it } from "vitest";
import {
  NotificationDeliveryEngine,
  type NotificationSendInput,
} from "@/lib/notifications/delivery";
import {
  type NotificationTransport,
  type NotificationTransportInput,
} from "@/lib/notifications/channels";
import {
  createNotificationRecipient,
  createNotificationConfiguration,
  createNotificationRetryPolicy,
  createNotificationTemplate,
  createNotificationAttachment,
} from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";
const NOW_1S = "2026-08-11T09:00:01.000Z";
const NOW_3S = "2026-08-11T09:00:03.000Z";
const NOW_10S = "2026-08-11T09:00:10.000Z";
const NOW_1M = "2026-08-11T09:01:00.000Z";

/** A mock transport whose sends can be scripted per address. */
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

/** A transport that always succeeds. */
function okTransport(): ScriptedTransport {
  return new ScriptedTransport(() => ({ ok: true, message: "mock-ok" }));
}

/** A transport that always fails with the given code. */
function failTransport(code: string, retryable = true): ScriptedTransport {
  return new ScriptedTransport(() => ({
    ok: false,
    error: { code, message: `boom:${code}`, retryable },
  }));
}

/** A transport that throws for every send. */
function throwingTransport(): NotificationTransport {
  return {
    send: async () => {
      throw new Error("transport exploded");
    },
  };
}

/** Build a standard email recipient. */
function emailRecipient(overrides: Partial<Parameters<typeof createNotificationRecipient>[0]> = {}) {
  return createNotificationRecipient({
    channel: "email",
    address: "user@example.com",
    ...overrides,
  });
}

/** Build a standard engine over the given transport with default config. */
function engineWith(
  transport: NotificationTransport,
  options: { retryMax?: number; maxSends?: number; dedupeEnabled?: boolean } = {},
): NotificationDeliveryEngine {
  const config = createNotificationConfiguration({
    retryPolicy:
      options.retryMax === undefined
        ? undefined
        : createNotificationRetryPolicy({ maxRetries: options.retryMax, backoffMs: 1000 }),
    ...(options.maxSends !== undefined
      ? { rateLimit: { windowMs: 60_000, maxSends: options.maxSends } }
      : {}),
    ...(options.dedupeEnabled !== undefined ? { dedupeEnabled: options.dedupeEnabled } : {}),
  });
  const channels = createChannelsFor(transport);
  return new NotificationDeliveryEngine({
    channels,
    config,
    now: () => NOW,
    clockMs: () => 0,
  });
}

/** Build a channel registry: email + inapp + mock, all over `transport`. */
import {
  createEmailChannel,
  createInAppChannel,
  createMockChannel,
  createNotificationChannelRegistry,
} from "@/lib/notifications/channels";

function createChannelsFor(transport: NotificationTransport) {
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
    recipients: [emailRecipient()],
    ...overrides,
  };
}

describe("NotificationDeliveryEngine construction", () => {
  it("builds an empty engine with default config", () => {
    const engine = new NotificationDeliveryEngine();
    expect(engine.count()).toBe(0);
    expect(engine.list()).toEqual([]);
    expect(engine.config.defaultCategory).toBe("system");
    expect(engine.config.defaultPriority).toBe("normal");
  });

  it("exposes injected sub-components", () => {
    const transport = okTransport();
    const engine = engineWith(transport);
    expect(engine.channels.count()).toBe(3);
    expect(engine.queues.count()).toBe(0);
    expect(engine.retry.count()).toBe(0);
    expect(engine.deadLetters.count()).toBe(0);
  });

  it("defaults to a fresh mock transport when no channels are injected", async () => {
    const engine = new NotificationDeliveryEngine({ now: () => NOW, clockMs: () => 0 });
    const result = await engine.send(sendInput());
    expect(result.notification.status).toBe("delivered");
    expect(engine.count()).toBe(1);
  });
});

describe("send (single dispatch)", () => {
  it("creates, queues and delivers a notification immediately", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(sendInput(), NOW);
    expect(result.deduplicated).toBe(false);
    expect(result.notification.status).toBe("delivered");
    expect(result.notification.attempts).toBe(1);
    expect(result.notification.deliveredAt).toBe(NOW);
    expect(engine.count()).toBe(1);
    expect(engine.find(result.notification.id)?.status).toBe("delivered");
  });

  it("returns a delivery record and a receipt", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(sendInput(), NOW);
    const deliveries = engine.deliveries(result.notification.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("sent");
    expect(deliveries[0]?.channel).toBe("email");
    expect(deliveries[0]?.attempts).toBe(1);
    const receipts = engine.receipts(result.notification.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.ok).toBe(true);
  });

  it("derives a deterministic notification id", async () => {
    const a = engineWith(okTransport());
    const b = engineWith(okTransport());
    const resultA = await a.send(sendInput(), NOW);
    const resultB = await b.send(sendInput(), NOW);
    expect(resultA.notification.id).toBe(resultB.notification.id);
    expect(resultA.notification.id).toMatch(/^notification-/);
  });

  it("honours an explicit notification id", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(sendInput({ id: "explicit-1" }), NOW);
    expect(result.notification.id).toBe("explicit-1");
    expect(engine.has("explicit-1")).toBe(true);
  });

  it("records history entries across the lifecycle", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(sendInput(), NOW);
    const history = engine.history(result.notification.id);
    const kinds = history?.entries.map((entry) => entry.kind) ?? [];
    expect(kinds).toContain("created");
    expect(kinds).toContain("queued");
    expect(kinds).toContain("sending");
    expect(kinds).toContain("delivered");
  });

  it("stores the rendered payload", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(
      sendInput({ payload: { data: { key: "value" } } }),
      NOW,
    );
    expect(result.notification.payload?.data).toEqual({ key: "value" });
    expect(result.notification.payload?.body).toBe("World");
  });

  it("renders a registered template", async () => {
    const engine = engineWith(okTransport());
    const template = createNotificationTemplate({
      name: "greeting",
      body: "Hi {{name}}, your code is {{code}}",
      subject: "Greetings {{name}}",
      variables: [
        { name: "name" },
        { name: "code" },
      ],
      createdAt: NOW,
    });
    const registry = engine.templates.register(template);
    engine.withTemplates(registry);
    const result = await engine.send(
      sendInput({
        templateId: template.id,
        templateVariables: { name: "Ada", code: "1234" },
      }),
      NOW,
    );
    expect(result.notification.body).toBe("Hi Ada, your code is 1234");
    expect(result.notification.title).toBe("Greetings Ada");
    expect(result.notification.templateId).toBe(template.id);
  });

  it("falls back to the template subject when present", async () => {
    const engine = engineWith(okTransport());
    const template = createNotificationTemplate({
      name: "t",
      body: "Body {{x}}",
      subject: "Subject {{x}}",
      variables: [{ name: "x" }],
      createdAt: NOW,
    });
    engine.withTemplates(engine.templates.register(template));
    const result = await engine.send(
      sendInput({ templateId: template.id, templateVariables: { x: "1" } }),
      NOW,
    );
    expect(result.notification.title).toBe("Subject 1");
  });

  it("carries attachments into the message", async () => {
    const engine = engineWith(okTransport());
    const attachment = createNotificationAttachment({
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
    });
    const result = await engine.send(
      sendInput({ attachments: [attachment] }),
      NOW,
    );
    expect(result.notification.attachments).toHaveLength(1);
    expect(result.notification.attachments[0]?.name).toBe("report.pdf");
  });
});

describe("send validation", () => {
  it("rejects a notification without recipients", async () => {
    const engine = engineWith(okTransport());
    await expect(engine.send(sendInput({ recipients: [] }), NOW)).rejects.toThrow(
      /at least one recipient/,
    );
  });

  it("rejects a notification with too many recipients", async () => {
    const engine = engineWith(okTransport());
    const recipients = Array.from({ length: 101 }, (_, index) =>
      emailRecipient({ address: `u${index}@example.com` }),
    );
    await expect(engine.send(sendInput({ recipients }), NOW)).rejects.toThrow(
      /at most 100 recipients/,
    );
  });

  it("rejects an oversized body", async () => {
    const engine = engineWith(okTransport());
    await expect(
      engine.send(sendInput({ body: "x".repeat(10_001) }), NOW),
    ).rejects.toThrow(/maximum length/);
  });

  it("rejects an oversized title", async () => {
    const engine = engineWith(okTransport());
    await expect(
      engine.send(sendInput({ title: "x".repeat(201) }), NOW),
    ).rejects.toThrow(/maximum length/);
  });

  it("rejects too many attachments", async () => {
    const engine = engineWith(okTransport());
    const attachments = Array.from({ length: 11 }, (_, index) =>
      createNotificationAttachment({ name: `f${index}`, mimeType: "text/plain" }),
    );
    await expect(
      engine.send(sendInput({ attachments }), NOW),
    ).rejects.toThrow(/at most 10 attachments/);
  });
});

describe("parallel delivery & fallback channels", () => {
  it("delivers to multiple recipients in parallel", async () => {
    const engine = engineWith(okTransport());
    const recipients = [
      emailRecipient({ address: "a@example.com" }),
      emailRecipient({ address: "b@example.com" }),
      emailRecipient({ address: "c@example.com" }),
    ];
    const result = await engine.send(sendInput({ recipients }), NOW);
    expect(result.notification.status).toBe("delivered");
    expect(engine.deliveries(result.notification.id)).toHaveLength(3);
    expect(result.summary?.receipts).toHaveLength(3);
  });

  it("uses the fallback channel when the primary fails transiently", async () => {
    const transport = new ScriptedTransport((input) =>
      input.channel === "email"
        ? { ok: false, error: { code: "provider_error", message: "down", retryable: true } }
        : { ok: true, message: "inapp-ok" },
    );
    const engine = engineWith(transport);
    const recipient = emailRecipient({ fallbackChannels: ["inapp"] });
    const result = await engine.send(sendInput({ recipients: [recipient] }), NOW);
    expect(result.notification.status).toBe("delivered");
    const deliveries = engine.deliveries(result.notification.id);
    expect(deliveries[0]?.channel).toBe("inapp");
    expect(deliveries[0]?.status).toBe("sent");
  });

  it("does not fall through on a permanent failure", async () => {
    const transport = new ScriptedTransport(() => ({
      ok: false,
      error: { code: "validation_failed", message: "bad", retryable: false },
    }));
    const engine = engineWith(transport, { retryMax: 1 });
    const recipient = emailRecipient({ fallbackChannels: ["inapp"] });
    const result = await engine.send(sendInput({ recipients: [recipient] }), NOW);
    expect(result.notification.status).toBe("failed");
    const receipts = engine.receipts(result.notification.id);
    expect(receipts[0]?.ok).toBe(false);
    expect(receipts[0]?.channel).toBe("email");
    expect(receipts[0]?.error?.code).toBe("validation_failed");
  });

  it("a throwing channel becomes a structured failure (isolation)", async () => {
    const engine = engineWith(throwingTransport());
    const result = await engine.send(sendInput(), NOW);
    // The single email channel threw (retryable, no fallbacks) so the
    // recipient settles as `all_channels_failed`; with the default budget
    // (maxRetries 0) the notification is dead-lettered. Never a rejection.
    expect(result.notification.status).toBe("dead");
    expect(engine.failures()).toHaveLength(1);
    expect(engine.failures()[0]?.error.code).toBe("all_channels_failed");
  });

  it("reports a missing channel as a structured failure", async () => {
    const config = createNotificationConfiguration();
    const channels = createNotificationChannelRegistry({
      channels: [createEmailChannel({ transport: okTransport() })],
    });
    const engine = new NotificationDeliveryEngine({
      channels,
      config,
      now: () => NOW,
      clockMs: () => 0,
    });
    const recipient = createNotificationRecipient({
      channel: "telegram",
      address: "123",
    });
    const result = await engine.send(sendInput({ recipients: [recipient] }), NOW);
    expect(result.notification.status).toBe("failed");
    const receipts = engine.receipts(result.notification.id);
    expect(receipts[0]?.error?.code).toBe("channel_not_registered");
  });
});

describe("deduplication", () => {
  it("deduplicates a send against a non-settled notification", async () => {
    const engine = engineWith(okTransport());
    // Scheduled far in the future so the first notification is not settled.
    const first = await engine.send(
      sendInput({ dedupeKey: "unique-1", scheduledAt: NOW_1M }),
      NOW,
    );
    expect(first.deduplicated).toBe(false);
    const second = await engine.send(
      sendInput({ dedupeKey: "unique-1", scheduledAt: NOW_1M }),
      NOW,
    );
    expect(second.deduplicated).toBe(true);
    expect(second.notification.id).toBe(first.notification.id);
    expect(engine.count()).toBe(1);
  });

  it("does not deduplicate against a settled notification", async () => {
    const engine = engineWith(okTransport());
    const first = await engine.send(sendInput({ dedupeKey: "k1" }), NOW);
    expect(first.notification.status).toBe("delivered");
    const second = await engine.send(sendInput({ dedupeKey: "k1" }), NOW);
    expect(second.deduplicated).toBe(false);
    expect(engine.count()).toBe(2);
  });

  it("is disabled when the configuration turns dedupe off", async () => {
    const engine = engineWith(okTransport(), { dedupeEnabled: false });
    await engine.send(sendInput({ id: "first", dedupeKey: "k1", scheduledAt: NOW_1M }), NOW);
    const second = await engine.send(
      sendInput({ id: "second", dedupeKey: "k1", scheduledAt: NOW_1M }),
      NOW,
    );
    expect(second.deduplicated).toBe(false);
    expect(engine.count()).toBe(2);
  });
});

describe("scheduling", () => {
  it("schedules a future notification without dispatching", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.schedule(
      { ...sendInput(), schedule: { at: NOW_1M } },
      NOW,
    );
    expect(result.notification.status).toBe("queued");
    expect(engine.deliveries(result.notification.id)).toHaveLength(0);
    expect(engine.queueStatistics(NOW).delayed.total).toBe(1);
  });

  it("send with a future scheduledAt keeps it queued", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(sendInput({ scheduledAt: NOW_1M }), NOW);
    expect(result.summary).toBeUndefined();
    expect(engine.find(result.notification.id)?.status).toBe("queued");
  });

  it("dispatchDue delivers a scheduled notification when due", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(sendInput({ scheduledAt: NOW_1M }), NOW);
    const id = result.notification.id;
    // Not due yet.
    await engine.dispatchDue(NOW_10S);
    expect(engine.find(id)?.status).toBe("queued");
    // Due now.
    const { summary } = await engine.dispatchDue(NOW_1M);
    expect(engine.find(id)?.status).toBe("delivered");
    expect(summary.delivered).toBe(1);
  });

  it("scheduledAt is derived from the schedule when not given", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.schedule(
      { ...sendInput(), schedule: { at: NOW_1M } },
      NOW,
    );
    expect(result.notification.scheduledAt).toBe(NOW_1M);
  });
});

describe("dispatchDue", () => {
  it("dispatches in priority order (critical first)", async () => {
    const engine = engineWith(okTransport());
    // Both scheduled in the future so neither is dispatched at send time.
    await engine.send(sendInput({ id: "low-1", priority: "low", scheduledAt: NOW_1M }), NOW);
    await engine.send(sendInput({ id: "crit-1", priority: "critical", scheduledAt: NOW_1M }), NOW);
    const { summary } = await engine.dispatchDue(NOW_1M, 1);
    expect(summary.attempted).toBe(1);
    expect(engine.find("crit-1")?.status).toBe("delivered");
    expect(engine.find("low-1")?.status).toBe("queued");
  });

  it("honours the dispatch limit", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "n-a", scheduledAt: NOW_1M }), NOW);
    await engine.send(sendInput({ id: "n-b", scheduledAt: NOW_1M }), NOW);
    const { summary } = await engine.dispatchDue(NOW_1M, 1);
    expect(summary.attempted).toBe(1);
    const deliveredCount = ["n-a", "n-b"].filter(
      (id) => engine.find(id)?.status === "delivered",
    ).length;
    const queuedCount = ["n-a", "n-b"].filter(
      (id) => engine.find(id)?.status === "queued",
    ).length;
    expect(deliveredCount).toBe(1);
    expect(queuedCount).toBe(1);
  });

  it("cancels an expired notification instead of delivering it", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(
      sendInput({ expiresAt: "2026-08-01T00:00:00.000Z" }),
      NOW,
    );
    expect(result.notification.status).toBe("cancelled");
    expect(engine.find(result.notification.id)?.error?.code).toBe("expired");
  });

  it("reports nothing to dispatch as an empty summary", async () => {
    const engine = engineWith(okTransport());
    const { summary } = await engine.dispatchDue(NOW);
    expect(summary.attempted).toBe(0);
    expect(summary.delivered).toBe(0);
  });
});

describe("sendBatch", () => {
  it("sends many notifications in parallel and records a batch", async () => {
    const engine = engineWith(okTransport());
    const inputs = Array.from({ length: 5 }, (_, index) =>
      sendInput({ id: `batch-${index}`, title: `T${index}` }),
    );
    const result = await engine.sendBatch(inputs, NOW);
    expect(result.notifications).toHaveLength(5);
    expect(result.batch.notificationIds).toHaveLength(5);
    expect(result.batch.status).toBe("completed");
    expect(engine.batches()).toHaveLength(1);
    expect(engine.count()).toBe(5);
  });

  it("isolates a failing input inside the batch", async () => {
    const engine = engineWith(okTransport());
    // Inject a failing input whose recipient channel is not registered.
    const bad = sendInput({
      id: "bad-1",
      recipients: [
        createNotificationRecipient({ channel: "telegram", address: "123" }),
      ],
    });
    const good = sendInput({ id: "good-1" });
    const result = await engine.sendBatch([good, bad], NOW);
    expect(result.notifications).toHaveLength(2);
    expect(engine.find("good-1")?.status).toBe("delivered");
    expect(engine.find("bad-1")?.status).toBe("failed");
  });
});

describe("retry & dead letter", () => {
  it("retries a transient failure on the next dispatch", async () => {
    const engine = engineWith(failTransport("provider_error", true), { retryMax: 2 });
    const result = await engine.send(sendInput({ id: "retry-1" }), NOW);
    expect(result.notification.status).toBe("queued");
    expect(engine.find("retry-1")?.attempts).toBe(1);
    // Retry at NOW + 1s.
    await engine.dispatchDue(NOW_1S);
    const after = engine.find("retry-1");
    expect(after?.status).toBe("queued");
    expect(after?.attempts).toBe(2);
    // Final retry at NOW_1S + 2s (exponential backoff).
    const { summary } = await engine.dispatchDue(NOW_3S);
    expect(engine.find("retry-1")?.status).toBe("dead");
    expect(summary.dead).toBe(1);
    expect(engine.deadLetters.count()).toBe(1);
  });

  it("dead-letters when the retry budget is exhausted", async () => {
    const engine = engineWith(failTransport("provider_error", true), { retryMax: 1 });
    const result = await engine.send(sendInput({ id: "dl-1" }), NOW);
    expect(result.notification.status).toBe("queued");
    const { summary } = await engine.dispatchDue(NOW_1S);
    expect(engine.find("dl-1")?.status).toBe("dead");
    expect(summary.dead).toBe(1);
    expect(engine.deadLetters.hasNotification("dl-1")).toBe(true);
    expect(engine.deadLetters.findByNotification("dl-1")).toHaveLength(1);
  });

  it("does not retry when the failure is not retryable", async () => {
    const engine = engineWith(failTransport("validation_failed", false), { retryMax: 2 });
    const result = await engine.send(sendInput({ id: "perm-1" }), NOW);
    // Permanent failures settle as "failed" without dead-lettering.
    expect(result.notification.status).toBe("failed");
    expect(engine.deadLetters.hasNotification("perm-1")).toBe(false);
  });

  it("recovers after a transient outage", async () => {
    let down = true;
    const transport = new ScriptedTransport(() =>
      down
        ? { ok: false, error: { code: "provider_error", message: "down", retryable: true } }
        : { ok: true, message: "up" },
    );
    const engine = engineWith(transport, { retryMax: 3 });
    await engine.send(sendInput({ id: "recover-1" }), NOW);
    expect(engine.find("recover-1")?.status).toBe("queued");
    down = false;
    const { summary } = await engine.dispatchDue(NOW_1S);
    expect(engine.find("recover-1")?.status).toBe("delivered");
    expect(summary.delivered).toBe(1);
    expect(engine.retry.has("recover-1")).toBe(false);
  });
});

describe("rate limiting", () => {
  it("rate-limits a channel after the window is exhausted", async () => {
    const engine = engineWith(okTransport(), { maxSends: 2 });
    const recipients = [
      emailRecipient({ address: "a@example.com" }),
      emailRecipient({ address: "b@example.com" }),
      emailRecipient({ address: "c@example.com" }),
    ];
    const result = await engine.send(sendInput({ recipients }), NOW);
    const receipts = engine.receipts(result.notification.id);
    expect(receipts.filter((receipt) => receipt.ok)).toHaveLength(2);
    const rateLimited = receipts.find((receipt) => !receipt.ok);
    expect(rateLimited?.error?.code).toBe("rate_limited");
  });

  it("the rate window is reset by time", async () => {
    const transport = okTransport();
    const engine = engineWith(transport, { maxSends: 2 });
    const recipients = [
      emailRecipient({ address: "a@example.com" }),
      emailRecipient({ address: "b@example.com" }),
    ];
    await engine.send(sendInput({ recipients }), NOW);
    // A third send in a fresh window (now moves past the 60s window) passes.
    const later = await engine.send(
      sendInput({ recipients: [emailRecipient({ address: "c@example.com" })] }),
      NOW_1M,
    );
    expect(later.notification.status).toBe("delivered");
  });
});

describe("cancel & replace", () => {
  it("cancels a queued notification", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "c-1", scheduledAt: NOW_1M }), NOW);
    const { notification } = engine.cancel("c-1", NOW);
    expect(notification.status).toBe("cancelled");
    expect(engine.queueStatistics(NOW).total).toBe(0);
  });

  it("cancel of an unknown notification throws", () => {
    const engine = engineWith(okTransport());
    expect(() => engine.cancel("missing", NOW)).toThrow(/not found/);
  });

  it("cancel of a settled notification is a no-op", async () => {
    const engine = engineWith(okTransport());
    const result = await engine.send(sendInput({ id: "settled-1" }), NOW);
    expect(result.notification.status).toBe("delivered");
    const { notification } = engine.cancel("settled-1", NOW);
    expect(notification.status).toBe("delivered");
  });

  it("replaces the content of a queued notification", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "r-1", title: "Old", scheduledAt: NOW_1M }), NOW);
    const { notification } = engine.replace("r-1", sendInput({ id: "r-1", title: "New" }), NOW);
    expect(notification.title).toBe("New");
    expect(engine.find("r-1")?.title).toBe("New");
    expect(engine.find("r-1")?.createdAt).toBe(NOW);
  });

  it("replace of a settled notification is a no-op", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "rs-1" }), NOW);
    const { notification } = engine.replace("rs-1", sendInput({ id: "rs-1", title: "New" }), NOW);
    expect(notification.title).toBe("Hello");
  });
});

describe("statistics, metrics & health", () => {
  it("computes statistics over stored notifications", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "s-1" }), NOW);
    const stats = engine.statistics();
    expect(stats.total).toBe(1);
    expect(stats.byStatus.delivered).toBe(1);
    expect(stats.byCategory.system).toBe(1);
  });

  it("computes a summary with the overall status", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "s-1" }), NOW);
    const summary = engine.summary();
    expect(summary.delivered).toBe(1);
    expect(summary.overall).toBe("delivered");
  });

  it("computes metrics with attempts and failure rate", async () => {
    const engine = engineWith(failTransport("validation_failed", false));
    await engine.send(sendInput({ id: "m-1" }), NOW);
    const metrics = engine.metrics();
    expect(metrics.totalAttempts).toBe(1);
    expect(metrics.failed).toBe(1);
    expect(metrics.failureRate).toBeDefined();
  });

  it("reports healthy state initially", () => {
    const engine = engineWith(okTransport());
    const health = engine.health(NOW);
    expect(health.status).toBe("healthy");
    expect(health.score).toBe(1);
  });

  it("reports a snapshot with notifications and statistics", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "snap-1" }), NOW);
    const snapshot = engine.snapshot(NOW);
    expect(snapshot.at).toBe(NOW);
    expect(snapshot.notifications).toHaveLength(1);
    expect(snapshot.statistics.total).toBe(1);
  });

  it("builds a delivery report", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "rep-1" }), NOW);
    const report = engine.report(NOW);
    expect(report.at).toBe(NOW);
    expect(report.statistics.total).toBe(1);
    expect(report.metrics.delivered).toBe(1);
    expect(report.health?.status).toBe("healthy");
  });

  it("tracks queue statistics", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "q-1", scheduledAt: NOW_1M }), NOW);
    const stats = engine.queueStatistics(NOW);
    expect(stats.delayed.total).toBe(1);
    const summary = engine.queueSummary();
    expect(summary.total).toBe(1);
  });
});

describe("immutability", () => {
  it("returns detached copies from reads", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "imm-1" }), NOW);
    const notification = engine.find("imm-1");
    if (notification !== undefined) notification.title = "mutated";
    expect(engine.find("imm-1")?.title).toBe("Hello");
  });

  it("does not mutate the caller's recipient objects", async () => {
    const engine = engineWith(okTransport());
    const recipient = emailRecipient();
    await engine.send(sendInput({ recipients: [recipient] }), NOW);
    expect(recipient.id).toBeDefined();
    expect(recipient.channel).toBe("email");
    expect(Object.isFrozen(recipient)).toBe(true);
  });

  it("restoreState rebuilds the engine from persisted collections", async () => {
    const engine = engineWith(okTransport());
    await engine.send(sendInput({ id: "persist-1" }), NOW);
    const notifications = engine.list();
    const deliveries = notifications.flatMap((notification) =>
      engine.deliveries(notification.id),
    );
    const attempts = deliveries.flatMap((delivery) => engine.attempts(delivery.id));
    const histories = notifications
      .map((notification) => engine.history(notification.id))
      .filter((history): history is NonNullable<typeof history> => history !== undefined);
    const failures = engine.failures();
    const batches = engine.batches();

    const restored = new NotificationDeliveryEngine({ now: () => NOW, clockMs: () => 0 });
    restored.restoreState({
      notifications,
      deliveries,
      attempts,
      histories,
      failures,
      batches,
    });
    expect(restored.count()).toBe(1);
    expect(restored.find("persist-1")?.status).toBe("delivered");
    expect(restored.deliveries("persist-1")).toHaveLength(1);
    expect(restored.metrics().delivered).toBe(1);
  });
});
