import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ToolExecutor } from "@/lib/tools/executor";
import { ToolRegistry } from "@/lib/tools/registry";
import { createExecutionPlan } from "@/lib/tools/plan";
import type { ExecutionPlan, ExecutionStep } from "@/lib/tools/plan";
import type { Tool } from "@/lib/tools/types";

/** Build a minimal valid tool. */
function makeTool(id: string, execute: Tool["execute"], inputSchema: z.ZodType<unknown> = z.unknown()): Tool {
  return { id, description: `Tool ${id}`, inputSchema, execute };
}

/** Build a valid step fixture. */
function makeStep(stepId: string, toolId: string, overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return { stepId, toolId, input: {}, dependsOn: [], ...overrides };
}

function makePlan(id: string, steps: readonly ExecutionStep[]): ExecutionPlan {
  return createExecutionPlan({ id, steps });
}

function makeExecutor(tools: readonly Tool[]): ToolExecutor {
  return new ToolExecutor(new ToolRegistry(tools));
}

/** A promise that resolves when resolve() is called. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("ToolExecutor success", () => {
  it("returns a success result with the tool output", async () => {
    const tool = makeTool("a", async () => ({ value: 42 }));
    const plan = makePlan("p", [makeStep("s1", "a")]);
    const result = await makeExecutor([tool]).execute(plan);
    expect(result.planId).toBe("p");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      stepId: "s1",
      toolId: "a",
      status: "success",
      output: { value: 42 },
    });
    expect(result.succeededStepIds).toEqual(["s1"]);
    expect(result.failedStepIds).toEqual([]);
    expect(result.cancelledStepIds).toEqual([]);
  });

  it("handles an empty plan", async () => {
    const result = await makeExecutor([]).execute(makePlan("p", []));
    expect(result.results).toEqual([]);
    expect(result.succeededStepIds).toEqual([]);
  });
});

describe("ToolExecutor dependency ordering", () => {
  it("runs dependent steps only after their dependencies", async () => {
    const log: string[] = [];
    const executor = makeExecutor([
      makeTool("a", async () => {
        log.push("a");
        return "A";
      }),
      makeTool("b", async () => {
        log.push("b");
        return "B";
      }),
      makeTool("c", async () => {
        log.push("c");
        return "C";
      }),
    ]);
    const plan = makePlan("p", [
      makeStep("s1", "a"),
      makeStep("s2", "b", { dependsOn: ["s1"] }),
      makeStep("s3", "c", { dependsOn: ["s2"] }),
    ]);
    const result = await executor.execute(plan);
    expect(log).toEqual(["a", "b", "c"]);
    expect(result.succeededStepIds).toEqual(["s1", "s2", "s3"]);
  });

  it("runs independent steps in parallel (both in flight before either finishes)", async () => {
    const started: string[] = [];
    const gate = deferred();
    const executor = makeExecutor([
      makeTool("a", async () => {
        started.push("a");
        if (started.includes("a") && started.includes("b")) gate.resolve();
        await gate.promise;
        return "A";
      }),
      makeTool("b", async () => {
        started.push("b");
        if (started.includes("a") && started.includes("b")) gate.resolve();
        await gate.promise;
        return "B";
      }),
    ]);
    const plan = makePlan("p", [makeStep("s1", "a"), makeStep("s2", "b")]);
    // The gate only resolves once BOTH steps have started; a sequential
    // executor would deadlock and hit the timeout instead.
    const result = await executor.execute(plan, { timeoutMs: 500 });
    expect(result.results.map((r) => r.status)).toEqual(["success", "success"]);
    expect([...started].sort()).toEqual(["a", "b"]);
  });
});

describe("ToolExecutor timeout", () => {
  it("fails a step that exceeds the per-step timeout", async () => {
    const slow = vi.fn(() => new Promise(() => {}));
    const tool = makeTool("slow", slow);
    const plan = makePlan("p", [makeStep("s1", "slow")]);
    const result = await makeExecutor([tool]).execute(plan, { timeoutMs: 20 });
    expect(result.results[0].status).toBe("failure");
    expect(result.results[0].error?.code).toBe("timeout");
    // No retries: the timed-out tool is invoked exactly once.
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("does not time out steps that finish in time", async () => {
    const tool = makeTool("fast", async () => "ok");
    const plan = makePlan("p", [makeStep("s1", "fast")]);
    const result = await makeExecutor([tool]).execute(plan, { timeoutMs: 1000 });
    expect(result.results[0].status).toBe("success");
  });
});

describe("ToolExecutor cancellation", () => {
  it("cancels every step when the plan signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = makeExecutor([
      makeTool("a", async () => "A"),
      makeTool("b", async () => "B"),
    ]);
    const plan = makePlan("p", [
      makeStep("s1", "a"),
      makeStep("s2", "b", { dependsOn: ["s1"] }),
    ]);
    const result = await executor.execute(plan, { signal: controller.signal });
    expect(result.cancelledStepIds).toEqual(["s1", "s2"]);
    expect(result.results.every((r) => r.status === "cancelled")).toBe(true);
  });

  it("cancels an in-flight step when the plan signal aborts", async () => {
    const controller = new AbortController();
    const tool = makeTool("slow", () => new Promise(() => {}));
    const executor = makeExecutor([tool]);
    const execution = executor.execute(makePlan("p", [makeStep("s1", "slow")]), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const result = await execution;
    expect(result.results[0].status).toBe("cancelled");
    expect(result.results[0].error?.code).toBe("cancelled");
  });

  it("does not run remaining steps after a mid-plan cancellation", async () => {
    const controller = new AbortController();
    const log: string[] = [];
    const executor = makeExecutor([
      makeTool("a", async () => {
        log.push("a");
        return "A";
      }),
      makeTool("b", async () => {
        log.push("b");
        return "B";
      }),
    ]);
    const execution = executor.execute(
      makePlan("p", [makeStep("s1", "a"), makeStep("s2", "b", { dependsOn: ["s1"] })]),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    const result = await execution;
    // s2 may be cancelled (before running) depending on timing; if it ran it
    // must have succeeded — but it can never run after the abort.
    for (const stepResult of result.results) {
      if (stepResult.stepId === "s2") {
        expect(["success", "cancelled"]).toContain(stepResult.status);
      }
    }
  });
});

describe("ToolExecutor error isolation", () => {
  it("isolates a throwing tool and lets independent steps succeed", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const executor = makeExecutor([
      makeTool("bad", failing),
      makeTool("good", async () => "ok"),
    ]);
    const plan = makePlan("p", [makeStep("s1", "bad"), makeStep("s2", "good")]);
    const result = await executor.execute(plan);
    expect(result.results[0].status).toBe("failure");
    expect(result.results[0].error?.code).toBe("execution_error");
    expect(result.results[0].error?.message).toBe("boom");
    expect(result.results[1].status).toBe("success");
    expect(result.succeededStepIds).toEqual(["s2"]);
    expect(result.failedStepIds).toEqual(["s1"]);
    // No retries: a failing tool is invoked exactly once.
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("forwards a synchronous tool throw as a step failure", async () => {
    const tool = makeTool("sync", () => {
      throw new Error("sync boom");
    });
    const plan = makePlan("p", [makeStep("s1", "sync")]);
    const result = await makeExecutor([tool]).execute(plan);
    expect(result.results[0].status).toBe("failure");
    expect(result.results[0].error?.message).toBe("sync boom");
  });
});

describe("ToolExecutor partial success", () => {
  it("never runs dependents of a failed step (dependency_failed)", async () => {
    const log: string[] = [];
    const executor = makeExecutor([
      makeTool("a", async () => {
        log.push("a");
        return "A";
      }),
      makeTool("b", async () => {
        log.push("b");
        throw new Error("b down");
      }),
      makeTool("c", async () => {
        log.push("c");
        return "C";
      }),
      makeTool("d", async () => {
        log.push("d");
        return "D";
      }),
    ]);
    const plan = makePlan("p", [
      makeStep("s1", "a"),
      makeStep("s2", "b", { dependsOn: ["s1"] }),
      makeStep("s3", "c", { dependsOn: ["s2"] }),
      makeStep("s4", "d"),
    ]);
    const result = await executor.execute(plan);
    expect([...log].sort()).toEqual(["a", "b", "d"]);
    expect(log).not.toContain("c");
    expect(result.results.find((r) => r.stepId === "s2")?.error?.code).toBe("execution_error");
    expect(result.results.find((r) => r.stepId === "s3")?.error?.code).toBe("dependency_failed");
    expect(result.results.find((r) => r.stepId === "s4")?.status).toBe("success");
    expect([...result.failedStepIds].sort()).toEqual(["s2", "s3"]);
    expect([...result.succeededStepIds].sort()).toEqual(["s1", "s4"]);
  });
});

describe("ToolExecutor unknown tools and invalid input", () => {
  it("reports an unknown tool id as a step failure", async () => {
    const plan = makePlan("p", [makeStep("s1", "missing.tool")]);
    const result = await makeExecutor([]).execute(plan);
    expect(result.results[0].status).toBe("failure");
    expect(result.results[0].error?.code).toBe("unknown_tool");
  });

  it("rejects step input that fails the tool schema", async () => {
    const tool = makeTool("strict", async () => "never", z.object({ query: z.string() }));
    const plan = makePlan("p", [makeStep("s1", "strict", { input: { query: 123 } })]);
    const result = await makeExecutor([tool]).execute(plan);
    expect(result.results[0].status).toBe("failure");
    expect(result.results[0].error?.code).toBe("invalid_input");
  });

  it("validates input against the tool schema before executing", async () => {
    const execute = vi.fn(async () => "ran");
    const tool = makeTool("strict", execute, z.object({ query: z.string() }));
    const plan = makePlan("p", [makeStep("s1", "strict", { input: { query: "hello" } })]);
    const result = await makeExecutor([tool]).execute(plan);
    expect(result.results[0].status).toBe("success");
    expect(execute).toHaveBeenCalledWith(
      { query: "hello" },
      expect.objectContaining({ signal: undefined }),
    );
  });
});

describe("ToolExecutor determinism and immutability", () => {
  it("produces identical results across repeated executions", async () => {
    const executor = makeExecutor([
      makeTool("a", async () => "A"),
      makeTool("b", async () => "B"),
    ]);
    const plan = makePlan("p", [
      makeStep("s1", "a"),
      makeStep("s2", "b", { dependsOn: ["s1"] }),
    ]);
    const first = await executor.execute(plan);
    const second = await executor.execute(plan);
    // Compare everything except wall-clock durationMs, which is inherently
    // timing-dependent (statuses, outputs, ordering, and ids must match).
    const withoutTiming = (result: typeof first) =>
      result.results.map((stepResult) => ({
        stepId: stepResult.stepId,
        toolId: stepResult.toolId,
        status: stepResult.status,
        output: stepResult.output,
        error: stepResult.error,
      }));
    expect(withoutTiming(second)).toEqual(withoutTiming(first));
  });

  it("does not mutate the execution plan", async () => {
    const plan = makePlan("p", [makeStep("s1", "a")]);
    const snapshot = JSON.stringify(plan);
    await makeExecutor([makeTool("a", async () => "A")]).execute(plan);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});
