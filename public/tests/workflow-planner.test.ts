import { describe, expect, it } from "vitest";
import {
  createWorkflowPlan,
  WorkflowPlanner,
  type PlannedWorkflowStep,
} from "@/lib/workflows/planner";
import { createWorkflow, createWorkflowStep, type WorkflowStep } from "@/lib/workflows/types";
import { createExecutionPlan } from "@/lib/tools/plan";
import { MORNING_TEMPLATE } from "@/lib/digest/templates";

const NOW = "2026-08-10T12:00:00.000Z";

function step(
  id: string,
  action: WorkflowStep["action"] = { kind: "job", jobId: "job-1" },
  dependsOn: readonly string[] = [],
): WorkflowStep {
  return createWorkflowStep({ id, name: `Step ${id}`, action, dependsOn });
}

function workflow(steps: readonly WorkflowStep[], overrides: Partial<Parameters<typeof createWorkflow>[0]> = {}) {
  return createWorkflow({
    id: "workflow-1",
    name: "Test Workflow",
    createdAt: NOW,
    steps,
    ...overrides,
  });
}

function planner(): WorkflowPlanner {
  return new WorkflowPlanner();
}

describe("WorkflowPlanner basics", () => {
  it("plans a workflow into an immutable plan", () => {
    const plan = planner().plan(workflow([step("s1"), step("s2", undefined, ["s1"])]), {
      now: NOW,
    });
    expect(plan.workflowId).toBe("workflow-1");
    expect(plan.now).toBe(NOW);
    expect(plan.steps.map((s) => s.stepId)).toEqual(["s1", "s2"]);
    expect(plan.branches).toEqual([["s1"], ["s2"]]);
    expect(plan.skippedSteps).toEqual([]);
    expect(plan.summary).toMatch(/2 step\(s\) across 2 branch\(es\)/);
  });

  it("derives a deterministic plan id from workflow + now", () => {
    const a = planner().plan(workflow([step("s1")]), { now: NOW });
    const b = planner().plan(workflow([step("s1")]), { now: NOW });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^plan-[0-9a-f]{8}$/);
  });

  it("resolves step priorities and effective metadata", () => {
    const plan = planner().plan(
      workflow(
        [step("s1", { kind: "job", jobId: "job-1" }, [])],
        { maxAttempts: 3, metadata: { timeoutMs: 100, retryDelayMs: 5 } },
      ),
      { now: NOW },
    );
    expect(plan.steps[0]?.maxAttempts).toBe(3);
    expect(plan.steps[0]?.timeoutMs).toBe(100);
    expect(plan.steps[0]?.retryDelayMs).toBe(5);
  });

  it("step-level overrides beat workflow defaults", () => {
    const plan = planner().plan(
      workflow([step("s1", { kind: "job", jobId: "job-1" }, [])], { maxAttempts: 3 }),
      { now: NOW },
    );
    expect(plan.steps[0]?.maxAttempts).toBe(3);
  });
});

describe("WorkflowPlanner conditions", () => {
  it("skips steps whose condition fails", () => {
    const steps = [
      step("s1", { kind: "job", jobId: "job-1" }, []),
      {
        ...step("s2", { kind: "job", jobId: "job-2" }, []),
        condition: { field: "kind", operator: "eq", value: "task" },
      },
    ];
    const plan = planner().plan(workflow(steps), { now: NOW, signal: { kind: "fact" } });
    expect(plan.steps.map((s) => s.stepId)).toEqual(["s1"]);
    expect(plan.skippedSteps.map((s) => s.stepId)).toEqual(["s2"]);
  });

  it("skips transitive dependents of skipped steps", () => {
    const steps = [
      { ...step("s1", { kind: "job", jobId: "job-1" }, []), condition: { field: "go", operator: "eq", value: true } },
      step("s2", { kind: "job", jobId: "job-2" }, ["s1"]),
      step("s3", { kind: "job", jobId: "job-3" }, ["s2"]),
    ];
    const plan = planner().plan(workflow(steps), { now: NOW, signal: { go: false } });
    expect(plan.steps).toEqual([]);
    expect(plan.skippedSteps.map((s) => s.stepId)).toEqual(["s1", "s2", "s3"]);
  });

  it("keeps steps whose condition passes", () => {
    const steps = [
      { ...step("s1", { kind: "job", jobId: "job-1" }, []), condition: { field: "go", operator: "eq", value: true } },
    ];
    const plan = planner().plan(workflow(steps), { now: NOW, signal: { go: true } });
    expect(plan.steps.map((s) => s.stepId)).toEqual(["s1"]);
  });
});

describe("WorkflowPlanner dependencies and branches", () => {
  it("orders steps topologically with parallel branches", () => {
    const steps = [
      step("a", { kind: "job", jobId: "j-a" }, []),
      step("b", { kind: "job", jobId: "j-b" }, []),
      step("c", { kind: "job", jobId: "j-c" }, ["a", "b"]),
      step("d", { kind: "job", jobId: "j-d" }, ["c"]),
    ];
    const plan = planner().plan(workflow(steps), { now: NOW });
    expect(plan.steps.map((s) => s.stepId)).toEqual(["a", "b", "c", "d"]);
    expect(plan.branches).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(plan.steps[2]?.dependsOn).toEqual(["a", "b"]);
  });
});

describe("WorkflowPlanner action steps", () => {
  it("plans action steps through the Action Planner", () => {
    const steps = [step("s1", { kind: "action", intent: "remember this fact", requests: [{ type: "create_memory" }] }, [])];
    const plan = planner().plan(workflow(steps), { now: NOW, userId: "u1" });
    const planned = plan.steps[0] as PlannedWorkflowStep;
    expect(planned.kind).toBe("action");
    expect(planned.actionPlan).toBeDefined();
    expect(planned.actionPlan?.actions[0]?.type).toBe("create_memory");
  });

  it("isolates Action Planner failures into step errors", () => {
    // A cyclic dependency between explicit requests forces the Action
    // Planner to throw; the workflow planner must isolate it.
    const steps = [
      step(
        "s1",
        {
          kind: "action",
          intent: "run something",
          requests: [
            { type: "create_memory", dependsOn: ["search_gmail" as const] },
            { type: "search_gmail", dependsOn: ["create_memory" as const] },
          ],
        },
        [],
      ),
    ];
    const plan = planner().plan(workflow(steps), { now: NOW, userId: "u1" });
    expect(plan.steps[0]?.error).toBeDefined();
    expect(plan.steps[0]?.error?.code).toBe("plan_failed");
  });
});

describe("WorkflowPlanner tool and digest steps", () => {
  it("carries tool plans and digest templates", () => {
    const toolPlan = createExecutionPlan({
      id: "tool-1",
      steps: [{ stepId: "s1", toolId: "search.gmail", input: { query: "x" }, dependsOn: [] }],
    });
    const steps = [
      step("t", { kind: "tool", plan: toolPlan }, []),
      step("d", { kind: "digest", template: MORNING_TEMPLATE, query: "today" }, []),
    ];
    const plan = planner().plan(workflow(steps), { now: NOW });
    expect(plan.steps[0]?.kind).toBe("tool");
    expect(plan.steps[0]?.action.plan?.id).toBe("tool-1");
    expect(plan.steps[1]?.kind).toBe("digest");
    expect(plan.steps[1]?.action.template?.kind).toBe("morning");
    expect(plan.steps[1]?.action.query).toBe("today");
  });
});

describe("createWorkflowPlan validation", () => {
  it("throws on self-dependency", () => {
    expect(() =>
      createWorkflowPlan({
        workflowId: "w",
        name: "n",
        now: NOW,
        steps: [{ stepId: "s1", name: "s1", kind: "job", dependsOn: ["s1"], priority: "normal", maxAttempts: 1, action: { kind: "job" } }],
        branches: [],
        skippedSteps: [],
      }),
    ).toThrow(/depends on itself/);
  });

  it("throws on unknown dependency", () => {
    expect(() =>
      createWorkflowPlan({
        workflowId: "w",
        name: "n",
        now: NOW,
        steps: [{ stepId: "s1", name: "s1", kind: "job", dependsOn: ["missing"], priority: "normal", maxAttempts: 1, action: { kind: "job" } }],
        branches: [],
        skippedSteps: [],
      }),
    ).toThrow(/unknown step/);
  });

  it("throws on skipped/executable id collisions", () => {
    expect(() =>
      createWorkflowPlan({
        workflowId: "w",
        name: "n",
        now: NOW,
        steps: [{ stepId: "s1", name: "s1", kind: "job", dependsOn: [], priority: "normal", maxAttempts: 1, action: { kind: "job" } }],
        branches: [["s1"]],
        skippedSteps: [{ stepId: "s1", name: "s1", kind: "job", dependsOn: [], priority: "normal", maxAttempts: 1, action: { kind: "job" } }],
      }),
    ).toThrow(/also present/);
  });

  it("deep-freezes the plan", () => {
    const plan = createWorkflowPlan({
      workflowId: "w",
      name: "n",
      now: NOW,
      steps: [{ stepId: "s1", name: "s1", kind: "job", dependsOn: [], priority: "normal", maxAttempts: 1, action: { kind: "job", jobId: "j" } }],
      branches: [["s1"]],
      skippedSteps: [],
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps)).toBe(true);
    expect(Object.isFrozen(plan.steps[0])).toBe(true);
    expect(Object.isFrozen(plan.steps[0]?.action)).toBe(true);
    expect(Object.isFrozen(plan.branches)).toBe(true);
    expect(Object.isFrozen(plan.branches[0])).toBe(true);
  });
});

describe("WorkflowPlanner determinism", () => {
  it("identical inputs produce identical plans", () => {
    const steps = [step("a"), step("b", undefined, ["a"]), step("c")];
    const p1 = planner().plan(workflow(steps), { now: NOW, userId: "u1" });
    const p2 = planner().plan(workflow(steps), { now: NOW, userId: "u1" });
    expect(p1).toEqual(p2);
  });

  it("never mutates the workflow", () => {
    const steps = [step("a"), step("b", undefined, ["a"])];
    const w = workflow(steps);
    planner().plan(w, { now: NOW });
    expect(w.status).toBe("pending");
    expect(w.steps[0]?.dependsOn).toEqual([]);
  });
});
