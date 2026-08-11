import { describe, expect, it } from "vitest";
import {
  WorkflowExecutor,
  WorkflowStepHandlerRegistry,
  type WorkflowStepContext,
} from "@/lib/workflows/executor";
import { createWorkflowPlan, type PlannedWorkflowStep } from "@/lib/workflows/planner";

const NOW = "2026-08-10T12:00:00.000Z";

function step(
  stepId: string,
  overrides: Partial<PlannedWorkflowStep> = {},
): PlannedWorkflowStep {
  return {
    stepId,
    name: `Step ${stepId}`,
    kind: "job",
    dependsOn: [],
    priority: "normal",
    maxAttempts: 1,
    action: { kind: "job", jobId: `job-${stepId}` },
    ...overrides,
  };
}

function plan(
  steps: readonly PlannedWorkflowStep[],
  overrides: Partial<Parameters<typeof createWorkflowPlan>[0]> = {},
) {
  return createWorkflowPlan({
    workflowId: "workflow-1",
    name: "Test Workflow",
    now: NOW,
    steps,
    branches: [],
    skippedSteps: [],
    ...overrides,
  });
}

function executor(handlers: { kind: string; handler: (context: WorkflowStepContext) => Promise<unknown> }[]) {
  const registry = new WorkflowStepHandlerRegistry(handlers);
  return new WorkflowExecutor(registry, { now: () => NOW });
}

describe("WorkflowExecutor basic execution", () => {
  it("executes steps through their handlers in declared order", async () => {
    const calls: string[] = [];
    const exec = executor([
      { kind: "job", handler: async (context) => { calls.push(context.step.stepId); return { ok: true }; } },
    ]);
    const result = await exec.executePlan(plan([step("s1"), step("s2")]), { now: NOW });
    expect(calls).toEqual(["s1", "s2"]);
    expect(result.completedStepIds).toEqual(["s1", "s2"]);
    expect(result.failedStepIds).toEqual([]);
    expect(result.results).toHaveLength(2);
  });

  it("passes injected now and userId to handlers", async () => {
    let seenNow = "";
    let seenUser: string | undefined;
    const exec = executor([
      {
        kind: "job",
        handler: async (context) => {
          seenNow = context.now;
          seenUser = context.userId;
          return {};
        },
      },
    ]);
    await exec.executePlan(plan([step("s1")]), { now: NOW, userId: "u1" });
    expect(seenNow).toBe(NOW);
    expect(seenUser).toBe("u1");
  });
});

describe("WorkflowExecutor dependencies and parallelism", () => {
  it("runs dependent steps only after dependencies complete", async () => {
    const order: string[] = [];
    const exec = executor([
      {
        kind: "job",
        handler: async (context) => {
          order.push(context.step.stepId);
          return {};
        },
      },
    ]);
    await exec.executePlan(
      plan([
        step("a", { dependsOn: [] }),
        step("b", { dependsOn: ["a"] }),
        step("c", { dependsOn: ["a"] }),
        step("d", { dependsOn: ["b", "c"] }),
      ]),
      { now: NOW },
    );
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("runs independent steps concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const exec = executor([
      {
        kind: "job",
        handler: async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent -= 1;
          return {};
        },
      },
    ]);
    const result = await exec.executePlan(plan([step("a"), step("b"), step("c")]), { now: NOW });
    expect(result.completedStepIds).toEqual(["a", "b", "c"]);
    expect(maxConcurrent).toBe(3);
  });
});

describe("WorkflowExecutor failure isolation", () => {
  it("a failing step never fails the plan; independent steps continue", async () => {
    const exec = executor([
      {
        kind: "job",
        handler: async (context) => {
          if (context.step.stepId === "s1") throw new Error("boom");
          return {};
        },
      },
    ]);
    const result = await exec.executePlan(plan([step("s1"), step("s2")]), { now: NOW });
    expect(result.failedStepIds).toEqual(["s1"]);
    expect(result.completedStepIds).toEqual(["s2"]);
    expect(result.results[0]?.error?.code).toBe("handler_error");
  });

  it("cascades dependency failures to dependents (never executed)", async () => {
    const called: string[] = [];
    const exec = executor([
      {
        kind: "job",
        handler: async (context) => {
          called.push(context.step.stepId);
          if (context.step.stepId === "s1") throw new Error("boom");
          return {};
        },
      },
    ]);
    const result = await exec.executePlan(
      plan([step("s1"), step("s2", { dependsOn: ["s1"] })]),
      { now: NOW },
    );
    expect(called).toEqual(["s1"]);
    expect(result.failedStepIds).toEqual(["s1", "s2"]);
    expect(result.results[1]?.error?.code).toBe("dependency_failed");
  });

  it("a step whose planning failed reports the plan error without invoking its handler", async () => {
    const called: string[] = [];
    const exec = executor([
      {
        kind: "job",
        handler: async (context) => {
          called.push(context.step.stepId);
          return {};
        },
      },
    ]);
    const result = await exec.executePlan(
      plan([step("s1", { error: { code: "plan_failed", message: "nope" } }), step("s2")]),
      { now: NOW },
    );
    expect(called).toEqual(["s2"]);
    expect(result.failedStepIds).toEqual(["s1"]);
    expect(result.results[0]?.error?.code).toBe("plan_failed");
  });

  it("reports unknown step kinds structurally", async () => {
    const exec = new WorkflowExecutor(new WorkflowStepHandlerRegistry([]), { now: () => NOW });
    const result = await exec.executePlan(plan([step("s1")]), { now: NOW });
    expect(result.failedStepIds).toEqual(["s1"]);
    expect(result.results[0]?.error?.code).toBe("unknown_step_kind");
  });
});

describe("WorkflowExecutor skipped steps", () => {
  it("reports plan-skipped steps as skipped without running them", async () => {
    const called: string[] = [];
    const exec = executor([
      {
        kind: "job",
        handler: async (context) => {
          called.push(context.step.stepId);
          return {};
        },
      },
    ]);
    const skipped = step("skip", { kind: "digest" });
    const result = await exec.executePlan(
      plan([step("s1")], { skippedSteps: [skipped] }),
      { now: NOW },
    );
    expect(called).toEqual(["s1"]);
    expect(result.skippedStepIds).toEqual(["skip"]);
    expect(result.results).toHaveLength(2);
    expect(result.results[1]?.status).toBe("skipped");
  });
});

describe("WorkflowExecutor timeout", () => {
  it("times out a hanging handler with a structured failure", async () => {
    const exec = executor([
      {
        kind: "job",
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {};
        },
      },
    ]);
    const stepWithTimeout = step("s1", { timeoutMs: 20 });
    const result = await exec.executePlan(plan([stepWithTimeout]), { now: NOW });
    expect(result.failedStepIds).toEqual(["s1"]);
    expect(result.results[0]?.error?.code).toBe("timeout");
  });
});

describe("WorkflowExecutor cancellation", () => {
  it("cancels pending and in-flight steps on abort", async () => {
    const controller = new AbortController();
    const exec = executor([
      {
        kind: "job",
        handler: async (context) => {
          if (context.step.stepId === "s1") {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return {};
        },
      },
    ]);
    setTimeout(() => controller.abort(), 10);
    const result = await exec.executePlan(
      plan([step("s1"), step("s2", { dependsOn: ["s1"] })]),
      { now: NOW, signal: controller.signal },
    );
    expect(result.cancelledStepIds).toContain("s1");
    expect(result.cancelledStepIds).toContain("s2");
  });

  it("marks every not-yet-executed step cancelled when aborted before execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = executor([
      {
        kind: "job",
        handler: async () => ({}),
      },
    ]);
    const result = await exec.executePlan(plan([step("s1"), step("s2")]), {
      now: NOW,
      signal: controller.signal,
    });
    expect(result.cancelledStepIds).toEqual(["s1", "s2"]);
  });
});

describe("WorkflowExecutor retries", () => {
  it("retries only when configured and respects the attempt budget", async () => {
    let attempts = 0;
    const exec = executor([
      {
        kind: "job",
        handler: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("flaky");
          return { ok: true };
        },
      },
    ]);
    const result = await exec.executePlan(
      plan([step("s1", { maxAttempts: 3, retryDelayMs: 0 })]),
      { now: NOW },
    );
    expect(attempts).toBe(3);
    expect(result.completedStepIds).toEqual(["s1"]);
  });

  it("fails after exhausting attempts", async () => {
    let attempts = 0;
    const exec = executor([
      {
        kind: "job",
        handler: async () => {
          attempts += 1;
          throw new Error("always");
        },
      },
    ]);
    const result = await exec.executePlan(
      plan([step("s1", { maxAttempts: 3, retryDelayMs: 0 })]),
      { now: NOW },
    );
    expect(attempts).toBe(3);
    expect(result.failedStepIds).toEqual(["s1"]);
  });
});

describe("WorkflowExecutor determinism and immutability", () => {
  it("the plan is never mutated", async () => {
    const p = plan([step("s1"), step("s2", { dependsOn: ["s1"] })]);
    const exec = executor([
      {
        kind: "job",
        handler: async () => ({}),
      },
    ]);
    await exec.executePlan(p, { now: NOW });
    expect(p.steps).toHaveLength(2);
    expect(p.steps[1]?.dependsOn).toEqual(["s1"]);
  });

  it("handlers registry snapshots list entries in registration order", () => {
    const registry = new WorkflowStepHandlerRegistry([
      { kind: "job", handler: async () => ({}) },
      { kind: "tool", handler: async () => ({}) },
    ]);
    expect(registry.list().map((entry) => entry.kind)).toEqual(["job", "tool"]);
    expect(registry.has("job")).toBe(true);
    expect(registry.get("digest")).toBeUndefined();
  });

  it("1000 independent steps complete deterministically", async () => {
    const steps: PlannedWorkflowStep[] = [];
    for (let index = 0; index < 1000; index += 1) {
      steps.push(step(`s${index}`));
    }
    const exec = executor([
      {
        kind: "job",
        handler: async () => ({}),
      },
    ]);
    const result = await exec.executePlan(plan(steps), { now: NOW });
    expect(result.completedStepIds).toHaveLength(1000);
    expect(result.results).toHaveLength(1000);
  });
});
