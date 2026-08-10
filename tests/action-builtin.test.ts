import { describe, expect, it, vi } from "vitest";
import {
  createBuiltInActionHandlers,
  type BuiltinActionDependencies,
} from "@/lib/actions/builtin";
import { ActionExecutor, ActionHandlerRegistry } from "@/lib/actions/executor";
import { createActionPlan } from "@/lib/actions/planner";
import { createAction, type Action } from "@/lib/actions/types";
import { createDigest } from "@/lib/digest/types";
import { createMemory, type Memory } from "@/lib/memory/types";
import { createExecutionPlan } from "@/lib/tools/plan";

const NOW = "2026-08-10T12:00:00.000Z";

function deps(overrides: Partial<BuiltinActionDependencies> = {}): BuiltinActionDependencies {
  return {
    searchGmail: async () => ({ messages: [{ id: "m1", subject: "Hi" }] }),
    searchCalendar: async () => ({ events: [{ id: "e1", summary: "Standup" }] }),
    searchDrive: async () => ({ files: [{ id: "f1", name: "doc.pdf" }] }),
    searchGitHub: async () => ({ repositories: [{ id: 1, fullName: "a/b" }] }),
    storeMemory: (input) =>
      createMemory({ id: "mem-stored", title: input.title, content: input.content, createdAt: input.createdAt }),
    appendConversationMessage: (conversationId, input) => ({
      id: "msg-1",
      conversationId,
      ...input,
    }),
    buildDigest: async (template, options) =>
      createDigest({
        kind: template.kind,
        title: template.title,
        priority: template.priority,
        createdAt: options.now ?? NOW,
        window: { from: NOW, to: NOW },
      }),
    runJob: async () => ({
      executed: [],
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    }),
    executeTools: async (plan) => ({
      planId: plan.id,
      results: [],
      succeededStepIds: [],
      failedStepIds: [],
      cancelledStepIds: [],
    }),
    ...overrides,
  };
}

function action(type: Action["type"], input?: Record<string, unknown>): Action {
  return createAction({ id: `action-${type}`, name: type, type, createdAt: NOW, input });
}

function executorFor(dependencies: BuiltinActionDependencies = deps()): ActionExecutor {
  return new ActionExecutor(
    new ActionHandlerRegistry(createBuiltInActionHandlers(dependencies)),
    { now: () => NOW },
  );
}

describe("createBuiltInActionHandlers", () => {
  it("registers exactly the nine built-in types", () => {
    const handlers = createBuiltInActionHandlers(deps());
    expect(handlers.map((entry) => entry.type).sort()).toEqual([
      "create_memory",
      "execute_tool_plan",
      "generate_digest",
      "run_job",
      "search_calendar",
      "search_drive",
      "search_github",
      "search_gmail",
      "update_conversation",
    ]);
  });
});

describe("search actions", () => {
  it("search_gmail delegates to the Gmail read tool with the parsed input", async () => {
    const searchGmail = vi.fn(async (input: { query: string; maxResults?: number }) => ({
      messages: [{ id: "m1", subject: input.query }],
    }));
    const executor = executorFor(deps({ searchGmail }));
    const result = await executor.execute(
      action("search_gmail", { query: "project", maxResults: 5 }),
    );
    expect(searchGmail).toHaveBeenCalledWith({ query: "project", maxResults: 5 });
    expect(result.status).toBe("completed");
    expect((result.output as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("search_calendar, search_drive, search_github delegate to their tools", async () => {
    const searchCalendar = vi.fn(async () => ({ events: [] }));
    const searchDrive = vi.fn(async () => ({ files: [] }));
    const searchGitHub = vi.fn(async () => ({ repositories: [] }));
    const executor = executorFor(deps({ searchCalendar, searchDrive, searchGitHub }));
    expect((await executor.execute(action("search_calendar", { query: "q" }))).status).toBe("completed");
    expect((await executor.execute(action("search_drive", { query: "q" }))).status).toBe("completed");
    expect((await executor.execute(action("search_github", { query: "q" }))).status).toBe("completed");
    expect(searchCalendar).toHaveBeenCalled();
    expect(searchDrive).toHaveBeenCalled();
    expect(searchGitHub).toHaveBeenCalled();
  });

  it("fails structurally on invalid input (never throws)", async () => {
    const executor = executorFor();
    const result = await executor.execute(action("search_gmail", { query: "" }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("handler_error");
  });
});

describe("create_memory", () => {
  it("stores a memory through the Memory Engine with the injected time", async () => {
    const storeMemory = vi.fn((input) =>
      createMemory({ id: "mem-x", title: input.title, content: input.content, createdAt: input.createdAt }),
    );
    const executor = executorFor(deps({ storeMemory }));
    const result = await executor.execute(
      action("create_memory", { title: "T", content: "remember this", kind: "task" }),
    );
    expect(result.status).toBe("completed");
    const memory = result.output as Memory;
    expect(memory.metadata.title).toBe("T");
    expect(memory.content).toBe("remember this");
    expect(storeMemory).toHaveBeenCalledWith(
      expect.objectContaining({ title: "T", content: "remember this", createdAt: NOW, kind: "task", source: "tool" }),
    );
  });

  it("defaults the title to a content preview", async () => {
    const storeMemory = vi.fn((input) =>
      createMemory({ id: "mem-x", title: input.title, content: input.content, createdAt: input.createdAt }),
    );
    const executor = executorFor(deps({ storeMemory }));
    const content = "this is a very long content value that should be truncated to forty characters exactly";
    await executor.execute(action("create_memory", { content }));
    expect(storeMemory).toHaveBeenCalledWith(expect.objectContaining({ title: "this is a very long content value that …" }));
  });
});

describe("update_conversation", () => {
  it("appends a system message to the conversation", async () => {
    const appendConversationMessage = vi.fn((conversationId, input) => ({
      id: "msg-9",
      conversationId,
      ...input,
    }));
    const executor = executorFor(deps({ appendConversationMessage }));
    const result = await executor.execute(
      action("update_conversation", { conversationId: "conv-1", content: "Done." }),
    );
    expect(result.status).toBe("completed");
    expect(appendConversationMessage).toHaveBeenCalledWith("conv-1", {
      role: "system",
      content: "Done.",
      createdAt: NOW,
    });
  });

  it("honors an explicit role", async () => {
    const appendConversationMessage = vi.fn((conversationId, input) => ({
      id: "msg-9",
      conversationId,
      ...input,
    }));
    const executor = executorFor(deps({ appendConversationMessage }));
    await executor.execute(
      action("update_conversation", { conversationId: "conv-1", content: "Note", role: "tool" }),
    );
    expect(appendConversationMessage).toHaveBeenCalledWith("conv-1", {
      role: "tool",
      content: "Note",
      createdAt: NOW,
    });
  });
});

describe("generate_digest", () => {
  it("builds a morning digest by default", async () => {
    const buildDigest = vi.fn(async (template, options) =>
      createDigest({
        kind: template.kind,
        title: template.title,
        priority: template.priority,
        createdAt: options.now ?? NOW,
        window: { from: NOW, to: NOW },
      }),
    );
    const executor = executorFor(deps({ buildDigest }));
    const result = await executor.execute(action("generate_digest", {}), { userId: "u" });
    expect(result.status).toBe("completed");
    expect(buildDigest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "morning" }),
      expect.objectContaining({ userId: "u", now: NOW }),
    );
  });

  it("builds a weekly digest when requested with a query", async () => {
    const buildDigest = vi.fn(async (template, options) =>
      createDigest({
        kind: template.kind,
        title: template.title,
        priority: template.priority,
        createdAt: options.now ?? NOW,
        window: { from: NOW, to: NOW },
      }),
    );
    const executor = executorFor(deps({ buildDigest }));
    await executor.execute(action("generate_digest", { kind: "weekly", query: "week review" }));
    expect(buildDigest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "weekly" }),
      expect.objectContaining({ query: "week review" }),
    );
  });
});

describe("run_job", () => {
  it("runs a job manually through the Job Engine", async () => {
    const runJob = vi.fn(async () => ({
      executed: [{ reference: { jobId: "job-1" }, status: "completed", attempt: 1 }],
      total: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
    }));
    const executor = executorFor(deps({ runJob }));
    const result = await executor.execute(action("run_job", { jobId: "job-1" }));
    expect(result.status).toBe("completed");
    expect(runJob).toHaveBeenCalledWith("job-1", NOW, undefined);
    expect((result.output as { completed: number }).completed).toBe(1);
  });
});

describe("execute_tool_plan", () => {
  it("executes a tool plan through the Tool Executor", async () => {
    const executeTools = vi.fn(async (plan) => ({
      planId: plan.id,
      results: [
        { stepId: "s1", toolId: "search.gmail", status: "success", output: {}, durationMs: 0 },
      ],
      succeededStepIds: ["s1"],
      failedStepIds: [],
      cancelledStepIds: [],
    }));
    const executor = executorFor(deps({ executeTools }));
    const plan = createExecutionPlan({
      id: "tool-plan-1",
      steps: [{ stepId: "s1", toolId: "search.gmail", input: { query: "q" }, dependsOn: [] }],
    });
    const result = await executor.execute(action("execute_tool_plan", { plan }));
    expect(result.status).toBe("completed");
    expect(executeTools).toHaveBeenCalledWith(expect.objectContaining({ id: "tool-plan-1" }), undefined);
  });

  it("fails structurally when the plan input is malformed", async () => {
    const executor = executorFor();
    // A step missing `toolId` fails the Zod schema → failed action (no throw).
    const result = await executor.execute(
      action("execute_tool_plan", {
        plan: { id: "x", steps: [{ stepId: "s", input: { query: "q" }, dependsOn: [] }] },
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("handler_error");
  });
});

describe("built-in handlers in a plan", () => {
  it("execute together through executePlan", async () => {
    const executor = executorFor();
    const plan = createActionPlan({
      intent: "email + memory",
      userId: "u",
      now: NOW,
      actions: [
        action("search_gmail", { query: "project" }),
        action("create_memory", { content: "remember" }),
      ],
    });
    const result = await executor.executePlan(plan);
    expect(result.completedActionIds).toHaveLength(2);
  });

  it("isolate a failing handler inside a plan", async () => {
    const executor = executorFor(
      deps({
        searchGmail: async () => {
          throw new Error("gmail down");
        },
      }),
    );
    const plan = createActionPlan({
      intent: "x",
      userId: "u",
      now: NOW,
      actions: [action("search_gmail", { query: "q" }), action("search_calendar", { query: "q" })],
    });
    const result = await executor.executePlan(plan);
    expect(result.failedActionIds).toHaveLength(1);
    expect(result.completedActionIds).toHaveLength(1);
  });
});
