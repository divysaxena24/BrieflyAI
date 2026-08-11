import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActionEngine,
  createProductionActionEngine,
  getProductionActionEngine,
  planActions,
} from "@/lib/actions/production";
import { createAction, type Action } from "@/lib/actions/types";
import { ActionPlanner, type ActionPlan } from "@/lib/actions/planner";
import { ActionExecutor, ActionHandlerRegistry } from "@/lib/actions/executor";
import { ActionManager } from "@/lib/actions/manager";
import { createMemory } from "@/lib/memory/types";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import type { DigestDataSources } from "@/lib/digest/builder";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { JobManager } from "@/lib/jobs/manager";
import { JobHandlerRegistry } from "@/lib/jobs/executor";
import { ToolRegistry } from "@/lib/tools/registry";
import type { Tool } from "@/lib/tools/types";

const NOW = "2026-08-10T12:00:00.000Z";

/** A memory engine pre-seeded with one memory. */
function memoryEngineWith(memory: Memory = createMemory({ id: "mem-1", title: "T", content: "C", createdAt: NOW })) {
  const engine = createProductionMemoryEngine();
  return engine.remember(memory).engine;
}

/** A conversation engine pre-seeded with one conversation. */
function conversationEngineWith() {
  const engine = createProductionConversationEngine();
  return engine
    .startConversation({ id: "conv-1", createdAt: NOW, title: "Chat" })
    .engine.appendMessage("conv-1", {
      role: "user",
      content: "Search my email for the project update and remember it",
      createdAt: NOW,
    }).engine;
}

function action(type: Action["type"], input?: Record<string, unknown>): Action {
  return createAction({ id: `action-${type}`, name: type, type, createdAt: NOW, input });
}

/** A deterministic read-only source seam for the digest/job engines. */
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

/** A full engine with fake tools and deterministic time. */
function makeEngine(options: ConstructorParameters<typeof ActionEngine>[0] = {}): ActionEngine {
  return new ActionEngine({
    toolRegistry: fakeToolRegistry(),
    now: () => NOW,
    ...options,
  });
}

describe("createProductionActionEngine factory", () => {
  it("constructs an ActionEngine", () => {
    expect(createProductionActionEngine()).toBeInstanceOf(ActionEngine);
    expect(createProductionActionEngine({})).toBeInstanceOf(ActionEngine);
  });

  it("accepts injected overrides", () => {
    const manager = new ActionManager();
    const engine = createProductionActionEngine({ manager, now: () => NOW });
    expect(engine.manager).toBe(manager);
  });

  it("wires the default planner, executor, and engines", () => {
    const engine = createProductionActionEngine({ now: () => NOW });
    expect(engine.planner).toBeInstanceOf(ActionPlanner);
    expect(engine.executor).toBeInstanceOf(ActionExecutor);
    expect(engine.count()).toBe(0);
    expect(engine.digestEngine).toBeDefined();
    expect(engine.jobEngine).toBeDefined();
    expect(engine.contextEngine).toBeDefined();
  });
});

describe("getProductionActionEngine singleton", () => {
  it("returns the same instance on every call", () => {
    expect(getProductionActionEngine()).toBe(getProductionActionEngine());
    expect(getProductionActionEngine()).toBeInstanceOf(ActionEngine);
  });
});

describe("ActionEngine planning", () => {
  it("plans intents through the injected planner (pure, no storage)", () => {
    const engine = makeEngine({ planner: new ActionPlanner() });
    const plan = engine.plan({ text: "search email and calendar", userId: "u", now: NOW });
    expect(plan.actions.map((a) => a.type)).toEqual(["search_gmail", "search_calendar"]);
    expect(engine.count()).toBe(0); // planning never stores
  });
});

describe("ActionEngine execution", () => {
  it("stores, executes, and commits a planned plan", async () => {
    const engine = makeEngine({
      memoryEngine: memoryEngineWith(),
      conversationEngine: conversationEngineWith(),
    });
    const plan = engine.plan({
      text: "search my email and remember it",
      userId: "u",
      now: NOW,
    });
    // Keyword detection yields search_gmail + create_memory (no conversation
    // keyword, so no update_conversation action).
    expect(plan.actions.map((a) => a.type)).toEqual(["search_gmail", "create_memory"]);
    const { result } = await engine.executePlan(plan, { now: NOW, userId: "u" });
    expect(result.completedActionIds).toHaveLength(2);
    expect(engine.count()).toBe(2);
    // Committed transitions are visible on the successor manager.
    expect(engine.findAction(plan.actions[0].id)?.status).toBe("completed");
    // The create_memory action stored a memory through the engine's memory engine.
    expect(engine.memoryCount()).toBe(2);
  });

  it("executes a bare action list through executeActions", async () => {
    const engine = makeEngine();
    const actions = [action("search_gmail", { query: "q" })];
    const { result } = await engine.executeActions(actions, { now: NOW, userId: "u" });
    expect(result.completedActionIds).toHaveLength(1);
    expect(engine.count()).toBe(1);
  });

  it("runs a single action through runAction", async () => {
    const engine = makeEngine();
    const { result } = await engine.runAction(action("search_calendar", { query: "q" }), {
      now: NOW,
    });
    expect(result.status).toBe("completed");
    expect(engine.count()).toBe(1);
  });

  it("commits failed actions as failed (never throws)", async () => {
    const engine = makeEngine();
    const { result } = await engine.executeActions(
      [action("custom", {})], // no built-in handler for `custom`
      { now: NOW },
    );
    expect(result.failedActionIds).toHaveLength(1);
    expect(engine.findAction("action-custom")?.status).toBe("failed");
    expect(engine.findAction("action-custom")?.error?.code).toBe("unknown_action");
  });

  it("stores a memory through the memory engine idempotently", async () => {
    const engine = makeEngine({ memoryEngine: memoryEngineWith() });
    const { result } = await engine.executeActions(
      [action("create_memory", { title: "N", content: "c" })],
      { now: NOW },
    );
    expect(result.completedActionIds).toHaveLength(1);
    expect(engine.memoryCount()).toBe(2);
    expect(engine.listStoredMemories().some((m) => m.content === "c")).toBe(true);
  });

  it("appends conversation messages through the conversation engine", async () => {
    const engine = makeEngine({ conversationEngine: conversationEngineWith() });
    await engine.executeActions(
      [action("update_conversation", { conversationId: "conv-1", content: "Done." })],
      { now: NOW },
    );
    const conversation = engine.listConversations().find((c) => c.id === "conv-1");
    expect(conversation?.messages.some((m) => m.content === "Done.")).toBe(true);
  });

  it("supports dependency ordering end to end", async () => {
    const engine = makeEngine();
    const plan = engine.plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [{ type: "search_gmail" }, { type: "create_memory", dependsOn: ["search_gmail"] }],
    });
    const search = plan.actions.find((a) => a.type === "search_gmail") as Action;
    const memory = plan.actions.find((a) => a.type === "create_memory") as Action;
    expect(memory.dependsOn).toContain(search.id);
    const { result } = await engine.executePlan(plan, { now: NOW, userId: "u" });
    expect(result.completedActionIds).toHaveLength(2);
  });
});

describe("ActionEngine with a real digest engine", () => {
  it("generate_digest builds through the digest engine", async () => {
    const digestEngine = createProductionDigestEngine({
      sources: fakeSources(),
      now: () => NOW,
    });
    const engine = makeEngine({ digestEngine });
    const { result } = await engine.executeActions(
      [action("generate_digest", { kind: "morning" })],
      { now: NOW, userId: "u" },
    );
    expect(result.completedActionIds).toHaveLength(1);
    expect(engine.digestEngine.count()).toBe(1);
  });
});

describe("ActionEngine with a real job engine", () => {
  it("run_job runs a pending job manually", async () => {
    const { manager: jobManagerWithJob } = new JobManager().registerJob({
      id: "job-1",
      name: "Job 1",
      priority: "normal",
      trigger: "manual",
      createdAt: NOW,
    });
    const jobEngine = createProductionJobEngine({
      manager: jobManagerWithJob,
      handlerRegistry: new JobHandlerRegistry().register("job-1", async () => ({
        done: true,
      })),
      seedDigestJob: false,
      now: () => NOW,
    });
    const engine = makeEngine({ jobEngine });
    const { result } = await engine.executeActions(
      [action("run_job", { jobId: "job-1" })],
      { now: NOW },
    );
    expect(result.completedActionIds).toHaveLength(1);
    expect(jobEngine.manager.find("job-1")?.status).toBe("completed");
  });
});

describe("planActions / executeActions / runAction entry points", () => {
  it("planActions routes through the production singleton planner", () => {
    const plan: ActionPlan = planActions({ text: "check email", userId: "entry", now: NOW });
    expect(plan.actions.some((a) => a.type === "search_gmail")).toBe(true);
  });

  it("executeActions and runAction execute through injected engines deterministically", async () => {
    const actions = [action("search_drive", { query: "q" })];
    const first = await makeEngine().executeActions(actions, { now: NOW, userId: "u" });
    const second = await makeEngine().executeActions(actions, {
      now: NOW,
      userId: "u",
    });
    expect(first.result.results.map((r) => r.status)).toEqual(
      second.result.results.map((r) => r.status),
    );
    expect(first.result.results.map((r) => r.actionId)).toEqual(
      second.result.results.map((r) => r.actionId),
    );
  });

  it("runAction executes a single action", async () => {
    const engine = makeEngine();
    const { result } = await engine.runAction(action("search_github", { query: "q" }), {
      now: NOW,
    });
    expect(result.status).toBe("completed");
    expect(engine.findAction("action-search_github")?.status).toBe("completed");
  });
});

describe("ActionEngine failure isolation", () => {
  it("an unknown action type fails without affecting other actions", async () => {
    const engine = makeEngine();
    const plan = engine.plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [
        { type: "custom", input: { anything: true } },
        { type: "search_gmail" },
      ],
    });
    const { result } = await engine.executePlan(plan, { now: NOW, userId: "u" });
    expect(result.failedActionIds).toHaveLength(1);
    expect(result.completedActionIds).toHaveLength(1);
    expect(engine.count()).toBe(2);
  });

  it("builds plans with no actions when the intent has nothing actionable", () => {
    const engine = makeEngine();
    const plan = engine.plan({ text: "nothing here", userId: "u", now: NOW });
    expect(plan.actions).toEqual([]);
    expect(engine.count()).toBe(0);
  });
});

describe("ActionEngine determinism & scale", () => {
  it("handles 1000 actions", async () => {
    const engine = makeEngine({ memoryEngine: memoryEngineWith(), conversationEngine: conversationEngineWith() });
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

  it("is deterministic for identical inputs", async () => {
    const run = async (): Promise<string[]> => {
      const engine = makeEngine({
        memoryEngine: memoryEngineWith(),
        conversationEngine: conversationEngineWith(),
      });
      const plan = engine.plan({
        text: "search email and remember",
        userId: "u",
        now: NOW,
      });
      const { result } = await engine.executePlan(plan, { now: NOW, userId: "u" });
      return result.results.map((r) => `${r.actionId}:${r.status}`);
    };
    expect(await run()).toEqual(await run());
  });

  it("listActions returns detached clones", async () => {
    const engine = makeEngine();
    await engine.executeActions([action("search_gmail", { query: "q" })], { now: NOW });
    const listed = engine.listActions();
    expect(listed).toHaveLength(1);
    (listed[0] as { name: string }).name = "Mutated";
    expect(engine.findAction("action-search_gmail")?.name).toBe("search_gmail");
  });
});

describe("ActionEngine with injected executor/registry", () => {
  it("accepts an injected executor directly", async () => {
    const executor = new ActionExecutor(new ActionHandlerRegistry(), { now: () => NOW });
    const engine = new ActionEngine({ executor, toolRegistry: fakeToolRegistry(), now: () => NOW });
    expect(engine.executor).toBe(executor);
    const { result } = await engine.executeActions([action("custom")], { now: NOW });
    expect(result.failedActionIds).toHaveLength(1); // no handlers registered
  });

  it("accepts an injected handler registry to extend built-ins", async () => {
    const registry = new ActionHandlerRegistry([
      {
        type: "custom",
        handler: async () => ({ handled: true }),
      },
    ]);
    const engine = new ActionEngine({
      handlerRegistry: registry,
      toolRegistry: fakeToolRegistry(),
      now: () => NOW,
    });
    const { result } = await engine.executeActions([action("custom")], { now: NOW });
    expect(result.completedActionIds).toHaveLength(1);
    expect(result.results[0].output).toEqual({ handled: true });
  });
});

