import { describe, it, expect } from "vitest";
import {
  auditActionForEvent,
  monitorActionRun,
  monitorApiOp,
  monitorDatabaseOp,
  monitorDigestRun,
  monitorJobRun,
  monitorPlannerRun,
  monitorPersistenceOp,
  monitorToolRun,
  monitorWorkerRun,
  monitorWorkflowRun,
  observeAppEvent,
} from "@/lib/monitoring/integration";
import { createProductionMonitoringEngine } from "@/lib/monitoring/production";
import { createAppEvent } from "@/lib/events/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

describe("monitorRun (generic)", () => {
  it("records metrics, profile and audit on success", async () => {
    const engine = createProductionMonitoringEngine();
    const { result, durationMs } = await monitorWorkerRun(
      engine,
      { now: NOW, entityId: "w1", clockMs: () => 100 },
      async () => ({ completed: 3, failed: 0, cancelled: 0 }),
    );
    expect(result.completed).toBe(3);
    expect(durationMs).toBe(0);
    expect(engine.metrics.count()).toBeGreaterThanOrEqual(3);
    expect(engine.profiler.count()).toBe(1);
    expect(engine.audit.count()).toBe(1);
  });

  it("isolates failures into logs, metrics and alerts then rethrows", async () => {
    const engine = createProductionMonitoringEngine();
    await expect(
      monitorWorkflowRun(
        engine,
        { now: NOW, entityId: "wf-1" },
        async () => {
          throw new Error("wf exploded");
        },
      ),
    ).rejects.toThrow("wf exploded");
    expect(engine.logger.count()).toBe(1);
    expect(engine.logger.statistics().byLevel.error).toBe(1);
    expect(engine.metrics.find("workflows", "workflow.run.failed")).toHaveLength(1);
    expect(engine.alerts.count()).toBe(1);
    expect(engine.alerts.statistics().firing).toBe(1);
    expect(engine.audit.count()).toBe(1);
    expect(engine.audit.statistics().failures).toBe(1);
  });

  it("measures duration through the injected clock", async () => {
    const engine = createProductionMonitoringEngine();
    let clock = 10;
    const { durationMs } = await monitorToolRun(
      engine,
      { now: NOW, clockMs: () => clock },
      async () => {
        clock = 40;
        return "done";
      },
    );
    expect(durationMs).toBe(30);
    expect(engine.metrics.find("tool", "tool.run.duration")[0]?.value).toBe(30);
  });

  it("records a finished span on success", async () => {
    const engine = createProductionMonitoringEngine();
    await monitorDatabaseOp(engine, { now: NOW, entityId: "db-1" }, async () => "ok");
    expect(engine.traces.count()).toBe(1);
    expect(engine.traces.statistics().finishedSpans).toBe(1);
  });
});

describe("domain hooks", () => {
  it("monitorJobRun records job metrics", async () => {
    const engine = createProductionMonitoringEngine();
    await monitorJobRun(engine, { now: NOW }, async () => "done");
    expect(engine.metrics.find("jobs", "job.run.completed")).toHaveLength(1);
    expect(engine.audit.forAction("job_execution")).toHaveLength(1);
  });

  it("monitorActionRun records action metrics", async () => {
    const engine = createProductionMonitoringEngine();
    await monitorActionRun(engine, { now: NOW }, async () => "done");
    expect(engine.metrics.find("actions", "action.run.completed")).toHaveLength(1);
  });

  it("monitorPlannerRun records planner metrics", async () => {
    const engine = createProductionMonitoringEngine();
    await monitorPlannerRun(engine, { now: NOW }, async () => "plan");
    expect(engine.metrics.find("planner", "planner.run.completed")).toHaveLength(1);
  });

  it("monitorDigestRun records digest metrics", async () => {
    const engine = createProductionMonitoringEngine();
    await monitorDigestRun(engine, { now: NOW }, async () => "digest");
    expect(engine.metrics.find("digest", "digest.build.completed")).toHaveLength(1);
  });

  it("monitorPersistenceOp records persistence metrics", async () => {
    const engine = createProductionMonitoringEngine();
    await monitorPersistenceOp(engine, { now: NOW }, async () => "saved");
    expect(engine.metrics.find("persistence", "persistence.op.completed")).toHaveLength(1);
  });

  it("monitorApiOp records api metrics", async () => {
    const engine = createProductionMonitoringEngine();
    await monitorApiOp(engine, { now: NOW }, async () => "ok");
    expect(engine.metrics.find("api", "api.op.completed")).toHaveLength(1);
  });

  it("monitorWorkerRun aggregates pass totals", async () => {
    const engine = createProductionMonitoringEngine();
    await monitorWorkerRun(
      engine,
      { now: NOW },
      async () => ({ completed: 2, failed: 1, cancelled: 1 }),
    );
    expect(engine.metrics.find("workers", "worker.pass.completed")[0]?.value).toBe(2);
    expect(engine.metrics.find("workers", "worker.pass.failed")[0]?.value).toBe(1);
    expect(engine.metrics.find("workers", "worker.pass.cancelled")[0]?.value).toBe(1);
    expect(engine.metrics.find("workers", "worker.run.completed")).toHaveLength(1);
  });
});

describe("event observation", () => {
  it("auditActionForEvent maps every event kind", () => {
    expect(auditActionForEvent(createAppEvent({ type: "conversation.updated", entityId: "c1", now: NOW }))).toBe("conversation_update");
    expect(auditActionForEvent(createAppEvent({ type: "memory.stored", entityId: "m1", now: NOW }))).toBe("memory_change");
    expect(auditActionForEvent(createAppEvent({ type: "digest.published", entityId: "d1", now: NOW }))).toBe("api_mutation");
    expect(auditActionForEvent(createAppEvent({ type: "workflow.triggered", entityId: "w1", now: NOW }))).toBe("workflow_execution");
    expect(auditActionForEvent(createAppEvent({ type: "job.completed", entityId: "j1", now: NOW }))).toBe("job_execution");
    expect(auditActionForEvent(createAppEvent({ type: "action.completed", entityId: "a1", now: NOW }))).toBe("api_mutation");
  });

  it("observeAppEvent records an audit entry and event metric", () => {
    const engine = createProductionMonitoringEngine();
    const event = createAppEvent({ type: "memory.stored", entityId: "m1", now: NOW });
    const next = observeAppEvent(engine, event);
    expect(next.audit.forAction("memory_change")).toHaveLength(1);
    expect(next.metrics.find("events", "event.processed")).toHaveLength(1);
  });
});

describe("determinism", () => {
  it("identical monitored runs produce identical audit/metrics", async () => {
    const run = async () => {
      const engine = createProductionMonitoringEngine();
      await monitorApiOp(engine, { now: NOW, clockMs: () => 5 }, async () => "ok");
      return JSON.stringify({ metrics: engine.metrics.summaries(), audit: engine.audit.summary() });
    };
    expect(await run()).toBe(await run());
  });

  it("uses LATER timestamps without wall-clock reads", async () => {
    const engine = createProductionMonitoringEngine();
    await monitorApiOp(engine, { now: LATER, clockMs: () => 5 }, async () => "ok");
    expect(engine.metrics.snapshot(LATER).at).toBe(LATER);
    expect(engine.audit.snapshot(LATER).at).toBe(LATER);
  });
});
