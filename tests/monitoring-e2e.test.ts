import { describe, it, expect } from "vitest";
import { createProductionMonitoringEngine } from "@/lib/monitoring/production";
import {
  monitorApiOp,
  monitorDatabaseOp,
  monitorJobRun,
  monitorPlannerRun,
  monitorToolRun,
  monitorWorkerRun,
  monitorWorkflowRun,
  observeAppEvent,
} from "@/lib/monitoring/integration";
import { EventBus } from "@/lib/events/bus";
import { createAppEvent } from "@/lib/events/types";
import { createProductionDatabase } from "@/lib/database/production";
import { WorkerTaskHandlerRegistry } from "@/lib/workers/executor";
import { createProductionWorkerEngine } from "@/lib/workers/production";
import { createWorkerTask } from "@/lib/workers/types";
import { ToolExecutor } from "@/lib/tools/executor";
import { ToolRegistry } from "@/lib/tools/registry";
import { createExecutionPlan } from "@/lib/tools/plan";
import { createBuiltInReadTools } from "@/lib/tools/builtin";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T09:01:00.000Z";

describe("monitoring × worker engine", () => {
  it("observes a full worker pass end-to-end", async () => {
    const monitoring = createProductionMonitoringEngine();
    const registry = new WorkerTaskHandlerRegistry().register(
      "custom",
      async () => "done",
    );
    const engine = createProductionWorkerEngine({
      handlerRegistry: registry,
      now: () => NOW,
      clockMs: () => 100,
    });
    const { engine: e1 } = engine.registerWorker({ name: "w1", pool: "main", createdAt: NOW, id: "w1" });
    const { engine: e2 } = e1.startWorker("w1", NOW);
    e2.enqueueTask(
      createWorkerTask({ name: "t1", id: "t1", kind: "custom", payload: { kind: "custom", input: {} }, createdAt: NOW }),
      NOW,
    );

    const { result } = await monitorWorkerRun(
      monitoring,
      { now: NOW, entityId: "w1", clockMs: () => 100 },
      async () => {
        const summary = await e2.runOnce(NOW);
        return { completed: summary.completed, failed: summary.failed, cancelled: summary.cancelled };
      },
    );
    expect(result.completed).toBe(1);
    expect(monitoring.metrics.find("workers", "worker.pass.completed")[0]?.value).toBe(1);
    expect(monitoring.profiler.count()).toBe(1);
    expect(monitoring.audit.count()).toBe(1);
  });

  it("failure isolation: a failed pass records error, alert and audit, and rethrows", async () => {
    const monitoring = createProductionMonitoringEngine();
    await expect(
      monitorWorkerRun(
        monitoring,
        { now: NOW, entityId: "w1" },
        async () => {
          throw new Error("pass crashed");
        },
      ),
    ).rejects.toThrow("pass crashed");
    expect(monitoring.logger.statistics().byLevel.error).toBe(1);
    expect(monitoring.alerts.count()).toBe(1);
    expect(monitoring.audit.statistics().failures).toBe(1);
  });
});

describe("monitoring × event bus", () => {
  it("wires events into audit and metrics", async () => {
    const monitoring = createProductionMonitoringEngine();
    let bus = new EventBus();
    const { bus: wired, id } = bus.subscribe("memory.stored", (event) => {
      observeAppEvent(monitoring, event);
    });
    bus = wired;
    const event = createAppEvent({ type: "memory.stored", entityId: "m1", now: NOW });
    const summary = await bus.emit(event);
    expect(summary).toBeDefined();
    expect(bus.hasListener(id)).toBe(true);
    expect(monitoring.audit.forAction("memory_change")).toHaveLength(1);
    expect(monitoring.metrics.find("events", "event.processed")).toHaveLength(1);
  });

  it("propagates every app event kind through the observer", async () => {
    const monitoring = createProductionMonitoringEngine();
    const kinds = [
      "conversation.updated",
      "memory.stored",
      "digest.published",
      "workflow.triggered",
      "job.completed",
      "action.completed",
    ] as const;
    let bus = new EventBus();
    for (const type of kinds) {
      const { bus: wired } = bus.subscribe(type, (event) => observeAppEvent(monitoring, event));
      bus = wired;
    }
    for (const type of kinds) {
      const event = createAppEvent({ type, entityId: "e1", now: NOW });
      await bus.emit(event);
    }
    expect(monitoring.audit.count()).toBe(6);
  });
});

describe("monitoring × database", () => {
  it("observes database operations", async () => {
    const monitoring = createProductionMonitoringEngine();
    const database = createProductionDatabase();
    const { result } = await monitorDatabaseOp(
      monitoring,
      { now: NOW, entityId: "db-1", clockMs: () => 5 },
      async () => {
        const repo = database.scoped("monitor-e2e", "metadata");
        await repo.insert({
          scope: "monitor-e2e",
          collection: "metadata",
          recordId: "probe",
          data: { ok: true },
          createdAt: NOW,
        } as never);
        return "stored";
      },
    );
    expect(result).toBe("stored");
    expect(monitoring.metrics.find("database", "database.op.completed")).toHaveLength(1);
  });
});

describe("monitoring × tool executor", () => {
  it("observes a tool plan execution", async () => {
    const monitoring = createProductionMonitoringEngine();
    const executor = new ToolExecutor(new ToolRegistry(createBuiltInReadTools()));
    const plan = createExecutionPlan({
      id: "plan-1",
      steps: [
        {
          stepId: "step-1",
          toolId: "search_gmail",
          input: { query: "meetings" },
          dependsOn: [],
        },
      ],
    });
    const { result, durationMs } = await monitorToolRun(
      monitoring,
      { now: NOW, entityId: "plan-1", clockMs: () => 10 },
      async () => {
        const outcome = await executor.execute(plan, {});
        return outcome.results;
      },
    );
    expect(result).toHaveLength(1);
    expect(durationMs).toBe(0);
    expect(monitoring.metrics.find("tool", "tool.run.completed")).toHaveLength(1);
    expect(monitoring.audit.forAction("tool_execution")).toHaveLength(1);
  });
});

describe("monitoring × planner / job / workflow / api hooks", () => {
  it("records planner, job, workflow and api runs", async () => {
    const monitoring = createProductionMonitoringEngine();
    await monitorPlannerRun(monitoring, { now: NOW }, async () => "plan");
    await monitorJobRun(monitoring, { now: NOW }, async () => "job");
    await monitorWorkflowRun(monitoring, { now: NOW }, async () => "workflow");
    await monitorApiOp(monitoring, { now: NOW }, async () => "api");
    expect(monitoring.metrics.find("planner", "planner.run.completed")).toHaveLength(1);
    expect(monitoring.metrics.find("jobs", "job.run.completed")).toHaveLength(1);
    expect(monitoring.metrics.find("workflows", "workflow.run.completed")).toHaveLength(1);
    expect(monitoring.metrics.find("api", "api.op.completed")).toHaveLength(1);
    expect(monitoring.audit.count()).toBe(4);
  });
});

describe("1000-object scale", () => {
  it("collects 1000 metric samples deterministically", async () => {
    const monitoring = createProductionMonitoringEngine();
    for (let index = 0; index < 1000; index += 1) {
      monitoring.increment("api", "requests", NOW, 1, `req-${index}`);
    }
    expect(monitoring.metrics.count()).toBe(1000);
    expect(monitoring.metrics.statistics().sum).toBe(1000);
  });

  it("records 1000 audit entries", async () => {
    const monitoring = createProductionMonitoringEngine();
    for (let index = 0; index < 1000; index += 1) {
      monitoring.auditRecord({
        actor: "user-1",
        resource: "conversation",
        action: "conversation_update",
        timestamp: NOW,
        correlation: { correlationId: `c-${index}` },
      });
    }
    expect(monitoring.audit.count()).toBe(1000);
    expect(monitoring.audit.statistics().total).toBe(1000);
  });

  it("records 1000 traces with bounded spans", async () => {
    let monitoring = createProductionMonitoringEngine();
    for (let index = 0; index < 1000; index += 1) {
      const { engine, span } = monitoring.startSpan({ kind: "api", name: `req-${index}`, startedAt: NOW });
      monitoring = engine;
      const { engine: finished } = monitoring.finishSpan(span.id, LATER);
      monitoring = finished;
    }
    expect(monitoring.traces.count()).toBe(1000);
    expect(monitoring.traces.statistics().finishedSpans).toBe(1000);
  });
});

describe("determinism and immutability", () => {
  it("identical monitored pipelines produce identical snapshots", async () => {
    const run = async () => {
      const monitoring = createProductionMonitoringEngine();
      await monitorApiOp(monitoring, { now: NOW, clockMs: () => 5 }, async () => "ok");
      await monitorToolRun(monitoring, { now: NOW, clockMs: () => 5 }, async () => "ok");
      const snapshot = monitoring.snapshot(NOW);
      return JSON.stringify({
        metrics: snapshot.metrics.samples,
        logs: snapshot.logs.entries,
        audit: snapshot.audit.entries,
        alerts: snapshot.alerts.alerts,
      });
    };
    expect(await run()).toBe(await run());
  });

  it("never mutates the collectors through the engine facades", () => {
    const monitoring = createProductionMonitoringEngine();
    const loggerBefore = monitoring.logger;
    const metricsBefore = monitoring.metrics;
    monitoring.increment("api", "requests", NOW);
    // The engine replaces its collectors; the original instances are untouched.
    expect(loggerBefore.count()).toBe(0);
    expect(metricsBefore.count()).toBe(0);
    expect(monitoring.metrics.count()).toBe(1);
  });

  it("all public monitoring models are deeply frozen", () => {
    const monitoring = createProductionMonitoringEngine();
    monitoring.increment("api", "requests", NOW);
    const snapshot = monitoring.snapshot(NOW);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.metrics)).toBe(true);
    expect(Object.isFrozen(snapshot.audit)).toBe(true);
    expect(Object.isFrozen(snapshot.alerts)).toBe(true);
  });
});
