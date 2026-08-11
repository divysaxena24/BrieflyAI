/**
 * Phase 6D STEP 12 — notification production composition tests.
 */
import { describe, expect, it } from "vitest";
import {
  createProductionNotificationEngine,
  getProductionNotificationEngine,
  NotificationEngine,
} from "@/lib/notifications/production";
import { NotificationDeliveryEngine } from "@/lib/notifications/delivery";
import { NotificationPreferenceEngine } from "@/lib/notifications/preferences";
import { createTemplateRegistry } from "@/lib/notifications/templates";
import { createNotificationMonitoringBridge } from "@/lib/notifications/monitoring";
import { createNotificationPersistence } from "@/lib/notifications/persistence";
import { createNotificationBackgroundEngine } from "@/lib/notifications/background";
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
  createNotificationTemplate,
} from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";

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

function channelsFor(transport: NotificationTransport) {
  return createNotificationChannelRegistry({
    channels: [
      createEmailChannel({ transport }),
      createInAppChannel({ transport }),
      createMockChannel({ transport }),
    ],
  });
}

function deliveryWith(transport: NotificationTransport): NotificationDeliveryEngine {
  return new NotificationDeliveryEngine({
    channels: channelsFor(transport),
    config: createNotificationConfiguration(),
    now: () => NOW,
    clockMs: () => 0,
  });
}

function sendInput() {
  return {
    title: "Hello",
    body: "World",
    recipients: [createNotificationRecipient({ channel: "email", address: "user@example.com" })],
  };
}

describe("createProductionNotificationEngine", () => {
  it("wires every sub-engine fresh", () => {
    const engine = createProductionNotificationEngine();
    expect(engine).toBeInstanceOf(NotificationEngine);
    expect(engine.delivery).toBeInstanceOf(NotificationDeliveryEngine);
    expect(engine.preferences).toBeInstanceOf(NotificationPreferenceEngine);
    expect(engine.templates.list()).toHaveLength(0);
    expect(engine.monitoring).toBeDefined();
    expect(engine.persistence).toBeDefined();
    expect(engine.background).toBeDefined();
  });

  it("returns fresh instances per factory call (no shared state)", () => {
    const a = createProductionNotificationEngine();
    const b = createProductionNotificationEngine();
    expect(a).not.toBe(b);
    expect(a.delivery).not.toBe(b.delivery);
  });

  it("accepts injected sub-engines (dependency injection)", () => {
    const delivery = deliveryWith(okTransport());
    const preferences = new NotificationPreferenceEngine();
    const templates = createTemplateRegistry();
    const monitoring = createNotificationMonitoringBridge();
    const persistence = createNotificationPersistence();
    const background = createNotificationBackgroundEngine({ delivery, preferences, monitoring });
    const engine = createProductionNotificationEngine({
      delivery,
      preferences,
      templates,
      monitoring,
      persistence,
      background,
      now: () => NOW,
    });
    expect(engine.delivery).toBe(delivery);
    expect(engine.preferences).toBe(preferences);
    expect(engine.templates).toBe(templates);
    expect(engine.monitoring).toBe(monitoring);
    expect(engine.persistence).toBe(persistence);
    expect(engine.background).toBe(background);
  });
});

describe("getProductionNotificationEngine", () => {
  it("is a stable module singleton", () => {
    expect(getProductionNotificationEngine()).toBe(getProductionNotificationEngine());
    expect(getProductionNotificationEngine()).toBeInstanceOf(NotificationEngine);
  });

  it("is distinct from fresh factories", () => {
    expect(getProductionNotificationEngine()).not.toBe(createProductionNotificationEngine());
  });
});

describe("delivery facade", () => {
  it("sends a notification through the delivery engine", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const result = await engine.send(sendInput(), NOW);
    expect(result.notification.status).toBe("delivered");
    expect(engine.listNotifications()).toHaveLength(1);
    expect(engine.findNotification(result.notification.id)?.title).toBe("Hello");
  });

  it("dispatches scheduled notifications on dispatch()", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const later = "2026-08-11T09:01:00.000Z";
    await engine.delivery.send(sendInput(), NOW);
    const result = await engine.send(
      { ...sendInput(), id: "sched-1", scheduledAt: later },
      NOW,
    );
    expect(engine.findNotification(result.notification.id)?.status).toBe("queued");
    const { summary } = await engine.dispatch(later);
    expect(summary.delivered).toBe(1);
  });

  it("cancels a queued notification", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const later = "2026-08-11T09:01:00.000Z";
    await engine.delivery.send({ ...sendInput(), id: "c-1", scheduledAt: later }, NOW);
    const { notification } = engine.cancel("c-1", NOW);
    expect(notification.status).toBe("cancelled");
  });
});

describe("template facade", () => {
  it("renders registered templates on send", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const template = createNotificationTemplate({
      name: "greeting",
      body: "Hi {{name}}",
      subject: "Subject {{name}}",
      variables: [{ name: "name" }],
      createdAt: NOW,
    });
    engine.withTemplates(engine.templates.register(template));
    const result = await engine.send(
      {
        title: "x",
        body: "y",
        templateId: template.id,
        templateVariables: { name: "Ada" },
        recipients: [createNotificationRecipient({ channel: "email", address: "user@example.com" })],
      },
      NOW,
    );
    expect(result.notification.body).toBe("Hi Ada");
    expect(result.notification.title).toBe("Subject Ada");
  });
});

describe("background facade", () => {
  it("runs the background pipeline through the engine", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const later = "2026-08-11T09:01:00.000Z";
    await engine.delivery.send({ ...sendInput(), id: "due-1", scheduledAt: later }, NOW);
    const { summary } = await engine.runAll(later);
    expect(summary.dispatched).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(engine.findNotification("due-1")?.status).toBe("delivered");
  });

  it("recovers queued work after a simulated restart", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const later = "2026-08-11T09:01:00.000Z";
    await engine.delivery.send({ ...sendInput(), id: "r-1", scheduledAt: later }, NOW);
    const { summary } = await engine.recover(later);
    expect(engine.findNotification("r-1")?.status).toBe("delivered");
    expect(summary.dispatched).toBe(1);
  });
});

describe("persistence facade", () => {
  it("saves and restores the whole notification domain", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    engine.preferences.setDigestMode("user-1", true, NOW);
    await engine.delivery.send({ ...sendInput(), id: "p-1" }, NOW);

    const { errors } = await engine.saveAll("user-1", NOW);
    expect(errors).toHaveLength(0);
    expect(await engine.hasData("user-1")).toBe(true);

    const restored = await engine.restoreAll("user-1");
    expect(restored.errors).toHaveLength(0);
    expect(restored.delivery.count()).toBe(1);
    expect(restored.delivery.find("p-1")?.status).toBe("delivered");
    expect(restored.preferences.getPreference("user-1")?.digestMode).toBe(true);
  });

  it("clears stored data", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    await engine.delivery.send(sendInput(), NOW);
    await engine.saveAll("user-1", NOW);
    expect(await engine.hasData("user-1")).toBe(true);
    await engine.clear("user-1");
    expect(await engine.hasData("user-1")).toBe(false);
  });
});

describe("monitoring facade", () => {
  it("exposes a monitoring snapshot", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const snapshot = engine.monitoringSnapshot(NOW);
    expect(snapshot.at).toBe(NOW);
    expect(snapshot.logs).toBeDefined();
    expect(snapshot.metrics).toBeDefined();
  });

  // Regression: inline facade sends must be observable — the worker
  // `runDispatch` observations must not be the only delivery metrics.
  it("records delivery metrics for inline facade sends", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    await engine.send(sendInput(), NOW);
    const snapshot = engine.monitoringSnapshot(NOW);
    const names = snapshot.metrics.samples.map((sample) => sample.name);
    expect(names).toContain("notification.delivered");
    expect(engine.monitoring.counts().delivered).toBe(1);
  });

  it("records delivery metrics for inline facade batch sends", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    await engine.sendBatch([sendInput(), sendInput()], NOW);
    const snapshot = engine.monitoringSnapshot(NOW);
    const names = snapshot.metrics.samples.map((sample) => sample.name);
    expect(names).toContain("notification.delivered");
    expect(engine.monitoring.counts().delivered).toBe(2);
  });

  it("records dead-letter observations for failing inline facade sends", async () => {
    const failing = new ScriptedTransport(() => ({
      ok: false,
      error: { code: "provider_error", message: "down", retryable: true },
    }));
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(failing),
      now: () => NOW,
    });
    // Default budget (maxRetries 0): the first failure dead-letters.
    await engine.send(sendInput(), NOW);
    const snapshot = engine.monitoringSnapshot(NOW);
    const names = snapshot.metrics.samples.map((sample) => sample.name);
    expect(names).toContain("notification.dead");
    expect(engine.monitoring.counts().dead).toBe(1);
  });
});

describe("successor wiring", () => {
  it("replaces the delivery engine and re-wires the background engine", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const replacement = deliveryWith(okTransport());
    engine.withDelivery(replacement);
    expect(engine.delivery).toBe(replacement);
    expect(engine.background.delivery).toBe(replacement);
  });

  it("replaces the preference engine and re-wires the background engine", () => {
    const engine = createProductionNotificationEngine({ now: () => NOW });
    const replacement = new NotificationPreferenceEngine();
    replacement.setDigestMode("u", true, NOW);
    engine.withPreferences(replacement);
    expect(engine.preferences).toBe(replacement);
    expect(engine.background.preferences).toBe(replacement);
  });

  it("replaces the template registry and persistence adapter", () => {
    const engine = createProductionNotificationEngine({ now: () => NOW });
    const templates = createTemplateRegistry();
    const persistence = createNotificationPersistence();
    engine.withTemplates(templates);
    engine.withPersistence(persistence);
    expect(engine.templates).toBe(templates);
    expect(engine.persistence).toBe(persistence);
  });
});

describe("determinism & immutability", () => {
  it("produces identical notification ids for identical sends", async () => {
    const a = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const b = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const ra = await a.send(sendInput(), NOW);
    const rb = await b.send(sendInput(), NOW);
    expect(ra.notification.id).toBe(rb.notification.id);
  });

  it("does not mutate caller inputs", async () => {
    const engine = createProductionNotificationEngine({
      delivery: deliveryWith(okTransport()),
      now: () => NOW,
    });
    const input = sendInput();
    await engine.send(input, NOW);
    expect(input.recipients[0]?.channel).toBe("email");
    expect(Object.isFrozen(input.recipients[0])).toBe(true);
  });
});
