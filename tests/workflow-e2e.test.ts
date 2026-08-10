import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WorkflowEngine,
  createProductionWorkflowEngine,
  type TriggerSummary,
} from "@/lib/workflows/production";
import { WorkflowManager } from "@/lib/workflows/manager";
import { WorkflowStepHandlerRegistry } from "@/lib/workflows/executor";
import { createWorkflow, createWorkflowStep, type Workflow, type WorkflowStep } from "@/lib/workflows/types";
import { ActionEngine } from "@/lib/actions/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import type { DigestDataSources } from "@/lib/digest/builder";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { JobManager } from "@/lib/jobs/manager";
import { JobHandlerRegistry } from "@/lib/jobs/executor";
import { ToolRegistry } from "@/lib/tools/registry";
import { ToolExecutor } from "@/lib/tools/executor";
import type { Tool } from "@/lib/tools/types";
import { MORNING_TEMPLATE } from "@/lib/digest/templates";
import { createExecutionPlan } from "@/lib/tools/plan";

const NOW = "2026-08-10T12:00:00.000Z";

function step(
  id: string,
  action: WorkflowStep["action"] = { kind: "job", jobId: `job-${id}` },
  dependsOn: readonly string[] = [],
): WorkflowStep {
  return createWorkflowStep({ id, name: `Step ${id}`, action, dependsOn });
}

function workflow(id: string, overrides: Partial<Parameters<typeof createWorkflow>[0]> = {}): Workflow {
  return createWorkflow({ id, name: `Workflow ${id}`, createdAt: NOW, steps: [step("s1")], ...overrides });
}

function fakeTool(id: string): Tool {
  return {
    id,
    description: `Fake ${id}`,
    inputSchema: z.object({ query: z.string().min(1).optional() }),
    async execute(input) {
      return { ok: true, tool: id, query: (input as { query?: string }).query ?? "" };
    },
  };
}

function fakeToolRegistry(): ToolRegistry {
  return new ToolRegistry(
    ["search.gmail", "search.calendar", "search.drive", "search.github"].map(fakeTool),
  );
}

function fakeSources(): DigestDataSources {
  return {
    listMemories: () => [],
    listConversations: () => [],
    buildContextPrompt: async () => "context prompt",
    listJobs: () => [],
    executeTools: async (plan) => ({
      planId: plan.id,
      results: [],
      succeededStepIds: [],
      failedStepIds: [],
      cancelledStepIds: [],
    }),
  };
}

/** A fully wired engine: fake tools, deterministic clock, fake job handler. */
function makeEngine(options: ConstructorParameters<typeof WorkflowEngine>[0] = {}): WorkflowEngine {
  const actionEngine = new ActionEngine({ toolRegistry: fakeToolRegistry(), now: () => NOW });
  const digestEngine = createProductionDigestEngine({ sources: fakeSources(), now: () => NOW });
  const { manager: jobManagerWithJob } = new JobManager().registerJob({
    id: "job-1",
    name: "Job 1",
    priority: "normal",
    trigger: "manual",
    createdAt: NOW,
  });
  const jobEngine = createProductionJobEngine({
    manager: jobManagerWithJob,
    handlerRegistry: new JobHandlerRegistry().register("job-1", async () => ({ done: true })),
    seedDigestJob: false,
    now: () => NOW,
  });
  return new WorkflowEngine({
    actionEngine,
    digestEngine,
    jobEngine,
    toolExecutor: new ToolExecutor(fakeToolRegistry()),
    now: () => NOW,
    ...options,
  });
}

describe("workflow triggers end to end", () => {
  it("conversation trigger fires a workflow that runs an action step", async () => {
    const w = workflow("conv-wf", {
      trigger: { kind: "conversation", conversationId: "conv-1" },
      steps: [
        createWorkflowStep({
          id: "a1",
          name: "Search",
          action: { kind: "action", intent: "search email", requests: [{ type: "search_gmail" }] },
        }),
      ],
    });
    const { manager } = new WorkflowManager().createWorkflow(w);
    const engine = makeEngine({ manager });
    const summary: TriggerSummary = await engine.triggerWorkflow(
      { kind: "conversation", conversationId: "conv-1", now: NOW },
      { now: NOW, userId: "u" },
    );
    expect(summary.completed).toBe(1);
    expect(engine.findWorkflow("conv-wf")?.status).toBe("completed");
    expect(engine.actionEngine.count()).toBe(1);
  });

  it("memory trigger fires a job step through the Job Engine", async () => {
    const w = workflow("mem-wf", {
      trigger: { kind: "memory", memoryId: "mem-1" },
      steps: [createWorkflowStep({ id: "j1", name: "Run", action: { kind: "job", jobId: "job-1" } })],
    });
    const { manager } = new WorkflowManager().createWorkflow(w);
    const engine = makeEngine({ manager });
    const summary = await engine.triggerWorkflow(
      { kind: "memory", memoryId: "mem-1", now: NOW, signal: { memory: { kind: "task" } } },
      { now: NOW },
    );
    expect(summary.completed).toBe(1);
    expect(engine.jobEngine.manager.find("job-1")?.status).toBe("completed");
  });

  it("digest trigger fires a digest step through the Digest Engine", async () => {
    const w = workflow("dig-wf", {
      trigger: { kind: "digest", digestId: "dig-1" },
      steps: [
        createWorkflowStep({
          id: "d1",
          name: "Digest",
          action: { kind: "digest", template: MORNING_TEMPLATE, query: "today" },
        }),
      ],
    });
    const { manager } = new WorkflowManager().createWorkflow(w);
    const engine = makeEngine({ manager });
    const summary = await engine.triggerWorkflow(
      { kind: "digest", digestId: "dig-1", now: NOW },
      { now: NOW, userId: "u" },
    );
    expect(summary.completed).toBe(1);
    expect(engine.digestEngine.count()).toBe(1);
  });

  it("job trigger fires a tool step through the Tool Executor", async () => {
    const toolPlan = createExecutionPlan({
      id: "tool-plan-1",
      steps: [{ stepId: "s1", toolId: "search.gmail", input: { query: "q" }, dependsOn: [] }],
    });
    const w = workflow("job-wf", {
      trigger: { kind: "job", jobId: "job-1" },
      steps: [createWorkflowStep({ id: "t1", name: "Tool", action: { kind: "tool", plan: toolPlan } })],
    });
    const { manager } = new WorkflowManager().createWorkflow(w);
    const engine = makeEngine({ manager });
    const summary = await engine.triggerWorkflow({ kind: "job", jobId: "job-1", now: NOW }, { now: NOW });
    expect(summary.completed).toBe(1);
  });

  it("manual workflow with dependency ordering and parallel branches", async () => {
    const order: string[] = [];
    const customEngine = new WorkflowEngine({
      now: () => NOW,
      handlerRegistry: new WorkflowStepHandlerRegistry([
        {
          kind: "job",
          handler: async (context) => {
            order.push(context.step.stepId);
            return {};
          },
        },
      ]),
    });
    const w = workflow("branch-wf", {
      trigger: { kind: "manual" },
      steps: [
        step("a", { kind: "job", jobId: "j-a" }, []),
        step("b", { kind: "job", jobId: "j-b" }, []),
        step("c", { kind: "job", jobId: "j-c" }, ["a", "b"]),
      ],
    });
    const { result } = await customEngine.runWorkflow(w, { now: NOW });
    expect(result.completedStepIds).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("scheduled workflow fires only when due", async () => {
    const w = workflow("sched-wf", {
      trigger: { kind: "scheduled", schedule: { at: "2026-08-11T08:00:00.000Z" } },
      steps: [step("s1")],
    });
    const { manager } = new WorkflowManager().createWorkflow(w);
    const engine = makeEngine({
      manager,
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({}) },
      ]),
    });
    // Not due yet.
    let summary = await engine.triggerWorkflow({ kind: "scheduled", now: NOW }, { now: NOW });
    expect(summary.triggered).toHaveLength(0);
    // Due at the scheduled time.
    summary = await engine.triggerWorkflow(
      { kind: "scheduled", now: "2026-08-11T08:00:00.000Z" },
      { now: "2026-08-11T08:00:00.000Z" },
    );
    expect(summary.completed).toBe(1);
    expect(engine.findWorkflow("sched-wf")?.status).toBe("completed");
  });
});

describe("workflow failure isolation end to end", () => {
  it("a failing step does not stop independent workflows in a pass", async () => {
    const failing = workflow("fail-wf", {
      trigger: { kind: "manual" },
      steps: [createWorkflowStep({ id: "s1", name: "S1", action: { kind: "job", jobId: "j-x" } })],
    });
    const ok = workflow("ok-wf", {
      trigger: { kind: "manual" },
      steps: [createWorkflowStep({ id: "s2", name: "S2", action: { kind: "job", jobId: "j-y" } })],
    });
    const { manager } = new WorkflowManager().bulkCreate([
      { id: "fail-wf", name: "Workflow fail-wf", createdAt: NOW, trigger: failing.trigger, steps: failing.steps },
      { id: "ok-wf", name: "Workflow ok-wf", createdAt: NOW, trigger: ok.trigger, steps: ok.steps },
    ]);
    const engine = makeEngine({
      manager,
      handlerRegistry: new WorkflowStepHandlerRegistry([
        {
          kind: "job",
          handler: async (context) => {
            if (context.step.stepId === "s1") throw new Error("boom");
            return {};
          },
        },
      ]),
    });
    const summary = await engine.triggerWorkflow({ kind: "manual", now: NOW }, { now: NOW });
    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(1);
    expect(engine.findWorkflow("fail-wf")?.status).toBe("failed");
    expect(engine.findWorkflow("ok-wf")?.status).toBe("completed");
  });
});

describe("workflow timeouts and abort end to end", () => {
  it("a step timeout fails the workflow structurally", async () => {
    const engine = makeEngine({
      handlerRegistry: new WorkflowStepHandlerRegistry([
        {
          kind: "job",
          handler: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return {};
          },
        },
      ]),
    });
    const w = workflow("timeout-wf", {
      steps: [createWorkflowStep({ id: "s1", name: "S1", action: { kind: "job", jobId: "j-x" }, timeoutMs: 20 })],
    });
    const { result } = await engine.runWorkflow(w, { now: NOW });
    expect(result.failedStepIds).toEqual(["s1"]);
    expect(result.results[0]?.error?.code).toBe("timeout");
  });

  it("abort cancels the run and settles the workflow cancelled", async () => {
    const controller = new AbortController();
    const engine = makeEngine({
      handlerRegistry: new WorkflowStepHandlerRegistry([
        {
          kind: "job",
          handler: async (context) => {
            if (context.step.stepId === "s1") {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return {};
          },
        },
      ]),
    });
    setTimeout(() => controller.abort(), 10);
    const w = workflow("abort-wf", {
      steps: [step("s1", { kind: "job", jobId: "j-x" }, []), step("s2", { kind: "job", jobId: "j-y" }, ["s1"])],
    });
    const { result } = await engine.runWorkflow(w, { now: NOW, signal: controller.signal });
    expect(result.cancelledStepIds).toEqual(["s1", "s2"]);
    expect(engine.findWorkflow("abort-wf")?.status).toBe("cancelled");
  });
});

describe("workflow retries end to end", () => {
  it("retries a flaky step when configured", async () => {
    let attempts = 0;
    const engine = makeEngine({
      handlerRegistry: new WorkflowStepHandlerRegistry([
        {
          kind: "job",
          handler: async () => {
            attempts += 1;
            if (attempts < 3) throw new Error("flaky");
            return { ok: true };
          },
        },
      ]),
    });
    const w = workflow("retry-wf", {
      steps: [createWorkflowStep({ id: "s1", name: "S1", action: { kind: "job", jobId: "j-x" }, maxAttempts: 3, retryDelayMs: 0 })],
    });
    const { result } = await engine.runWorkflow(w, { now: NOW });
    expect(attempts).toBe(3);
    expect(result.completedStepIds).toEqual(["s1"]);
  });
});

describe("workflow immutability and determinism end to end", () => {
  it("the source workflow is never mutated by running", async () => {
    const engine = makeEngine({
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({}) },
      ]),
    });
    const w = workflow("immutable-wf", { steps: [step("a"), step("b", undefined, ["a"])] });
    await engine.runWorkflow(w, { now: NOW });
    expect(w.status).toBe("pending");
    expect(w.steps).toHaveLength(2);
    expect(w.attempts).toBe(0);
  });

  it("identical inputs produce identical outcomes", async () => {
    const run = async (): Promise<string> => {
      const engine = makeEngine({
        handlerRegistry: new WorkflowStepHandlerRegistry([
          { kind: "job", handler: async () => ({}) },
        ]),
      });
      const { result } = await engine.runWorkflow(
        workflow("det-wf", { steps: [step("a"), step("b", undefined, ["a"])] }),
        { now: NOW },
      );
      return result.results.map((r) => `${r.stepId}:${r.status}`).join(",");
    };
    expect(await run()).toBe(await run());
  });

  it("1000-workflow scale through the trigger pass", async () => {
    const inputs = [];
    for (let index = 0; index < 1000; index += 1) {
      inputs.push({
        id: `w-${index}`,
        name: `W${index}`,
        createdAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
        steps: [step("s1")],
      });
    }
    const { manager } = new WorkflowManager().bulkCreate(inputs);
    const engine = makeEngine({
      manager,
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({}) },
      ]),
    });
    const summary = await engine.triggerWorkflow({ kind: "manual", now: NOW }, { now: NOW });
    expect(summary.triggered).toHaveLength(1000);
    expect(summary.completed).toBe(1000);
  });
});

describe("production composition end to end", () => {
  it("createProductionWorkflowEngine composes the full stack", async () => {
    const engine = createProductionWorkflowEngine({ now: () => NOW });
    const w = workflow("prod-wf", {
      trigger: { kind: "manual" },
      steps: [
        createWorkflowStep({
          id: "a1",
          name: "Search",
          action: { kind: "action", intent: "search email", requests: [{ type: "search_gmail" }] },
        }),
      ],
    });
    const { result } = await engine.runWorkflow(w, { now: NOW, userId: "u" });
    expect(result.completedStepIds).toEqual(["a1"]);
    expect(engine.findWorkflow("prod-wf")?.status).toBe("completed");
  });
});
