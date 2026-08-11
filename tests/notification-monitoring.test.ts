/**
 * Phase 6D STEP 9 — notifications monitoring integration tests.
 */
import { describe, expect, it } from "vitest";
import {
  NotificationMonitoringBridge,
  createNotificationMonitoringBridge,
  NOTIFICATION_METRIC_DOMAIN,
  NOTIFICATION_HEALTH_COMPONENT,
  NOTIFICATION_ALERT_TYPE,
} from "@/lib/notifications/monitoring";
import { createProductionMonitoringEngine } from "@/lib/monitoring/production";
import { createNotificationHealth } from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:00:01.000Z";

describe("bridge construction", () => {
  it("builds a fresh bridge over a fresh monitoring engine", () => {
    const bridge = createNotificationMonitoringBridge();
    expect(bridge.monitoringEngine()).toBeDefined();
    expect(bridge.counts().delivered).toBe(0);
  });

  it("accepts an injected monitoring engine", () => {
    const engine = createProductionMonitoringEngine();
    const bridge = new NotificationMonitoringBridge({ engine });
    expect(bridge.monitoringEngine()).toBe(engine);
  });

  it("withEngine replaces the wrapped engine", () => {
    const bridge = createNotificationMonitoringBridge();
    const engine = createProductionMonitoringEngine();
    bridge.withEngine(engine);
    expect(bridge.monitoringEngine()).toBe(engine);
  });
});

describe("logs", () => {
  it("records structured entries under the notifications scope", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.info("notification sent", NOW);
    bridge.error("delivery failed", LATER);
    const engine = bridge.monitoringEngine();
    const entries = engine.logger.list();
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.scope.name === "notifications")).toBe(true);
  });

  it("records failure logs with context", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.observeFailure({
      notificationId: "n1",
      code: "timeout",
      message: "slow",
      attempt: 2,
      at: NOW,
    });
    const entries = bridge.monitoringEngine().logger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("warn");
    expect(entries[0]?.context?.notificationId).toBe("n1");
  });
});

describe("metrics", () => {
  it("records delivery latency and outcome counters", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.observeDelivery({
      notificationId: "n1",
      ok: true,
      durationMs: 42,
      channel: "email",
      at: NOW,
    });
    bridge.observeDelivery({
      notificationId: "n2",
      ok: false,
      durationMs: 10,
      channel: "email",
      at: LATER,
    });
    expect(bridge.counts().delivered).toBe(1);
    expect(bridge.counts().failed).toBe(1);
    const series = bridge.deliveryLatencySeries();
    expect(series).toHaveLength(2);
    expect(series.map((entry) => entry.durationMs)).toEqual([42, 10]);
    const samples = bridge.monitoringEngine().metrics.find(NOTIFICATION_METRIC_DOMAIN);
    expect(samples.length).toBeGreaterThan(0);
  });

  it("records retry observations", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.observeRetry("n1", 2, NOW);
    expect(bridge.counts().retried).toBe(1);
  });

  it("records dead-letter observations", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.observeFailure({
      notificationId: "n1",
      code: "budget_exhausted",
      message: "no retries left",
      attempt: 3,
      at: NOW,
    });
    expect(bridge.counts().dead).toBe(1);
  });

  it("records queue depth gauges", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.observeQueueDepth({
      at: NOW,
      pending: 3,
      delayed: 2,
      retry: 1,
      deadLetter: 0,
    });
    expect(bridge.queueDepth()).toEqual({ pending: 3, delayed: 2, retry: 1, deadLetter: 0 });
  });

  it("records the failure rate gauge", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.observeFailureRate(0.25, NOW);
    expect(bridge.failureRate()).toBe(0.25);
  });

  it("gauge samples are deterministic", () => {
    const a = createNotificationMonitoringBridge();
    const b = createNotificationMonitoringBridge();
    a.gauge("notification.queue.total", 5, NOW);
    b.gauge("notification.queue.total", 5, NOW);
    expect(a.monitoringEngine().metrics.find(NOTIFICATION_METRIC_DOMAIN, "notification.queue.total")[0]?.id).toBe(
      b.monitoringEngine().metrics.find(NOTIFICATION_METRIC_DOMAIN, "notification.queue.total")[0]?.id,
    );
  });
});

describe("tracing & profiling", () => {
  it("opens and closes a dispatch span with notification attributes", () => {
    const bridge = createNotificationMonitoringBridge();
    const { spanId } = bridge.startDispatchSpan("n1", NOW);
    bridge.finishDispatchSpan(spanId, LATER);
    const span = bridge.monitoringEngine().traces.find(spanId);
    expect(span?.kind).toBe("notification");
    expect(span?.attributes?.notificationId).toBe("n1");
    expect(span?.finishedAt).toBe(LATER);
    expect(span?.durationMs).toBe(1000);
  });

  it("closes a failed dispatch span with an error", () => {
    const bridge = createNotificationMonitoringBridge();
    const { spanId } = bridge.startDispatchSpan("n1", NOW);
    bridge.finishDispatchSpan(spanId, LATER, { code: "timeout", message: "slow" });
    expect(bridge.monitoringEngine().traces.find(spanId)?.error?.code).toBe("timeout");
  });

  it("records delivery profile samples on the notification stage", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.profile({ name: "notification.delivery", durationMs: 25, startedAt: NOW });
    const samples = bridge.monitoringEngine().profiler.find("notification");
    expect(samples).toHaveLength(1);
    expect(samples[0]?.durationMs).toBe(25);
  });
});

describe("health", () => {
  it("registers a notification_engine probe derived from NotificationHealth", async () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.registerHealthProbe(NOW, createNotificationHealth({ status: "healthy", score: 1, lastCheckedAt: NOW }));
    const engine = bridge.monitoringEngine();
    expect(engine.health.hasProbe(NOTIFICATION_HEALTH_COMPONENT)).toBe(true);
    const { report } = await engine.runHealthChecks(NOW);
    expect(report.entries[0]?.component).toBe(NOTIFICATION_HEALTH_COMPONENT);
    expect(report.entries[0]?.status).toBe("healthy");
  });

  it("maps degraded health to warning", async () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.registerHealthProbe(NOW, createNotificationHealth({ status: "degraded", score: 0.8, lastCheckedAt: NOW }));
    const { report } = await bridge.monitoringEngine().runHealthChecks(NOW);
    expect(report.entries[0]?.status).toBe("warning");
  });

  it("maps unhealthy health to critical", async () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.registerHealthProbe(NOW, createNotificationHealth({ status: "unhealthy", score: 0.2, lastCheckedAt: NOW }));
    const { report } = await bridge.monitoringEngine().runHealthChecks(NOW);
    expect(report.entries[0]?.status).toBe("critical");
  });
});

describe("alerts", () => {
  it("raises notification_failure alerts with an ensured rule", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.raiseNotificationAlert({
      entityId: "n1",
      key: "notification_failure:n1",
      message: "delivery failed",
      createdAt: NOW,
    });
    const engine = bridge.monitoringEngine();
    expect(engine.hasAlertRule(NOTIFICATION_ALERT_TYPE)).toBe(true);
    const alerts = engine.alerts.list();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.type).toBe(NOTIFICATION_ALERT_TYPE);
    expect(alerts[0]?.entityId).toBe("n1");
  });

  it("does not duplicate the rule on repeated raises", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.raiseNotificationAlert({
      entityId: "n1",
      key: "k1",
      message: "m",
      createdAt: NOW,
    });
    bridge.raiseNotificationAlert({
      entityId: "n2",
      key: "k2",
      message: "m",
      createdAt: LATER,
    });
    const engine = bridge.monitoringEngine();
    expect(engine.alerts.ruleCount()).toBe(1);
    expect(engine.alerts.count()).toBe(2);
  });
});

describe("audit", () => {
  it("records audit entries with the api_mutation action", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.audit({
      actor: "system",
      resource: "notification.n1",
      resourceId: "n1",
      timestamp: NOW,
      outcome: "success",
    });
    const entries = bridge.monitoringEngine().audit.forAction("api_mutation");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.resource).toBe("notification.n1");
  });
});

describe("snapshot & reads", () => {
  it("produces a combined monitoring snapshot", () => {
    const bridge = createNotificationMonitoringBridge();
    bridge.observeDelivery({ notificationId: "n1", ok: true, durationMs: 5, at: NOW });
    bridge.observeQueueDepth({ at: NOW, pending: 1, delayed: 0, retry: 0, deadLetter: 0 });
    const snapshot = bridge.snapshot(LATER);
    expect(snapshot.at).toBe(LATER);
    expect(snapshot.metrics.samples.length).toBeGreaterThan(0);
    expect(snapshot.logs.entries.length).toBe(0);
  });

  it("queueDepth and failureRate default to zero on fresh bridges", () => {
    const bridge = createNotificationMonitoringBridge();
    expect(bridge.queueDepth()).toEqual({ pending: 0, delayed: 0, retry: 0, deadLetter: 0 });
    expect(bridge.failureRate()).toBe(0);
  });
});
