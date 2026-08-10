import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createProductionWorkflowEngine,
  getProductionWorkflowEngine,
  runWorkflow,
  triggerWorkflow,
  WorkflowEngine,
  type TriggerSummary,
} from "@/lib/workflows/production";
import { WorkflowManager } from "@/lib/workflows/manager";
import {
  WorkflowExecutor,
  WorkflowStepHandlerRegistry,
} from "@/lib/workflows/executor";
import { WorkflowPlanner } from "@/lib/workflows/planner";
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

function step(id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return createWorkflowStep({
    id,
    name: `Step ${id}`,
    action: { kind: "job", jobId: `job-${id}` },
    ...overrides,
  });
}

function workflow(id: string, overrides: Partial<Parameters<typeof createWorkflow>[0]> = {}): Workflow {
  return createWorkflow({
    id,
    name: `Workflow ${id}`,
    createdAt: NOW,
    steps: [step("s1")],
    ...overrides,
  });
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

/** A full engine with fake step handlers and deterministic time. */
function makeEngine(options: ConstructorParameters<typeof WorkflowEngine>[0] = {}): WorkflowEngine {
  return new WorkflowEngine({
    now: () => NOW,
    ...options,
  });
}

describe("createProductionWorkflowEngine factory", () => {
  it("constructs a WorkflowEngine", () => {
    expect(createProductionWorkflowEngine()).toBeInstanceOf(WorkflowEngine);
    expect(createProductionWorkflowEngine({})).toBeInstanceOf(WorkflowEngine);
  });

  it("accepts injected overrides", () => {
    const manager = new WorkflowManager();
    const engine = createProductionWorkflowEngine({ manager, now: () => NOW });
    expect(engine.manager).toBe(manager);
  });

  it("wires the default planner, executor, and engines", () => {
    const engine = createProductionWorkflowEngine({ now: () => NOW });
    expect(engine.planner).toBeInstanceOf(WorkflowPlanner);
    expect(engine.executor).toBeInstanceOf(WorkflowExecutor);
    expect(engine.count()).toBe(0);
    expect(engine.actionEngine).toBeDefined();
    expect(engine.jobEngine).toBeDefined();
    expect(engine.digestEngine).toBeDefined();
    expect(engine.toolExecutor).toBeDefined();
  });
});

describe("getProductionWorkflowEngine singleton", () => {
  it("returns the same instance on every call", () => {
    expect(getProductionWorkflowEngine()).toBe(getProductionWorkflowEngine());
    expect(getProductionWorkflowEngine()).toBeInstanceOf(WorkflowEngine);
  });
});

describe("WorkflowEngine planning", () => {
  it("plans workflows through the injected planner (pure, no storage)", () => {
    const engine = makeEngine();
    const plan = engine.plan(workflow("w1"), { now: NOW });
    expect(plan.workflowId).toBe("w1");
    expect(engine.count()).toBe(0);
  });
});

describe("WorkflowEngine execution", () => {
  it("stores, plans, runs, and commits a workflow", async () => {
    const engine = makeEngine({
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({ done: true }) },
      ]),
    });
    const { result } = await engine.runWorkflow(workflow("w1"), { now: NOW, userId: "u" });
    expect(result.completedStepIds).toEqual(["s1"]);
    expect(engine.count()).toBe(1);
    expect(engine.findWorkflow("w1")?.status).toBe("completed");
    expect(engine.findWorkflow("w1")?.result?.success).toBe(true);
  });

  it("commits a failed step as a failed workflow (never throws)", async () => {
    const engine = makeEngine({
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => {
          throw new Error("boom");
        } },
      ]),
    });
    const { result } = await engine.runWorkflow(workflow("w1"), { now: NOW });
    expect(result.failedStepIds).toEqual(["s1"]);
    expect(engine.findWorkflow("w1")?.status).toBe("failed");
    expect(engine.findWorkflow("w1")?.error?.code).toBe("step_failed");
  });

  it("re-arms completed recurring workflows", async () => {
    const engine = makeEngine({
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({}) },
      ]),
    });
    const w = workflow("w1", {
      trigger: { kind: "scheduled", schedule: { everyMs: 3600000, startsAt: "2026-08-10T08:00:00.000Z" } },
    });
    const { result } = await engine.runWorkflow(w, { now: NOW });
    expect(result.completedStepIds).toEqual(["s1"]);
    const stored = engine.findWorkflow("w1");
    expect(stored?.status).toBe("pending");
    expect(stored?.scheduledAt).toBe("2026-08-10T13:00:00.000Z");
  });

  it("runWorkflow re-runs a stored workflow instead of duplicating it", async () => {
    const engine = makeEngine({
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({}) },
      ]),
    });
    const first = await engine.runWorkflow(workflow("w1"), { now: NOW });
    expect(first.result.completedStepIds).toEqual(["s1"]);
    expect(engine.count()).toBe(1);
    // A second run against the same stored id re-runs (the workflow was
    // completed, so the run starts from its current state — no duplicate).
    const second = await engine.runWorkflow(workflow("w1"), { now: NOW });
    expect(second.result.completedStepIds).toEqual(["s1"]);
    expect(engine.count()).toBe(1);
    expect(engine.findWorkflow("w1")?.attempts).toBeGreaterThan(1);
  });
});

describe("WorkflowEngine with a real action engine", () => {
  it("action steps execute through the Action Engine", async () => {
    const actionEngine = new ActionEngine({
      toolRegistry: fakeToolRegistry(),
      now: () => NOW,
    });
    const engine = new WorkflowEngine({
      actionEngine,
      now: () => NOW,
    });
    const w = workflow("w1", {
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
    expect(actionEngine.count()).toBe(1);
    expect(actionEngine.findAction(actionEngine.listActions()[0]?.id ?? "")?.status).toBe("completed");
  });

  it("job steps run background jobs through the Job Engine", async () => {
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
    const engine = new WorkflowEngine({ jobEngine, now: () => NOW });
    const w = workflow("w1", {
      steps: [createWorkflowStep({ id: "j1", name: "Run", action: { kind: "job", jobId: "job-1" } })],
    });
    const { result } = await engine.runWorkflow(w, { now: NOW });
    expect(result.completedStepIds).toEqual(["j1"]);
    expect(jobEngine.manager.find("job-1")?.status).toBe("completed");
  });

  it("digest steps build through the Digest Engine", async () => {
    const digestEngine = createProductionDigestEngine({
      sources: fakeSources(),
      now: () => NOW,
    });
    const engine = new WorkflowEngine({ digestEngine, now: () => NOW });
    const w = workflow("w1", {
      steps: [
        createWorkflowStep({
          id: "d1",
          name: "Digest",
          action: { kind: "digest", template: MORNING_TEMPLATE, query: "today" },
        }),
      ],
    });
    const { result } = await engine.runWorkflow(w, { now: NOW, userId: "u" });
    expect(result.completedStepIds).toEqual(["d1"]);
    expect(digestEngine.count()).toBe(1);
  });

  it("tool steps execute through the Tool Executor", async () => {
    const toolExecutor = new ToolExecutor(fakeToolRegistry());
    const engine = new WorkflowEngine({ toolExecutor, now: () => NOW });
    const toolPlan = createExecutionPlan({
      id: "tool-plan-1",
      steps: [{ stepId: "s1", toolId: "search.gmail", input: { query: "q" }, dependsOn: [] }],
    });
    const w = workflow("w1", {
      steps: [
        createWorkflowStep({
          id: "t1",
          name: "Tool",
          action: { kind: "tool", plan: toolPlan },
        }),
      ],
    });
    const { result } = await engine.runWorkflow(w, { now: NOW });
    expect(result.completedStepIds).toEqual(["t1"]);
  });
});

describe("WorkflowEngine triggers", () => {
  it("triggerWorkflow fires matching workflows", async () => {
    const w = workflow("w1", { trigger: { kind: "conversation", conversationId: "conv-1" } });
    const { manager } = new WorkflowManager().createWorkflow(w);
    const engine = makeEngine({
      manager,
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({}) },
      ]),
    });
    const summary: TriggerSummary = await engine.triggerWorkflow(
      { kind: "conversation", conversationId: "conv-1", now: NOW },
      { now: NOW },
    );
    expect(summary.triggered).toHaveLength(1);
    expect(summary.completed).toBe(1);
    expect(engine.findWorkflow("w1")?.status).toBe("completed");
  });

  it("triggerWorkflow ignores already-settled workflows", async () => {
    const w = workflow("w1", { trigger: { kind: "manual" } });
    const { manager } = new WorkflowManager().createWorkflow(w);
    const engineWithManager = makeEngine({
      manager,
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({}) },
      ]),
    });
    // First fire: runs and completes.
    const first = await engineWithManager.triggerWorkflow({ kind: "manual", now: NOW }, { now: NOW });
    expect(first.completed).toBe(1);
    // Second fire: the workflow is completed → not runnable → nothing fires.
    const second = await engineWithManager.triggerWorkflow({ kind: "manual", now: NOW }, { now: NOW });
    expect(second.triggered).toHaveLength(0);
  });

  it("triggerWorkflow isolates a failing workflow without stopping the pass", async () => {
    const { manager } = new WorkflowManager().bulkCreate([
      { id: "w1", name: "W1", createdAt: NOW, trigger: { kind: "memory", memoryId: "mem-1" }, steps: [step("s1")] },
      { id: "w2", name: "W2", createdAt: NOW, trigger: { kind: "memory", memoryId: "mem-1" }, steps: [step("s1")] },
    ]);
    const engine = makeEngine({
      manager,
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => {
          throw new Error("boom");
        } },
      ]),
    });
    const summary = await engine.triggerWorkflow(
      { kind: "memory", memoryId: "mem-1", now: NOW },
      { now: NOW },
    );
    expect(summary.triggered).toHaveLength(2);
    expect(summary.failed).toBe(2);
    expect(engine.findWorkflow("w1")?.status).toBe("failed");
    expect(engine.findWorkflow("w2")?.status).toBe("failed");
  });
});

describe("WorkflowEngine determinism & scale", () => {
  it("handles 1000 workflows deterministically", async () => {
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
    const engineWith = makeEngine({
      manager,
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({}) },
      ]),
    });
    const summary = await engineWith.triggerWorkflow({ kind: "manual", now: NOW }, { now: NOW });
    expect(summary.triggered).toHaveLength(1000);
    expect(summary.completed).toBe(1000);
    expect(engineWith.count()).toBe(1000);
  });

  it("is deterministic for identical inputs", async () => {
    const run = async (): Promise<string> => {
      const engine = makeEngine({
        handlerRegistry: new WorkflowStepHandlerRegistry([
          { kind: "job", handler: async () => ({}) },
        ]),
      });
      const { result } = await engine.runWorkflow(
        workflow("w1", { steps: [step("a"), step("b", { dependsOn: ["a"] })] }),
        { now: NOW },
      );
      return result.results.map((r) => `${r.stepId}:${r.status}`).join(",");
    };
    expect(await run()).toBe(await run());
  });

  it("listWorkflows returns detached clones", async () => {
    const engine = makeEngine({
      handlerRegistry: new WorkflowStepHandlerRegistry([
        { kind: "job", handler: async () => ({}) },
      ]),
    });
    await engine.runWorkflow(workflow("w1"), { now: NOW });
    const listed = engine.listWorkflows();
    expect(listed).toHaveLength(1);
    (listed[0] as { name: string }).name = "Mutated";
    expect(engine.findWorkflow("w1")?.name).toBe("Workflow w1");
  });
});

describe("runWorkflow / triggerWorkflow entry points", () => {
  it("runWorkflow routes through the production singleton", async () => {
    const singleton = getProductionWorkflowEngine();
    // A job step referencing an unregistered job id is a graceful empty run,
    // so the singleton path stays deterministic without real services.
    const w = workflow("entry-wf-1", {
      steps: [createWorkflowStep({ id: "j1", name: "Run", action: { kind: "job", jobId: "missing-job" } })],
    });
    const { result } = await runWorkflow(w, { now: NOW, userId: "entry" });
    expect(result.completedStepIds).toEqual(["j1"]);
    expect(singleton.findWorkflow("entry-wf-1")?.status).toBe("completed");
  });

  it("triggerWorkflow routes through the production singleton", async () => {
    const singleton = getProductionWorkflowEngine();
    // Nothing pending in the fresh singleton → the pass fires nothing but
    // still returns a well-formed summary.
    const summary = await triggerWorkflow({ kind: "manual", now: NOW }, { now: NOW });
    expect(summary.total).toBe(0);
    expect(summary.triggered).toEqual([]);
    expect(typeof summary.completed).toBe("number");
    expect(singleton.count()).toBeGreaterThanOrEqual(0);
  });
});

describe("WorkflowEngine with injected executor/registry", () => {
  it("accepts an injected executor directly", async () => {
    const executor = new WorkflowExecutor(new WorkflowStepHandlerRegistry([]), { now: () => NOW });
    const engine = makeEngine({ executor });
    expect(engine.executor).toBe(executor);
    const { result } = await engine.runWorkflow(workflow("w1"), { now: NOW });
    expect(result.failedStepIds).toEqual(["s1"]); // no handlers registered
    expect(result.results[0]?.error?.code).toBe("unknown_step_kind");
  });

  it("accepts an injected handler registry to extend built-ins", async () => {
    const registry = new WorkflowStepHandlerRegistry([
      { kind: "job", handler: async () => ({ handled: true }) },
    ]);
    const engine = makeEngine({ handlerRegistry: registry });
    const { result } = await engine.runWorkflow(workflow("w1"), { now: NOW });
    expect(result.completedStepIds).toEqual(["s1"]);
  });
});
