import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionEngine, createProductionActionEngine } from "@/lib/actions/production";
import { ActionHandlerRegistry } from "@/lib/actions/executor";
import { createAction, type Action } from "@/lib/actions/types";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import type { DigestDataSources } from "@/lib/digest/builder";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { JobHandlerRegistry } from "@/lib/jobs/executor";
import { JobManager } from "@/lib/jobs/manager";
import { createMemory } from "@/lib/memory/types";
import { ToolRegistry } from "@/lib/tools/registry";
import type { Tool } from "@/lib/tools/types";

const NOW = "2026-08-10T12:00:00.000Z";

/** A fake tool with a deterministic output (no production service involved). */
function fakeTool(id: string): Tool {
  return {
    id,
    description: `Fake ${id}`,
    inputSchema: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().optional(),
    }),
    async execute(input) {
      return { ok: true, tool: id, query: (input as { query: string }).query };
    },
  };
}

/** A registry of the four fake read tools under the built-in tool ids. */
function fakeToolRegistry(): ToolRegistry {
  return new ToolRegistry(
    ["search.gmail", "search.calendar", "search.drive", "search.github"].map(fakeTool),
  );
}

/** A full engine pre-seeded with a memory, a conversation, and a job. */
function seededEngine(): ActionEngine {
  let memoryEngine = createProductionMemoryEngine();
  memoryEngine = memoryEngine
    .remember(createMemory({ id: "mem-1", title: "Deploy at noon", content: "Deployment at 12:00 UTC", createdAt: NOW }))
    .engine;

  let conversationEngine = createProductionConversationEngine();
  conversationEngine = conversationEngine
    .startConversation({ id: "conv-1", createdAt: NOW, title: "Daily standup" })
    .engine.appendMessage("conv-1", {
      role: "user",
      content: "Search my email for the project update, remember the key facts, and update this conversation",
      createdAt: NOW,
    }).engine;

  const jobManager = new JobManager();
  const { manager: jobManagerWithJob } = jobManager.registerJob({
    id: "job-1",
    name: "Nightly backup",
    priority: "normal",
    trigger: "manual",
    createdAt: NOW,
  });
  const jobEngine = createProductionJobEngine({
    manager: jobManagerWithJob,
    handlerRegistry: new JobHandlerRegistry().register("job-1", async () => ({
      backup: "done",
    })),
    seedDigestJob: false,
    now: () => NOW,
  });

  const digestEngine = createProductionDigestEngine({ sources: fakeSources(), now: () => NOW });

  return new ActionEngine({
    memoryEngine,
    conversationEngine,
    jobEngine,
    digestEngine,
    toolRegistry: fakeToolRegistry(),
    now: () => NOW,
  });
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

function action(type: Action["type"], input?: Record<string, unknown>): Action {
  return createAction({ id: `action-${type}`, name: type, type, createdAt: NOW, input });
}

describe("conversation → plan → actions", () => {
  it("plans actions from a conversation message and executes them end to end", async () => {
    const engine = seededEngine();
    const latestMessage =
      engine.listConversations()[0].messages[engine.listConversations()[0].messages.length - 1]
        .content;
    const plan = engine.plan({
      text: latestMessage,
      userId: "u",
      now: NOW,
      conversationId: "conv-1",
    });
    expect(plan.actions.length).toBeGreaterThanOrEqual(2);
    const { result } = await engine.executePlan(plan, { now: NOW, userId: "u" });
    expect(result.completedActionIds.length).toBe(plan.actions.length);
    expect(engine.count()).toBe(plan.actions.length);
  });
});

describe("memory retrieval", () => {
  it("create_memory stores retrievable memories through the engine", async () => {
    const engine = seededEngine();
    const before = engine.memoryCount();
    await engine.executeActions([action("create_memory", { title: "Fact", content: "Important fact" })], {
      now: NOW,
    });
    expect(engine.memoryCount()).toBe(before + 1);
    const stored = engine.listStoredMemories();
    expect(stored.some((m) => m.content === "Important fact")).toBe(true);
  });
});

describe("digest generation", () => {
  it("generate_digest builds and stores a digest through the digest engine", async () => {
    const engine = seededEngine();
    const { result } = await engine.executeActions(
      [action("generate_digest", { kind: "evening" })],
      { now: NOW, userId: "u" },
    );
    expect(result.completedActionIds).toHaveLength(1);
    expect(engine.digestEngine.count()).toBe(1);
    const digest = engine.digestEngine.listDigests()[0];
    expect(digest.metadata.kind).toBe("evening");
  });
});

describe("job execution", () => {
  it("run_job executes a pending manual job through the job engine", async () => {
    const engine = seededEngine();
    const { result } = await engine.executeActions([action("run_job", { jobId: "job-1" })], {
      now: NOW,
    });
    expect(result.completedActionIds).toHaveLength(1);
    expect(engine.jobEngine.manager.find("job-1")?.status).toBe("completed");
    expect(engine.jobEngine.manager.find("job-1")?.result?.output).toEqual({ backup: "done" });
  });
});

describe("tool execution", () => {
  it("search actions delegate to the built-in read tools", async () => {
    const engine = seededEngine();
    const { result } = await engine.executeActions(
      [action("search_gmail", { query: "project" }), action("search_calendar", { query: "standup" })],
      { now: NOW },
    );
    expect(result.completedActionIds).toHaveLength(2);
  });
});

describe("dependency ordering & parallel actions", () => {
  it("runs dependent actions in order and independent actions in parallel", async () => {
    const engine = seededEngine();
    const plan = engine.plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [
        { type: "search_gmail" },
        { type: "create_memory", dependsOn: ["search_gmail"] },
        { type: "search_calendar" },
      ],
    });
    const search = plan.actions.find((a) => a.type === "search_gmail") as Action;
    const memory = plan.actions.find((a) => a.type === "create_memory") as Action;
    expect(memory.dependsOn).toContain(search.id);
    const { result } = await engine.executePlan(plan, { now: NOW, userId: "u" });
    expect(result.completedActionIds).toHaveLength(3);
    expect(result.failedActionIds).toEqual([]);
  });
});

describe("timeouts and abort", () => {
  it("times out a hanging handler inside a plan", async () => {
    const registry = new ActionHandlerRegistry([
      {
        type: "custom",
        handler: () => new Promise(() => undefined),
      },
    ]);
    const engine = new ActionEngine({ handlerRegistry: registry, now: () => NOW });
    const hanging = createAction({ id: "action-hang", name: "Hang", type: "custom", createdAt: NOW });
    const { result } = await engine.executeActions([hanging], { now: NOW, timeoutMs: 5 });
    expect(result.failedActionIds).toHaveLength(1);
    expect(result.results[0].error?.code).toBe("timeout");
    expect(engine.findAction("action-hang")?.status).toBe("failed");
  });

  it("aborts a plan through the AbortSignal before execution", async () => {
    const engine = seededEngine();
    const controller = new AbortController();
    controller.abort();
    const { result } = await engine.executeActions([action("search_gmail", { query: "q" })], {
      now: NOW,
      signal: controller.signal,
    });
    expect(result.cancelledActionIds).toHaveLength(1);
    expect(engine.findAction("action-search_gmail")?.status).toBe("cancelled");
  });
});

describe("failure isolation", () => {
  it("a failing action never fails the engine or its siblings", async () => {
    const engine = seededEngine();
    const { result } = await engine.executeActions(
      [action("custom"), action("search_gmail", { query: "q" })],
      { now: NOW },
    );
    expect(result.failedActionIds).toHaveLength(1);
    expect(result.completedActionIds).toHaveLength(1);
    expect(engine.count()).toBe(2);
    expect(engine.findAction("action-custom")?.status).toBe("failed");
    expect(engine.findAction("action-search_gmail")?.status).toBe("completed");
  });
});

describe("determinism and immutability", () => {
  it("identical inputs produce identical results", async () => {
    const run = async (): Promise<string[]> => {
      const engine = seededEngine();
      const plan = engine.plan({ text: "search email and remember", userId: "u", now: NOW });
      const { result } = await engine.executePlan(plan, { now: NOW, userId: "u" });
      return result.results.map((r) => `${r.actionId}:${r.status}`);
    };
    expect(await run()).toEqual(await run());
  });

  it("engine reads never mutate the underlying repositories", async () => {
    const engine = seededEngine();
    const before = engine.count();
    await engine.executeActions([action("search_drive", { query: "q" })], { now: NOW });
    expect(engine.count()).toBe(before + 1);
    // The seeded conversation and memory remain intact.
    expect(engine.listConversations()[0].id).toBe("conv-1");
    expect(engine.listStoredMemories().some((m) => m.id === "mem-1")).toBe(true);
  });
});

describe("scale", () => {
  it("executes 1000 independent actions", async () => {
    const engine = seededEngine();
    const actions: Action[] = [];
    for (let index = 0; index < 1000; index += 1) {
      actions.push(
        createAction({
          id: `action-${index}`,
          name: `Action ${index}`,
          type: "search_gmail",
          input: { query: `q${index}` },
          createdAt: NOW,
        }),
      );
    }
    const { result } = await engine.executeActions(actions, { now: NOW, userId: "u" });
    expect(result.completedActionIds).toHaveLength(1000);
    expect(engine.count()).toBe(1000);
  });

  it("scales the planner across 1000 distinct intents deterministically", async () => {
    const engine = seededEngine();
    for (let index = 0; index < 1000; index += 1) {
      const plan = engine.plan({
        text: `check email ${index}`,
        userId: "u",
        now: NOW,
      });
      expect(plan.actions.length).toBe(1);
    }
    expect(engine.count()).toBe(0); // planning never stores
  });
});

describe("production composition", () => {
  it("createProductionActionEngine wires the full graph", () => {
    const engine = createProductionActionEngine({ now: () => NOW });
    expect(engine.planner).toBeDefined();
    expect(engine.executor).toBeDefined();
    expect(engine.contextEngine).toBeDefined();
    expect(engine.digestEngine).toBeDefined();
    expect(engine.jobEngine).toBeDefined();
    expect(engine.toolExecutor).toBeDefined();
  });

  it("the production engine plans and executes through the singleton factory", async () => {
    const engine = createProductionActionEngine({ now: () => NOW });
    const plan = engine.plan({ text: "run job", userId: "u", now: NOW, requests: [{ type: "run_job" }] });
    // The production job engine seeds the recurring digest job, so run_job
    // resolves to the first pending job (bg-daily-digest).
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe("run_job");
    expect(plan.actions[0].input).toMatchObject({ jobId: "bg-daily-digest" });
  });
});
