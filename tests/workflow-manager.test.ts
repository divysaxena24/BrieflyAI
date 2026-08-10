import { describe, expect, it } from "vitest";
import { WorkflowManager } from "@/lib/workflows/manager";
import { WorkflowNotFoundError } from "@/lib/workflows/repository";
import {
  createWorkflow,
  createWorkflowStep,
  type WorkflowStep,
} from "@/lib/workflows/types";

const NOW = "2026-08-10T12:00:00.000Z";

function step(id: string, dependsOn: readonly string[] = []): WorkflowStep {
  return createWorkflowStep({ id, name: `Step ${id}`, action: { kind: "job", jobId: "job-1" }, dependsOn });
}

function input(id: string, overrides: Partial<Parameters<typeof createWorkflow>[0]> = {}) {
  return { id, name: `Workflow ${id}`, createdAt: NOW, steps: [step("s1")], ...overrides };
}

describe("WorkflowManager creation", () => {
  it("starts empty by default", () => {
    const manager = new WorkflowManager();
    expect(manager.count()).toBe(0);
  });

  it("createWorkflow returns the workflow plus a successor manager", () => {
    const manager = new WorkflowManager();
    const { manager: next, workflow } = manager.createWorkflow(input("w1"));
    expect(workflow.id).toBe("w1");
    expect(next.count()).toBe(1);
    expect(manager.count()).toBe(0);
  });

  it("createWorkflow throws WorkflowDuplicateError for duplicates", () => {
    const manager = new WorkflowManager();
    const { manager: next } = manager.createWorkflow(input("w1"));
    expect(() => next.createWorkflow(input("w1"))).toThrow(/already exists/);
  });

  it("scheduleWorkflow is identical to createWorkflow", () => {
    const manager = new WorkflowManager();
    const { workflow } = manager.scheduleWorkflow(input("w1", {
      trigger: { kind: "scheduled", schedule: { at: NOW } },
    }));
    expect(workflow.scheduledAt).toBe(NOW);
  });

  it("updateWorkflow applies a patch", () => {
    const manager = new WorkflowManager();
    const { manager: next } = manager.createWorkflow(input("w1"));
    const { workflow } = next.updateWorkflow("w1", { description: "hello" });
    expect(workflow.description).toBe("hello");
  });

  it("updateWorkflow throws for unknown ids", () => {
    const manager = new WorkflowManager();
    expect(() => manager.updateWorkflow("missing", { name: "x" })).toThrow(WorkflowNotFoundError);
  });
});

describe("WorkflowManager lifecycle", () => {
  it("startWorkflow marks running, increments attempts, appends an execution", () => {
    const manager = new WorkflowManager();
    const { manager: next } = manager.createWorkflow(input("w1"));
    const { manager: running, workflow, execution } = next.startWorkflow("w1", { at: NOW });
    expect(workflow.status).toBe("running");
    expect(workflow.attempts).toBe(1);
    expect(workflow.startedAt).toBe(NOW);
    expect(execution.status).toBe("running");
    expect(running.find("w1")?.executions).toHaveLength(1);
  });

  it("completeWorkflow finalizes the running execution", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(input("w1"));
    const { manager: started } = created.startWorkflow("w1", { at: NOW });
    const { workflow } = started.completeWorkflow("w1", {
      at: NOW,
      output: { ok: true },
      durationMs: 5,
    });
    expect(workflow.status).toBe("completed");
    expect(workflow.completedAt).toBe(NOW);
    expect(workflow.result).toEqual({ success: true, output: { ok: true }, durationMs: 5 });
    expect(workflow.executions[0]?.status).toBe("completed");
  });

  it("failWorkflow sets error and finalizes as failed", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(input("w1"));
    const { manager: started } = created.startWorkflow("w1", { at: NOW });
    const { workflow } = started.failWorkflow("w1", {
      at: NOW,
      error: { code: "step_failed", message: "boom" },
    });
    expect(workflow.status).toBe("failed");
    expect(workflow.error).toEqual({ code: "step_failed", message: "boom" });
    expect(workflow.executions[0]?.status).toBe("failed");
  });

  it("cancelWorkflow finalizes as cancelled", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(input("w1"));
    const { manager: started } = created.startWorkflow("w1", { at: NOW });
    const { workflow } = started.cancelWorkflow("w1", {
      at: NOW,
      error: { code: "cancelled", message: "nope" },
    });
    expect(workflow.status).toBe("cancelled");
    expect(workflow.executions[0]?.status).toBe("cancelled");
  });

  it("lifecycle methods throw for unknown ids", () => {
    const manager = new WorkflowManager();
    expect(() => manager.startWorkflow("missing", { at: NOW })).toThrow(WorkflowNotFoundError);
    expect(() =>
      manager.completeWorkflow("missing", { at: NOW }),
    ).toThrow(WorkflowNotFoundError);
    expect(() =>
      manager.failWorkflow("missing", { at: NOW, error: { code: "x", message: "y" } }),
    ).toThrow(WorkflowNotFoundError);
    expect(() => manager.cancelWorkflow("missing", { at: NOW })).toThrow(WorkflowNotFoundError);
  });
});

describe("WorkflowManager retry and reschedule", () => {
  it("retryWorkflow re-enables failed workflows", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(input("w1"));
    const { manager: failed } = created.failWorkflow("w1", {
      at: NOW,
      error: { code: "x", message: "y" },
    });
    const { workflow } = failed.retryWorkflow("w1");
    expect(workflow.status).toBe("pending");
    expect(workflow.error).toBeUndefined();
  });

  it("retryWorkflow is a no-op for non-failed workflows", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(input("w1"));
    const { workflow } = created.retryWorkflow("w1");
    expect(workflow.status).toBe("pending");
  });

  it("rescheduleWorkflow re-arms recurring workflows into the future", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(
      input("w1", {
        trigger: { kind: "scheduled", schedule: { everyMs: 3600000, startsAt: "2026-08-10T08:00:00.000Z" } },
      }),
    );
    const { manager: completed } = created.completeWorkflow("w1", { at: NOW });
    const { workflow } = completed.rescheduleWorkflow("w1", NOW);
    expect(workflow.status).toBe("pending");
    expect(workflow.scheduledAt).toBe("2026-08-10T13:00:00.000Z");
  });

  it("rescheduleWorkflow is a no-op without a recurring schedule", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(input("w1"));
    const { workflow } = created.rescheduleWorkflow("w1", NOW);
    expect(workflow.status).toBe("pending");
  });

  it("recurring workflows without startsAt get a concrete schedule and reschedule", () => {
    // The jobs-layer default (startsAt = createdAt) must make the workflow
    // reschedulable after completion — not immediately-and-never-again.
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(
      input("w1", { trigger: { kind: "scheduled", schedule: { everyMs: 3600000 } } }),
    );
    const stored = created.find("w1");
    expect(stored?.scheduledAt).toBe(NOW);
    expect(stored?.trigger.schedule?.startsAt).toBe(NOW);
    const { manager: completed } = created.completeWorkflow("w1", { at: NOW });
    const { workflow } = completed.rescheduleWorkflow("w1", NOW);
    expect(workflow.status).toBe("pending");
    expect(workflow.scheduledAt).toBe("2026-08-10T13:00:00.000Z");
  });
});

describe("WorkflowManager flags", () => {
  it("archive/restore toggle the archived flag", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(input("w1"));
    expect(created.archiveWorkflow("w1").find("w1")?.archived).toBe(true);
    expect(created.archiveWorkflow("w1").restoreWorkflow("w1").find("w1")?.archived).toBe(false);
  });

  it("disable/enable toggle the enabled flag", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(input("w1"));
    expect(created.disableWorkflow("w1").find("w1")?.enabled).toBe(false);
    expect(created.disableWorkflow("w1").enableWorkflow("w1").find("w1")?.enabled).toBe(true);
  });

  it("deleteWorkflow removes entirely", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.createWorkflow(input("w1"));
    expect(created.deleteWorkflow("w1").has("w1")).toBe(false);
  });
});

describe("WorkflowManager bulk operations", () => {
  it("bulkCreate adds many workflows atomically", () => {
    const manager = new WorkflowManager();
    const { manager: next, workflows } = manager.bulkCreate([input("w1"), input("w2")]);
    expect(workflows).toHaveLength(2);
    expect(next.count()).toBe(2);
  });

  it("bulkDelete removes many workflows atomically", () => {
    const manager = new WorkflowManager();
    const { manager: created } = manager.bulkCreate([input("w1"), input("w2")]);
    const next = created.bulkDelete(["w1", "w2"]);
    expect(next.count()).toBe(0);
    expect(() => created.bulkDelete(["missing"])).toThrow(WorkflowNotFoundError);
  });
});

describe("WorkflowManager immutability", () => {
  it("the receiver manager is never mutated", () => {
    const manager = new WorkflowManager();
    manager.createWorkflow(input("w1"));
    expect(manager.count()).toBe(0);
  });

  it("1000-workflow scale stays deterministic", () => {
    const manager = new WorkflowManager();
    const inputs = [];
    for (let index = 0; index < 1000; index += 1) {
      inputs.push({
        id: `w-${index}`,
        name: `W${index}`,
        createdAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
        steps: [step("s1")],
      });
    }
    const { manager: next } = manager.bulkCreate(inputs);
    expect(next.count()).toBe(1000);
    expect(next.list().map((w) => w.id)).toEqual(inputs.map((i) => i.id));
  });
});
