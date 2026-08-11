import { describe, expect, it } from "vitest";
import {
  createWorkflow,
  createWorkflowExecution,
  createWorkflowHistory,
  createWorkflowReference,
  createWorkflowSummary,
  createWorkflowStep,
  cloneWorkflow,
  estimateWorkflowCost,
  evaluateCondition,
  freezeWorkflow,
  hashWorkflow,
  isWorkflowRunnable,
  nextWorkflowOccurrence,
  resolveSignalPath,
  touchWorkflow,
  PRIORITY_COST,
  PRIORITY_RANK,
  DEFAULT_WORKFLOW_ARCHIVED,
  DEFAULT_WORKFLOW_ENABLED,
  DEFAULT_WORKFLOW_MAX_ATTEMPTS,
  DEFAULT_WORKFLOW_PRIORITY,
  DEFAULT_WORKFLOW_STATUS,
  DEFAULT_WORKFLOW_TRIGGER,
  type Workflow,
  type WorkflowPatch,
  type WorkflowStep,
} from "@/lib/workflows/types";

const NOW = "2026-08-10T12:00:00.000Z";

function step(id: string, dependsOn: readonly string[] = []): WorkflowStep {
  return createWorkflowStep({
    id,
    name: `Step ${id}`,
    action: { kind: "job", jobId: "job-1" },
    dependsOn,
  });
}

function baseInput(): Parameters<typeof createWorkflow>[0] {
  return {
    name: "Morning Workflow",
    createdAt: NOW,
    steps: [step("s1"), step("s2", ["s1"])],
  };
}

describe("createWorkflow", () => {
  it("applies defaults for status, priority, trigger, maxAttempts, archived, enabled, tags", () => {
    const workflow = createWorkflow(baseInput());
    expect(workflow.status).toBe(DEFAULT_WORKFLOW_STATUS);
    expect(workflow.priority).toBe(DEFAULT_WORKFLOW_PRIORITY);
    expect(workflow.trigger.kind).toBe(DEFAULT_WORKFLOW_TRIGGER);
    expect(workflow.maxAttempts).toBe(DEFAULT_WORKFLOW_MAX_ATTEMPTS);
    expect(workflow.archived).toBe(DEFAULT_WORKFLOW_ARCHIVED);
    expect(workflow.enabled).toBe(DEFAULT_WORKFLOW_ENABLED);
    expect(workflow.attempts).toBe(0);
    expect(workflow.metadata.tags).toEqual([]);
    expect(workflow.executions).toEqual([]);
    expect(workflow.steps).toHaveLength(2);
  });

  it("derives a deterministic id from name/trigger/priority/createdAt", () => {
    const a = createWorkflow(baseInput());
    const b = createWorkflow(baseInput());
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^workflow-[0-9a-f]{8}$/);
  });

  it("honors an explicit id", () => {
    const workflow = createWorkflow({ ...baseInput(), id: "workflow-1" });
    expect(workflow.id).toBe("workflow-1");
  });

  it("defaults scheduledAt from a one-time schedule", () => {
    const workflow = createWorkflow({
      ...baseInput(),
      trigger: { kind: "scheduled", schedule: { at: "2026-08-11T08:00:00.000Z" } },
    });
    expect(workflow.scheduledAt).toBe("2026-08-11T08:00:00.000Z");
  });

  it("defaults scheduledAt from a recurring schedule startsAt", () => {
    const workflow = createWorkflow({
      ...baseInput(),
      trigger: {
        kind: "scheduled",
        schedule: { everyMs: 3600000, startsAt: "2026-08-11T08:00:00.000Z" },
      },
    });
    expect(workflow.scheduledAt).toBe("2026-08-11T08:00:00.000Z");
  });

  it("defaults a recurring schedule without startsAt to createdAt (jobs-layer convention)", () => {
    const workflow = createWorkflow({
      ...baseInput(),
      trigger: { kind: "scheduled", schedule: { everyMs: 3600000 } },
    });
    expect(workflow.scheduledAt).toBe(NOW);
    expect(workflow.trigger.schedule?.startsAt).toBe(NOW);
    // Deterministic: the defaulted schedule is part of the stored workflow,
    // so rescheduling stays possible after completion.
    expect(isWorkflowRunnable(workflow, NOW)).toBe(true);
  });

  it("copies steps and trigger as detached structures", () => {
    const input = baseInput();
    const trigger = { kind: "conversation" as const, conversationId: "conv-1" };
    const workflow = createWorkflow({ ...input, trigger });
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps[0]).not.toBe(input.steps[0]);
    expect(workflow.trigger).toEqual(trigger);
    expect(workflow.trigger).not.toBe(trigger);
  });

  it("stores links (conversationId, memoryId, jobId, digestId)", () => {
    const workflow = createWorkflow({
      ...baseInput(),
      conversationId: "conv-1",
      memoryId: "mem-1",
      jobId: "job-1",
      digestId: "dig-1",
    });
    expect(workflow.conversationId).toBe("conv-1");
    expect(workflow.memoryId).toBe("mem-1");
    expect(workflow.jobId).toBe("job-1");
    expect(workflow.digestId).toBe("dig-1");
  });

  it("throws on duplicate step ids", () => {
    expect(() => createWorkflow({ ...baseInput(), steps: [step("s1"), step("s1")] })).toThrow(
      /duplicate step id/,
    );
  });

  it("throws on self-dependency", () => {
    expect(() =>
      createWorkflow({ ...baseInput(), steps: [step("s1", ["s1"])] }),
    ).toThrow(/depends on itself/);
  });

  it("throws on unknown dependency", () => {
    expect(() =>
      createWorkflow({ ...baseInput(), steps: [step("s1", ["missing"])] }),
    ).toThrow(/unknown step/);
  });

  it("throws on dependency cycles", () => {
    expect(() =>
      createWorkflow({ ...baseInput(), steps: [step("s1", ["s2"]), step("s2", ["s1"])] }),
    ).toThrow(/cycle/);
  });
});

describe("createWorkflowExecution", () => {
  it("derives a deterministic execution id", () => {
    const input = {
      workflowId: "workflow-1",
      attempt: 1,
      status: "running" as const,
      startedAt: NOW,
    };
    expect(createWorkflowExecution(input).id).toBe(createWorkflowExecution(input).id);
    expect(createWorkflowExecution(input).id).toMatch(/^exec-workflow-[0-9a-f]{8}$/);
  });

  it("copies error/result records", () => {
    const execution = createWorkflowExecution({
      workflowId: "workflow-1",
      attempt: 1,
      status: "completed" as const,
      startedAt: NOW,
      finishedAt: NOW,
      result: { success: true, output: { n: 1 } },
      durationMs: 10,
    });
    expect(execution.result).toEqual({ success: true, output: { n: 1 } });
    expect(execution.durationMs).toBe(10);
  });
});

describe("touchWorkflow", () => {
  it("applies a patch preserving missing keys", () => {
    const workflow = createWorkflow(baseInput());
    const updated = touchWorkflow(workflow, { status: "running", startedAt: NOW });
    expect(updated.status).toBe("running");
    expect(updated.name).toBe(workflow.name);
    expect(updated.priority).toBe(workflow.priority);
    expect(updated.trigger.kind).toBe(workflow.trigger.kind);
  });

  it("clears optional fields with null", () => {
    const workflow = createWorkflow({ ...baseInput(), error: { code: "x", message: "y" } });
    const cleared = touchWorkflow(workflow, { error: null });
    expect(cleared.error).toBeUndefined();
  });

  it("re-validates patched steps", () => {
    const workflow = createWorkflow(baseInput());
    expect(() => touchWorkflow(workflow, { steps: [step("s1", ["s1"])] })).toThrow(
      /depends on itself/,
    );
  });

  it("does not mutate the source workflow", () => {
    const workflow = createWorkflow(baseInput());
    touchWorkflow(workflow, { status: "completed" });
    expect(workflow.status).toBe("pending");
  });
});

describe("cloneWorkflow", () => {
  it("returns a deep, detached copy", () => {
    const workflow = createWorkflow({
      ...baseInput(),
      executions: [
        createWorkflowExecution({
          workflowId: "w",
          attempt: 1,
          status: "completed" as const,
          startedAt: NOW,
          result: { success: true },
        }),
      ],
    });
    const clone = cloneWorkflow(workflow);
    expect(clone).toEqual(workflow);
    expect(clone).not.toBe(workflow);
    expect(clone.steps).not.toBe(workflow.steps);
    expect(clone.steps[0]).not.toBe(workflow.steps[0]);
    expect(clone.executions).not.toBe(workflow.executions);
    expect(clone.executions[0]).not.toBe(workflow.executions[0]);
  });

  it("mutating the clone never affects the source", () => {
    const workflow = createWorkflow(baseInput());
    const clone = cloneWorkflow(workflow);
    (clone as { name: string }).name = "Mutated";
    expect(workflow.name).toBe("Morning Workflow");
  });
});

describe("freezeWorkflow", () => {
  it("deep-freezes the workflow, metadata, trigger, steps, and executions", () => {
    const workflow = createWorkflow({
      ...baseInput(),
      metadata: { tags: ["t"] },
      trigger: { kind: "scheduled", schedule: { at: NOW } },
      executions: [
        createWorkflowExecution({
          workflowId: "w",
          attempt: 1,
          status: "running" as const,
          startedAt: NOW,
        }),
      ],
    });
    const frozen = freezeWorkflow(workflow);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.metadata)).toBe(true);
    expect(Object.isFrozen(frozen.metadata.tags)).toBe(true);
    expect(Object.isFrozen(frozen.trigger)).toBe(true);
    expect(Object.isFrozen(frozen.trigger.schedule)).toBe(true);
    expect(Object.isFrozen(frozen.steps)).toBe(true);
    expect(Object.isFrozen(frozen.steps[0])).toBe(true);
    expect(Object.isFrozen(frozen.steps[0].action)).toBe(true);
    expect(Object.isFrozen(frozen.steps[0].dependsOn)).toBe(true);
    expect(Object.isFrozen(frozen.executions)).toBe(true);
    expect(Object.isFrozen(frozen.executions[0])).toBe(true);
  });
});

describe("scheduling predicates", () => {
  it("isWorkflowRunnable requires pending, non-archived, enabled, and scheduledAt <= now", () => {
    const workflow = createWorkflow({ ...baseInput(), scheduledAt: NOW });
    expect(isWorkflowRunnable(workflow, NOW)).toBe(true);
    expect(isWorkflowRunnable(workflow, "2026-08-10T11:00:00.000Z")).toBe(false);
    expect(isWorkflowRunnable(touchWorkflow(workflow, { status: "completed" }), NOW)).toBe(false);
    expect(isWorkflowRunnable(touchWorkflow(workflow, { archived: true }), NOW)).toBe(false);
    expect(isWorkflowRunnable(touchWorkflow(workflow, { enabled: false }), NOW)).toBe(false);
  });

  it("isWorkflowRunnable returns true for schedule-less pending workflows", () => {
    const workflow = createWorkflow(baseInput());
    expect(isWorkflowRunnable(workflow, NOW)).toBe(true);
  });
});

describe("nextWorkflowOccurrence", () => {
  it("reuses the jobs occurrence math for recurring schedules", () => {
    const schedule = { everyMs: 3600000, startsAt: "2026-08-10T08:00:00.000Z" };
    expect(nextWorkflowOccurrence(schedule, "2026-08-10T09:30:00.000Z")).toBe(
      "2026-08-10T10:00:00.000Z",
    );
  });

  it("returns the single occurrence for one-time schedules", () => {
    expect(nextWorkflowOccurrence({ at: "2026-08-11T08:00:00.000Z" }, NOW)).toBe(
      "2026-08-11T08:00:00.000Z",
    );
  });
});

describe("conditions", () => {
  it("resolveSignalPath walks dot paths", () => {
    const signal = { memory: { kind: "task", score: 0.9 }, tags: ["a", "b"] };
    expect(resolveSignalPath(signal, "memory.kind")).toBe("task");
    expect(resolveSignalPath(signal, "tags")).toEqual(["a", "b"]);
    expect(resolveSignalPath(signal, "missing.path")).toBeUndefined();
  });

  it("evaluates eq/neq", () => {
    const signal = { kind: "task" };
    expect(evaluateCondition({ field: "kind", operator: "eq", value: "task" }, signal)).toBe(true);
    expect(evaluateCondition({ field: "kind", operator: "neq", value: "fact" }, signal)).toBe(true);
    expect(evaluateCondition({ field: "kind", operator: "eq", value: "fact" }, signal)).toBe(false);
  });

  it("evaluates numeric comparisons", () => {
    const signal = { score: 0.9 };
    expect(evaluateCondition({ field: "score", operator: "gt", value: 0.5 }, signal)).toBe(true);
    expect(evaluateCondition({ field: "score", operator: "lte", value: 0.9 }, signal)).toBe(true);
    expect(evaluateCondition({ field: "score", operator: "lt", value: 0.5 }, signal)).toBe(false);
  });

  it("evaluates contains on strings and arrays", () => {
    const signal = { name: "daily brief", tags: ["a", "b"] };
    expect(evaluateCondition({ field: "name", operator: "contains", value: "brief" }, signal)).toBe(
      true,
    );
    expect(evaluateCondition({ field: "tags", operator: "contains", value: "a" }, signal)).toBe(
      true,
    );
    expect(evaluateCondition({ field: "tags", operator: "contains", value: "z" }, signal)).toBe(
      false,
    );
  });

  it("contains with an undefined value never matches", () => {
    const signal = { name: "daily brief", tags: ["a", "b"] };
    expect(evaluateCondition({ field: "name", operator: "contains" }, signal)).toBe(false);
    expect(evaluateCondition({ field: "tags", operator: "contains" }, signal)).toBe(false);
  });

  it("evaluates exists", () => {
    expect(evaluateCondition({ field: "jobId", operator: "exists" }, { jobId: "j" })).toBe(true);
    expect(evaluateCondition({ field: "jobId", operator: "exists" }, {})).toBe(false);
  });

  it("never throws for missing paths", () => {
    expect(evaluateCondition({ field: "missing", operator: "eq", value: 1 }, {})).toBe(false);
  });
});

describe("estimateWorkflowCost", () => {
  it("uses explicit costUnits when set", () => {
    const workflow = createWorkflow({ ...baseInput(), metadata: { costUnits: 42 } });
    expect(estimateWorkflowCost(workflow)).toBe(42);
  });

  it("falls back to the priority base cost", () => {
    expect(estimateWorkflowCost(createWorkflow({ ...baseInput(), priority: "low" }))).toBe(
      PRIORITY_COST.low,
    );
    expect(estimateWorkflowCost(createWorkflow({ ...baseInput(), priority: "critical" }))).toBe(
      PRIORITY_COST.critical,
    );
  });
});

describe("projections", () => {
  it("createWorkflowSummary projects the lightweight view", () => {
    const workflow = createWorkflow({
      ...baseInput(),
      priority: "high",
      scheduledAt: NOW,
      attempts: 2,
      maxAttempts: 3,
      archived: true,
    });
    const summary = createWorkflowSummary(workflow);
    expect(summary).toEqual({
      id: workflow.id,
      name: "Morning Workflow",
      status: "pending",
      priority: "high",
      trigger: "manual",
      createdAt: NOW,
      scheduledAt: NOW,
      stepCount: 2,
      attempts: 2,
      maxAttempts: 3,
      archived: true,
      enabled: true,
      costEstimate: PRIORITY_COST.high,
    });
  });

  it("createWorkflowReference carries the trigger kind", () => {
    const workflow = createWorkflow(baseInput());
    const reference = createWorkflowReference(workflow);
    expect(reference).toEqual({ workflowId: workflow.id, trigger: "manual" });
  });

  it("createWorkflowHistory returns a detached executions array", () => {
    const workflow = createWorkflow({
      ...baseInput(),
      executions: [
        createWorkflowExecution({
          workflowId: "w",
          attempt: 1,
          status: "completed" as const,
          startedAt: NOW,
        }),
      ],
    });
    const history = createWorkflowHistory(workflow);
    expect(history.workflowId).toBe(workflow.id);
    expect(history.executions).toHaveLength(1);
    expect(history.executions).not.toBe(workflow.executions);
  });
});

describe("determinism", () => {
  it("hashWorkflow is deterministic and FNV-1a-shaped", () => {
    expect(hashWorkflow("abc")).toBe(hashWorkflow("abc"));
    expect(hashWorkflow("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashWorkflow("abc")).not.toBe(hashWorkflow("abd"));
  });

  it("identical inputs produce identical workflows", () => {
    expect(createWorkflow(baseInput())).toEqual(createWorkflow(baseInput()));
  });

  it("no Date.now or Math.random leaks into the model layer", () => {
    expect(createWorkflow(baseInput())).toEqual(createWorkflow(baseInput()));
  });
});

describe("types", () => {
  it("PRIORITY_RANK orders critical > high > normal > low", () => {
    expect(PRIORITY_RANK.critical).toBeGreaterThan(PRIORITY_RANK.high);
    expect(PRIORITY_RANK.high).toBeGreaterThan(PRIORITY_RANK.normal);
    expect(PRIORITY_RANK.normal).toBeGreaterThan(PRIORITY_RANK.low);
  });

  it("WorkflowPatch is assignable from partial fields", () => {
    const patch: WorkflowPatch = { status: "running", enabled: false, steps: [step("s1")] };
    expect(patch.status).toBe("running");
    expect(patch.enabled).toBe(false);
    expect(patch.steps).toHaveLength(1);
  });

  it("a Workflow is structurally assignable to its readonly model", () => {
    const workflow: Workflow = createWorkflow(baseInput());
    expect(workflow.trigger.kind).toBe("manual");
  });
});
