import { describe, it, expect } from "vitest";
import {
  MonitoringEngine,
  createProductionMonitoringEngine,
  getProductionMonitoringEngine,
} from "@/lib/monitoring/production";
import { Logger } from "@/lib/monitoring/logger";
import { MetricCollector } from "@/lib/monitoring/metrics";
import { TraceStore } from "@/lib/monitoring/tracing";
import { ProfileCollector } from "@/lib/monitoring/profiler";
import { HealthRegistry, healthyProbe } from "@/lib/monitoring/health";
import { AlertRegistry, createAlertRule } from "@/lib/monitoring/alerts";
import { AuditStore } from "@/lib/monitoring/audit";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

describe("MonitoringEngine construction", () => {
  it("wires fresh immutable collectors by default", () => {
    const engine = createProductionMonitoringEngine();
    expect(engine.logger).toBeInstanceOf(Logger);
    expect(engine.metrics).toBeInstanceOf(MetricCollector);
    expect(engine.traces).toBeInstanceOf(TraceStore);
    expect(engine.profiler).toBeInstanceOf(ProfileCollector);
    expect(engine.health).toBeInstanceOf(HealthRegistry);
    expect(engine.alerts).toBeInstanceOf(AlertRegistry);
    expect(engine.audit).toBeInstanceOf(AuditStore);
    expect(engine.logger.count()).toBe(0);
    expect(engine.metrics.count()).toBe(0);
    expect(engine.traces.count()).toBe(0);
  });

  it("accepts injected collectors", () => {
    const logger = new Logger();
    const metrics = new MetricCollector();
    const engine = new MonitoringEngine({ logger, metrics });
    expect(engine.logger).toBe(logger);
    expect(engine.metrics).toBe(metrics);
  });
});

describe("engine facades", () => {
  it("log updates the logger in place", () => {
    const engine = createProductionMonitoringEngine();
    const { engine: next, entry } = engine.info("boot", NOW, { scope: { name: "api" } });
    expect(entry?.message).toBe("boot");
    expect(next.logger.count()).toBe(1);
  });

  it("metric/increment/latency update the collector", () => {
    const engine = createProductionMonitoringEngine();
    const { engine: a } = engine.increment("api", "requests", NOW, 2);
    const { engine: b } = a.latency("api", "latency", 15, NOW);
    expect(b.metrics.count()).toBe(2);
    expect(b.metrics.statistics().sum).toBe(17);
    const report = b.metricsReport(LATER);
    expect(report.at).toBe(LATER);
  });

  it("startSpan/finishSpan update the trace store", () => {
    const engine = createProductionMonitoringEngine();
    const { engine: a, span } = engine.startSpan({ kind: "api", name: "req", startedAt: NOW });
    const { engine: b } = a.finishSpan(span.id, LATER);
    expect(b.traces.statistics().finishedSpans).toBe(1);
    expect(b.traces.statistics().openSpans).toBe(0);
  });

  it("profile and measure update the profiler", async () => {
    const engine = createProductionMonitoringEngine();
    const { engine: a } = engine.profile({
      stage: "tool",
      name: "search",
      durationMs: 3,
      startedAt: NOW,
    });
    expect(a.profiler.count()).toBe(1);
    let clock = 10;
    const { engine: b, durationMs } = await a.measure(
      { stage: "api", name: "req", startedAt: NOW, clockMs: () => clock },
      async () => {
        clock = 25;
        return "ok";
      },
    );
    expect(durationMs).toBe(15);
    expect(b.profiler.count()).toBe(2);
  });

  it("health probes register and run", async () => {
    const engine = createProductionMonitoringEngine();
    const engine2 = engine.registerHealthProbe(healthyProbe("database"));
    expect(engine2.health.count()).toBe(1);
    const { engine: engine3, report } = await engine2.runHealthChecks(NOW);
    expect(report.entries).toHaveLength(1);
    expect(report.summary.overall).toBe("healthy");
    expect(engine3.healthOf("database")?.status).toBe("healthy");
  });

  it("alert rules and alerts flow through the engine", () => {
    const engine = createProductionMonitoringEngine();
    const engine2 = engine.registerAlertRule(
      createAlertRule({ type: "worker_failure", severity: "warning" }),
    );
    expect(engine2.hasAlertRule("worker_failure")).toBe(true);
    const ruleId = engine2.alerts.rulesForType("worker_failure")[0]?.id ?? "";
    const { engine: engine3, alert: raised } = engine2.raiseAlert({
      ruleId,
      type: "worker_failure",
      severity: "warning",
      entityId: "w1",
      key: "worker_failure:w1",
      message: "down",
      createdAt: NOW,
    });
    expect(raised.status).toBe("firing");
    expect(engine3.alerts.count()).toBe(1);
    const engine4 = engine3.acknowledgeAlert(raised.id, LATER, "ops");
    expect(engine4.alerts.findById(raised.id)?.status).toBe("acknowledged");
    const engine5 = engine4.resolveAlert(raised.id, LATER);
    expect(engine5.alerts.findById(raised.id)?.status).toBe("resolved");
    const engine6 = engine5.retryAlert(raised.id, LATER);
    expect(engine6.alerts.findById(raised.id)?.status).toBe("firing");
  });

  it("audit entries flow through the engine", () => {
    const engine = createProductionMonitoringEngine();
    const { engine: a, entry } = engine.auditRecord({
      actor: "user-1",
      resource: "conversation",
      action: "conversation_update",
      timestamp: NOW,
    });
    expect(entry.action).toBe("conversation_update");
    expect(a.auditFor("conversation_update")).toHaveLength(1);
    expect(a.auditStatistics().total).toBe(1);
  });

  it("snapshot combines every collector at `at`", () => {
    const engine = createProductionMonitoringEngine();
    const { engine: a } = engine.increment("api", "requests", NOW);
    const snapshot = a.snapshot(LATER);
    expect(snapshot.at).toBe(LATER);
    expect(snapshot.metrics.samples).toHaveLength(1);
    expect(snapshot.logs.statistics.total).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("production singleton", () => {
  it("exposes a single engine instance", () => {
    expect(getProductionMonitoringEngine()).toBe(getProductionMonitoringEngine());
    expect(getProductionMonitoringEngine()).toBeInstanceOf(MonitoringEngine);
  });

  it("createProductionMonitoringEngine builds fresh engines", () => {
    expect(createProductionMonitoringEngine()).not.toBe(createProductionMonitoringEngine());
  });
});
