/**
 * Phase 6D STEP 11 — notification database persistence tests.
 *
 * Exercises the row-level persistence of the notification domain over the
 * Phase 6A DatabaseEngine: notifications, deliveries, attempts, histories,
 * failures, dead letters, batches, queues, retry states, templates,
 * preferences/subscriptions/rules and reports.
 */
import { describe, expect, it } from "vitest";
import {
  createNotificationPersistence,
  NotificationPersistence,
  NOTIFICATION_DATABASE_COLLECTIONS,
} from "@/lib/notifications/persistence";
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
  createNotificationTemplate,
  createNotificationPreferenceRule,
} from "@/lib/notifications/types";
import { NotificationPreferenceEngine } from "@/lib/notifications/preferences";
import { createTemplateRegistry } from "@/lib/notifications/templates";
import { DatabaseEngine, createProductionDatabase } from "@/lib/database/production";
import { MemoryDatabaseDriver } from "@/lib/database/memoryDriver";

const NOW = "2026-08-11T09:00:00.000Z";
const NOW_1S = "2026-08-11T09:00:01.000Z";
const NOW_1M = "2026-08-11T09:01:00.000Z";
const LATER = "2026-08-11T10:00:00.000Z";

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

describe("NotificationPersistence construction", () => {
  it("builds a fresh persistence over a fresh database engine", () => {
    const persistence = createNotificationPersistence();
    expect(persistence.database).toBeInstanceOf(DatabaseEngine);
    expect(persistence).toBeInstanceOf(NotificationPersistence);
  });

  it("exposes the injected database engine", () => {
    const database = createProductionDatabase();
    const persistence = createNotificationPersistence({ database });
    expect(persistence.database).toBe(database);
  });

  it("lists every notification-domain collection", () => {
    expect(NOTIFICATION_DATABASE_COLLECTIONS).toContain("notification");
    expect(NOTIFICATION_DATABASE_COLLECTIONS).toContain("notification_deadletter");
    expect(NOTIFICATION_DATABASE_COLLECTIONS).toContain("notification_metric");
    expect(Object.isFrozen(NOTIFICATION_DATABASE_COLLECTIONS)).toBe(true);
    expect(new Set(NOTIFICATION_DATABASE_COLLECTIONS).size).toBe(
      NOTIFICATION_DATABASE_COLLECTIONS.length,
    );
  });
});

describe("saveNotifications / restoreNotifications", () => {
  it("persists and restores delivered notifications", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(okTransport());
    const result = await engine.send(sendInput({ id: "n-1" }), NOW);
    expect(result.notification.status).toBe("delivered");

    const saved = await persistence.saveNotifications("user-1", engine, NOW);
    expect(saved.written).toBeGreaterThan(0);
    expect(saved.collections).toContain("notification");

    const restored = await persistence.restoreNotifications("user-1", NOW);
    expect(restored.count()).toBe(1);
    const notification = restored.find("n-1");
    expect(notification?.status).toBe("delivered");
    expect(notification?.title).toBe("Hello");
    expect(restored.deliveries("n-1")).toHaveLength(1);
    expect(restored.history("n-1")).toBeDefined();
    expect(restored.metrics().delivered).toBe(1);
  });

  it("persists queued and scheduled state including queue items", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(okTransport());
    await engine.send(sendInput({ id: "scheduled-1", scheduledAt: NOW_1M }), NOW);
    expect(engine.queueStatistics(NOW).delayed.total).toBe(1);

    await persistence.saveNotifications("user-1", engine, NOW);
    const restored = await persistence.restoreNotifications("user-1", NOW);
    expect(restored.find("scheduled-1")?.status).toBe("queued");
    expect(restored.queueStatistics(NOW).delayed.total).toBe(1);
  });

  it("persists dead-lettered notifications and their dead-letter records", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(failTransport("provider_error", true), 1);
    await engine.send(sendInput({ id: "dl-1" }), NOW);
    await engine.dispatchDue(NOW_1S);
    expect(engine.find("dl-1")?.status).toBe("dead");
    expect(engine.deadLetters.count()).toBe(1);

    await persistence.saveNotifications("user-1", engine, NOW_1S);
    const restored = await persistence.restoreNotifications("user-1", NOW_1S);
    expect(restored.find("dl-1")?.status).toBe("dead");
    expect(restored.deadLetters.count()).toBe(1);
    expect(restored.deadLetters.hasNotification("dl-1")).toBe(true);
  });

  it("restores empty storage as an empty engine", async () => {
    const persistence = createNotificationPersistence();
    const restored = await persistence.restoreNotifications("user-1", NOW);
    expect(restored.count()).toBe(0);
  });

  it("is idempotent: re-saving removes nothing", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(okTransport());
    await engine.send(sendInput({ id: "n-1" }), NOW);
    await persistence.saveNotifications("user-1", engine, NOW);
    const second = await persistence.saveNotifications("user-1", engine, NOW);
    expect(second.removed).toBe(0);
    expect(second.written).toBeGreaterThan(0);
    const restored = await persistence.restoreNotifications("user-1", NOW);
    expect(restored.count()).toBe(1);
  });

  it("removes stale rows on re-save (full-replace semantics)", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(okTransport());
    await engine.send(sendInput({ id: "a-1" }), NOW);
    await persistence.saveNotifications("user-1", engine, NOW);
    // Simulate the notification being pruned: send again without it.
    const empty = deliveryWith(okTransport());
    const result = await persistence.saveNotifications("user-1", empty, NOW);
    expect(result.removed).toBeGreaterThan(0);
    const restored = await persistence.restoreNotifications("user-1", NOW);
    expect(restored.count()).toBe(0);
  });
});

describe("saveTemplates / restoreTemplates", () => {
  it("persists and restores templates", async () => {
    const persistence = createNotificationPersistence();
    const template = createNotificationTemplate({
      name: "greeting",
      body: "Hi {{name}}",
      subject: "Greetings {{name}}",
      variables: [{ name: "name" }],
      createdAt: NOW,
    });
    const registry = createTemplateRegistry({ templates: [template] });

    await persistence.saveTemplates("user-1", registry, NOW);
    const restored = await persistence.restoreTemplates("user-1");
    expect(restored.list()).toHaveLength(1);
    expect(restored.get(template.id)?.name).toBe("greeting");
  });

  it("restores an empty registry from empty storage", async () => {
    const persistence = createNotificationPersistence();
    const restored = await persistence.restoreTemplates("user-1");
    expect(restored.list()).toHaveLength(0);
  });
});

describe("savePreferences / restorePreferences", () => {
  it("persists and restores preferences with subscriptions and rules", async () => {
    const persistence = createNotificationPersistence();
    const engine = new NotificationPreferenceEngine();
    engine.setDigestMode("user-1", true, NOW);
    engine.setPreferredChannels("user-1", ["email", "inapp"], NOW);
    engine.subscribe("user-1", "product-updates", ["email"], NOW);
    engine.addRule({
      userId: "user-1",
      category: "promotions",
      channel: "email",
      enabled: false,
      createdAt: NOW,
    });

    await persistence.savePreferences("user-1", engine, NOW);
    const restored = await persistence.restorePreferences("user-1");
    expect(restored.listPreferences()).toHaveLength(1);
    expect(restored.getPreference("user-1")?.digestMode).toBe(true);
    expect(restored.preferredChannels("user-1")).toContain("email");
    expect(restored.listSubscriptions("user-1")).toHaveLength(1);
    expect(restored.listRules("user-1")).toHaveLength(1);
  });

  it("restores an empty preference engine from empty storage", async () => {
    const persistence = createNotificationPersistence();
    const restored = await persistence.restorePreferences("user-1");
    expect(restored.listPreferences()).toHaveLength(0);
  });
});

describe("saveReport / restoreReports", () => {
  it("persists and restores a report snapshot", async () => {
    const persistence = createNotificationPersistence();
    const report = { id: "report-1", at: NOW, statistics: { total: 3 } };
    await persistence.saveReport("user-1", report, NOW);
    const restored = await persistence.restoreReports("user-1");
    expect(restored).toHaveLength(1);
    expect((restored[0] as { id: string }).id).toBe("report-1");
  });
});

describe("saveAll / restoreAll", () => {
  it("persists and restores the whole notification domain", async () => {
    const persistence = createNotificationPersistence();
    const delivery = deliveryWith(okTransport());
    await delivery.send(sendInput({ id: "n-1" }), NOW);
    const preferences = new NotificationPreferenceEngine();
    preferences.setDigestMode("user-1", true, NOW);
    const template = createNotificationTemplate({
      name: "t",
      body: "Body",
      createdAt: NOW,
    });
    const templates = createTemplateRegistry({ templates: [template] });

    const { results, errors } = await persistence.saveAll(
      "user-1",
      { delivery, preferences, templates },
      NOW,
    );
    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(3);

    const restored = await persistence.restoreAll("user-1");
    expect(restored.errors).toHaveLength(0);
    expect(restored.delivery.count()).toBe(1);
    expect(restored.delivery.find("n-1")?.status).toBe("delivered");
    expect(restored.preferences.getPreference("user-1")?.digestMode).toBe(true);
    expect(restored.templates.list()).toHaveLength(1);
  });

  it("isolates per-domain restore failures", async () => {
    const persistence = createNotificationPersistence();
    // Corrupt the template storage directly.
    const database = persistence.database;
    await database.driver.upsertAll("user-1", "notification_template", [
      {
        id: "bad",
        scope: "user-1",
        collection: "notification_template",
        recordId: "tpl-1",
        revision: 1,
        version: 1,
        archived: false,
        archivedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        data: { id: "tpl-1" },
      },
    ]);
    const restored = await persistence.restoreAll("user-1");
    expect(restored.errors.length).toBeGreaterThan(0);
    // Other domains still restore.
    expect(restored.delivery).toBeDefined();
    expect(restored.templates.list()).toHaveLength(0);
  });
});

describe("hasData / clear", () => {
  it("reports no data on an empty scope", async () => {
    const persistence = createNotificationPersistence();
    expect(await persistence.hasData("user-1")).toBe(false);
  });

  it("reports data after a save", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(okTransport());
    await engine.send(sendInput({ id: "n-1" }), NOW);
    await persistence.saveNotifications("user-1", engine, NOW);
    expect(await persistence.hasData("user-1")).toBe(true);
  });

  it("clears every notification-domain row", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(okTransport());
    await engine.send(sendInput({ id: "n-1" }), NOW);
    await persistence.saveNotifications("user-1", engine, NOW);
    expect(await persistence.hasData("user-1")).toBe(true);
    await persistence.clear("user-1");
    expect(await persistence.hasData("user-1")).toBe(false);
  });
});

describe("restart recovery across database instances", () => {
  it("restores notification state over the same driver (simulated restart)", async () => {
    const driver = new MemoryDatabaseDriver();
    const first = createNotificationPersistence({ database: new DatabaseEngine({ driver }) });
    const engine = deliveryWith(okTransport());
    await engine.send(sendInput({ id: "survive-1" }), NOW);
    await first.saveNotifications("user-1", engine, NOW);

    // Simulated restart: a fresh persistence over the same driver.
    const second = createNotificationPersistence({ database: new DatabaseEngine({ driver }) });
    const restored = await second.restoreNotifications("user-1", NOW);
    expect(restored.count()).toBe(1);
    expect(restored.find("survive-1")?.status).toBe("delivered");
    expect(await second.hasData("user-1")).toBe(true);
  });
});

describe("immutability & determinism", () => {
  it("does not mutate the source engine when saving", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(okTransport());
    await engine.send(sendInput({ id: "n-1" }), NOW);
    const before = engine.snapshot(NOW);
    await persistence.saveNotifications("user-1", engine, NOW);
    const after = engine.snapshot(NOW);
    expect(after.notifications).toEqual(before.notifications);
    expect(engine.count()).toBe(1);
  });

  it("produces deterministic restore results for identical inputs", async () => {
    const driver = new MemoryDatabaseDriver();
    const a = createNotificationPersistence({ database: new DatabaseEngine({ driver }) });
    const b = createNotificationPersistence({ database: new DatabaseEngine({ driver }) });
    const engineA = deliveryWith(okTransport());
    const engineB = deliveryWith(okTransport());
    await engineA.send(sendInput({ id: "det-1" }), NOW);
    await engineB.send(sendInput({ id: "det-1" }), NOW);
    await a.saveNotifications("user-1", engineA, NOW);
    await b.saveNotifications("user-1", engineB, NOW);
    const restoredA = await a.restoreNotifications("user-1", NOW);
    const restoredB = await b.restoreNotifications("user-1", NOW);
    expect(restoredA.find("det-1")?.id).toBe(restoredB.find("det-1")?.id);
    expect(restoredA.find("det-1")?.status).toBe(restoredB.find("det-1")?.status);
  });

  it("restored engines are independent from the source", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(okTransport());
    await engine.send(sendInput({ id: "n-1" }), NOW);
    await persistence.saveNotifications("user-1", engine, NOW);
    const restored = await persistence.restoreNotifications("user-1", NOW);
    await restored.send(sendInput({ id: "n-2" }), NOW);
    // Source engine unaffected.
    expect(engine.count()).toBe(1);
    expect(restored.count()).toBe(2);
  });

  it("persists caller-supplied timestamps verbatim", async () => {
    const persistence = createNotificationPersistence();
    const engine = deliveryWith(okTransport());
    await engine.send(sendInput({ id: "n-1" }), NOW);
    await persistence.saveNotifications("user-1", engine, LATER);
    const stored = await persistence.database.driver.readAll("user-1", "notification");
    expect(stored[0]?.createdAt).toBe(LATER);
  });
});

describe("preference rule persistence", () => {
  it("persists rules with all fields", async () => {
    const persistence = createNotificationPersistence();
    const engine = new NotificationPreferenceEngine();
    const rule = createNotificationPreferenceRule({
      userId: "user-1",
      category: "promotions",
      channel: "email",
      priority: "high",
      enabled: false,
      createdAt: NOW,
    });
    engine.addRule({
      userId: rule.userId,
      category: rule.category,
      channel: rule.channel,
      priority: rule.priority,
      enabled: false,
      createdAt: NOW,
    });
    await persistence.savePreferences("user-1", engine, NOW);
    const restored = await persistence.restorePreferences("user-1");
    const rules = restored.listRules("user-1");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.category).toBe("promotions");
    expect(rules[0]?.enabled).toBe(false);
  });
});
