import { describe, it, expect } from "vitest";
import { createExecutionPlan } from "@/lib/tools/plan";
import type { ExecutionPlan, ExecutionStep } from "@/lib/tools/plan";

/** Build a valid step fixture. */
function makeStep(stepId: string, overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return { stepId, toolId: `tool-${stepId}`, input: {}, dependsOn: [], ...overrides };
}

function makePlan(steps: readonly ExecutionStep[], id = "plan-1"): ExecutionPlan {
  return createExecutionPlan({ id, steps });
}

describe("createExecutionPlan construction", () => {
  it("creates a plan preserving declared step order", () => {
    const plan = makePlan([makeStep("s1"), makeStep("s2"), makeStep("s3")]);
    expect(plan.id).toBe("plan-1");
    expect(plan.steps.map((step) => step.stepId)).toEqual(["s1", "s2", "s3"]);
  });

  it("carries tool ids, input, and dependencies through", () => {
    const plan = makePlan([
      makeStep("s1", { toolId: "search.gmail", input: { query: "hello" }, dependsOn: [] }),
      makeStep("s2", { dependsOn: ["s1"] }),
    ]);
    expect(plan.steps[0]).toMatchObject({
      stepId: "s1",
      toolId: "search.gmail",
      input: { query: "hello" },
      dependsOn: [],
    });
    expect(plan.steps[1].dependsOn).toEqual(["s1"]);
  });

  it("accepts an empty plan", () => {
    expect(makePlan([]).steps).toEqual([]);
  });

  it("collapses duplicate dependencies to a single entry", () => {
    const plan = makePlan([makeStep("s1"), makeStep("s2", { dependsOn: ["s1", "s1"] })]);
    expect(plan.steps[1].dependsOn).toEqual(["s1"]);
  });
});

describe("createExecutionPlan validation", () => {
  it("throws on duplicate step ids", () => {
    expect(() => makePlan([makeStep("s1"), makeStep("s1")])).toThrow(/duplicate step id/i);
  });

  it("throws on a self-dependency", () => {
    expect(() => makePlan([makeStep("s1", { dependsOn: ["s1"] })])).toThrow(/depends on itself/);
  });

  it("throws on an unknown dependency", () => {
    expect(() => makePlan([makeStep("s1", { dependsOn: ["missing"] })])).toThrow(/unknown step/);
  });

  it("throws on a direct dependency cycle", () => {
    expect(() =>
      makePlan([
        makeStep("s1", { dependsOn: ["s2"] }),
        makeStep("s2", { dependsOn: ["s1"] }),
      ]),
    ).toThrow(/dependency cycle/);
  });

  it("throws on a longer dependency cycle", () => {
    expect(() =>
      makePlan([
        makeStep("s1", { dependsOn: ["s3"] }),
        makeStep("s2", { dependsOn: ["s1"] }),
        makeStep("s3", { dependsOn: ["s2"] }),
      ]),
    ).toThrow(/dependency cycle/);
  });
});

describe("createExecutionPlan immutability", () => {
  it("freezes the plan object", () => {
    const plan = makePlan([makeStep("s1")]);
    expect(() => {
      (plan as unknown as { id: string }).id = "changed";
    }).toThrow();
  });

  it("freezes the steps array", () => {
    const plan = makePlan([makeStep("s1")]);
    expect(() => {
      (plan.steps as unknown as ExecutionStep[]).push(makeStep("s2"));
    }).toThrow();
  });

  it("freezes each step object", () => {
    const plan = makePlan([makeStep("s1")]);
    expect(() => {
      (plan.steps[0] as unknown as { toolId: string }).toolId = "changed";
    }).toThrow();
  });

  it("freezes each dependsOn array", () => {
    const plan = makePlan([makeStep("s1"), makeStep("s2", { dependsOn: ["s1"] })]);
    expect(() => {
      (plan.steps[1].dependsOn as unknown as string[]).push("s9");
    }).toThrow();
  });

  it("detaches step input from the caller's object", () => {
    const input: Record<string, unknown> = { query: "before" };
    const plan = makePlan([makeStep("s1", { input })]);
    input.query = "after";
    expect(plan.steps[0].input).toEqual({ query: "before" });
  });
});
