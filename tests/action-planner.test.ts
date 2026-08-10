import { describe, expect, it } from "vitest";
import {
  ACTION_KEYWORDS,
  ACTION_TYPE_ORDER,
  ActionPlanner,
  createActionPlan,
  defaultNameFor,
  detectIntentRequests,
  type ActionPlan,
} from "@/lib/actions/planner";
import { createJob } from "@/lib/jobs/types";
import { createConversation } from "@/lib/conversation/types";
import { createMemory } from "@/lib/memory/types";
import { createAction } from "@/lib/actions/types";

const NOW = "2026-08-10T12:00:00.000Z";

describe("detectIntentRequests", () => {
  it("detects search types from keywords", () => {
    const requests = detectIntentRequests("check my email and calendar for the project meeting");
    expect(requests.map((request) => request.type)).toEqual(["search_gmail", "search_calendar"]);
  });

  it("detects memory, digest, job, conversation, and tool-plan intents", () => {
    expect(detectIntentRequests("remember this fact").map((r) => r.type)).toEqual([
      "create_memory",
    ]);
    expect(detectIntentRequests("give me a daily brief").map((r) => r.type)).toEqual([
      "generate_digest",
    ]);
    expect(detectIntentRequests("run my background task").map((r) => r.type)).toEqual([
      "run_job",
    ]);
    expect(detectIntentRequests("update my conversation").map((r) => r.type)).toEqual([
      "update_conversation",
    ]);
    expect(detectIntentRequests("execute the workflow plan").map((r) => r.type)).toEqual([
      "execute_tool_plan",
    ]);
  });

  it("returns a single request per type (deduplicated)", () => {
    const requests = detectIntentRequests("email and gmail and inbox");
    expect(requests.filter((r) => r.type === "search_gmail")).toHaveLength(1);
  });

  it("returns an empty list for unmatched text", () => {
    expect(detectIntentRequests("hello world")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(detectIntentRequests("Check My EMAIL")).toEqual([{ type: "search_gmail" }]);
  });

  it("every keyword maps to a known action type", () => {
    for (const type of Object.keys(ACTION_KEYWORDS)) {
      expect(ACTION_TYPE_ORDER).toContain(type);
    }
  });
});

describe("ActionPlanner.plan", () => {
  it("plans explicit requests with enriched inputs", () => {
    const planner = new ActionPlanner();
    const plan = planner.plan({
      text: "search the project",
      userId: "user-1",
      now: NOW,
      requests: [{ type: "search_gmail" }],
    });
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action.type).toBe("search_gmail");
    expect(action.trigger).toBe("intent");
    expect(action.input).toEqual({ query: "search the project" });
    expect(action.priority).toBe("normal");
  });

  it("derives requests from keywords when none are given", () => {
    const planner = new ActionPlanner();
    const plan = planner.plan({
      text: "search my email and calendar",
      userId: "u",
      now: NOW,
    });
    expect(plan.actions.map((a) => a.type)).toEqual(["search_gmail", "search_calendar"]);
  });

  it("keeps an explicit maxResults", () => {
    const plan = new ActionPlanner().plan({
      text: "search",
      userId: "u",
      now: NOW,
      requests: [{ type: "search_gmail", input: { query: "q", maxResults: 5 } }],
    });
    expect(plan.actions[0].input).toEqual({ query: "q", maxResults: 5 });
  });

  it("defaults create_memory title/content from the intent text", () => {
    const plan = new ActionPlanner().plan({
      text: "remember that the deploy is at noon",
      userId: "u",
      now: NOW,
    });
    const action = plan.actions.find((a) => a.type === "create_memory") as NonNullable<
      typeof plan.actions[number]
    >;
    expect(action.input).toMatchObject({ content: "remember that the deploy is at noon" });
    expect(typeof (action.input as Record<string, unknown>).title).toBe("string");
  });

  it("resolves update_conversation to the most recent conversation from sources", () => {
    const conversations = [
      createConversation({ id: "conv-1", createdAt: NOW, title: "Old" }),
      createConversation({ id: "conv-2", createdAt: NOW, title: "New" }),
    ];
    const planner = new ActionPlanner({ listConversations: () => conversations });
    const plan = planner.plan({
      text: "update my conversation",
      userId: "u",
      now: NOW,
    });
    const action = plan.actions.find((a) => a.type === "update_conversation");
    expect(action?.input).toMatchObject({ conversationId: "conv-2" });
  });

  it("drops update_conversation when no conversation exists", () => {
    const planner = new ActionPlanner({ listConversations: () => [] });
    const plan = planner.plan({ text: "update my conversation", userId: "u", now: NOW });
    expect(plan.actions.find((a) => a.type === "update_conversation")).toBeUndefined();
  });

  it("resolves run_job to the first pending job from sources", () => {
    const jobs = [
      createJob({ id: "job-1", name: "J1", status: "completed", createdAt: NOW }),
      createJob({ id: "job-2", name: "J2", status: "pending", createdAt: NOW }),
    ];
    const planner = new ActionPlanner({ listJobs: () => jobs });
    const plan = planner.plan({ text: "run the job", userId: "u", now: NOW });
    expect(plan.actions.find((a) => a.type === "run_job")?.input).toEqual({ jobId: "job-2" });
  });

  it("drops run_job when no pending job exists", () => {
    const planner = new ActionPlanner({ listJobs: () => [] });
    const plan = planner.plan({ text: "run the job", userId: "u", now: NOW });
    expect(plan.actions.find((a) => a.type === "run_job")).toBeUndefined();
  });

  it("plans a generate_digest action with a query and kind", () => {
    const plan = new ActionPlanner().plan({
      text: "summarize my day",
      userId: "u",
      now: NOW,
      requests: [{ type: "generate_digest" }],
    });
    expect(plan.actions[0].type).toBe("generate_digest");
    expect(plan.actions[0].priority).toBe("high");
    expect(plan.actions[0].input).toEqual({ query: "summarize my day", kind: "morning" });
  });

  it("links the plan to the intent conversation", () => {
    const plan = new ActionPlanner().plan({
      text: "check email",
      userId: "u",
      now: NOW,
      conversationId: "conv-9",
    });
    expect(plan.conversationId).toBe("conv-9");
    expect(plan.actions[0].conversationId).toBe("conv-9");
  });
});

describe("ActionPlanner ordering", () => {
  it("orders by priority (critical first), then type order", () => {
    const planner = new ActionPlanner({
      listConversations: () => [createConversation({ id: "conv-1", createdAt: NOW })],
      listJobs: () => [
        createJob({ id: "job-1", name: "J", status: "pending", createdAt: NOW }),
      ],
    });
    const plan = planner.plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [
        { type: "search_gmail" },
        { type: "generate_digest" }, // high
        { type: "run_job" }, // high
        { type: "update_conversation" }, // low
        { type: "search_calendar" },
      ],
    });
    const order = plan.actions.map((a) => a.type);
    expect(order).toEqual([
      "generate_digest",
      "run_job",
      "search_gmail",
      "search_calendar",
      "update_conversation",
    ]);
  });

  it("is deterministic across repeated planning", () => {
    const planner = new ActionPlanner();
    const planA = planner.plan({ text: "email and calendar digest", userId: "u", now: NOW });
    const planB = planner.plan({ text: "email and calendar digest", userId: "u", now: NOW });
    expect(planA).toEqual(planB);
    expect(planA.actions.map((a) => a.id)).toEqual(planB.actions.map((a) => a.id));
  });
});

describe("ActionPlanner dependencies", () => {
  it("update_conversation depends on every other planned action", () => {
    const planner = new ActionPlanner({
      listConversations: () => [createConversation({ id: "conv-1", createdAt: NOW })],
    });
    const plan = planner.plan({
      text: "check my email and update my conversation",
      userId: "u",
      now: NOW,
    });
    const conversation = plan.actions.find((a) => a.type === "update_conversation") as NonNullable<
      typeof plan.actions[number]
    >;
    expect(conversation.dependsOn).toContain(
      plan.actions.find((a) => a.type === "search_gmail")?.id,
    );
  });

  it("resolves explicit dependsOn type references to action ids", () => {
    const planner = new ActionPlanner();
    const plan = planner.plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [
        { type: "create_memory" },
        { type: "search_gmail", dependsOn: ["create_memory"] },
      ],
    });
    const memoryId = plan.actions.find((a) => a.type === "create_memory")?.id;
    const search = plan.actions.find((a) => a.type === "search_gmail");
    expect(search?.dependsOn).toEqual([memoryId]);
  });

  it("ignores self- and unknown dependency references", () => {
    const planner = new ActionPlanner();
    const plan = planner.plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [{ type: "search_gmail", dependsOn: ["search_gmail", "does_not_exist"] }],
    });
    expect(plan.actions[0].dependsOn).toEqual([]);
  });
});

describe("createActionPlan validation", () => {
  const actions = (): readonly ReturnType<typeof createAction>[] => [
    createAction({ id: "a", name: "A", type: "search_gmail", createdAt: NOW }),
    createAction({ id: "b", name: "B", type: "search_calendar", createdAt: NOW, dependsOn: ["a"] }),
  ];

  it("builds and deep-freezes a valid plan", () => {
    const plan = createActionPlan({ intent: "x", userId: "u", now: NOW, actions: actions() });
    expect(plan.id).toMatch(/^plan-[0-9a-f]{8}$/);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.actions)).toBe(true);
    expect(Object.isFrozen(plan.actions[0])).toBe(true);
    expect(plan.summary).toContain("2 action(s)");
  });

  it("throws on unknown dependency references", () => {
    const bad = [
      createAction({ id: "a", name: "A", type: "search_gmail", createdAt: NOW }),
      createAction({ id: "b", name: "B", type: "search_calendar", createdAt: NOW, dependsOn: ["ghost"] }),
    ];
    expect(() => createActionPlan({ intent: "x", userId: "u", now: NOW, actions: bad })).toThrow(
      /unknown action/,
    );
  });

  it("throws on dependency cycles", () => {
    const cyclic = [
      createAction({ id: "a", name: "A", type: "search_gmail", createdAt: NOW, dependsOn: ["b"] }),
      createAction({ id: "b", name: "B", type: "search_calendar", createdAt: NOW, dependsOn: ["a"] }),
    ];
    expect(() => createActionPlan({ intent: "x", userId: "u", now: NOW, actions: cyclic })).toThrow(
      /cycle/,
    );
  });

  it("throws on self-dependencies", () => {
    const selfDep = [
      createAction({ id: "a", name: "A", type: "search_gmail", createdAt: NOW, dependsOn: ["a"] }),
    ];
    expect(() => createActionPlan({ intent: "x", userId: "u", now: NOW, actions: selfDep })).toThrow(
      /depends on itself/,
    );
  });

  it("derives a deterministic plan id", () => {
    const planA = createActionPlan({ intent: "x", userId: "u", now: NOW, actions: actions() });
    const planB = createActionPlan({ intent: "x", userId: "u", now: NOW, actions: actions() });
    expect(planA.id).toBe(planB.id);
  });
});

describe("defaultNameFor", () => {
  it("humanizes action type names", () => {
    expect(defaultNameFor("search_gmail")).toBe("Search gmail");
    expect(defaultNameFor("generate_digest")).toBe("Generate digest");
  });
});

describe("ActionPlanner data-source consumption", () => {
  it("drops create_memory when a memory with the same content already exists", () => {
    const planner = new ActionPlanner({
      listMemories: () => [
        createMemory({ id: "mem-1", title: "T", content: "remember this exact fact", createdAt: NOW }),
      ],
    });
    const plan = planner.plan({
      text: "remember this exact fact",
      userId: "u",
      now: NOW,
      requests: [{ type: "create_memory", input: { content: "remember this exact fact" } }],
    });
    expect(plan.actions.find((a) => a.type === "create_memory")).toBeUndefined();
  });

  it("keeps create_memory when the content is new", () => {
    const planner = new ActionPlanner({
      listMemories: () => [createMemory({ id: "mem-1", title: "T", content: "old", createdAt: NOW })],
    });
    const plan = planner.plan({
      text: "remember something brand new",
      userId: "u",
      now: NOW,
    });
    expect(plan.actions.find((a) => a.type === "create_memory")).toBeDefined();
  });

  it("drops generate_digest when a digest of the same kind at the same time exists", () => {
    const planner = new ActionPlanner({
      listDigests: () => [
        {
          id: "digest-1",
          metadata: { kind: "morning", createdAt: NOW, updatedAt: NOW, status: "draft", read: false, priority: "high", tags: [], window: { from: NOW, to: NOW } },
          sections: [],
          statistics: { sectionCount: 0, itemCount: 0, totalTokens: 0, sourceCount: 0, categories: {} },
        },
      ],
    });
    const plan = planner.plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [{ type: "generate_digest" }],
    });
    expect(plan.actions.find((a) => a.type === "generate_digest")).toBeUndefined();
  });

  it("drops generate_digest when an evening digest at the same time exists", () => {
    const planner = new ActionPlanner({
      listDigests: () => [
        {
          id: "digest-1",
          metadata: { kind: "evening", createdAt: NOW, updatedAt: NOW, status: "draft", read: false, priority: "high", tags: [], window: { from: NOW, to: NOW } },
          sections: [],
          statistics: { sectionCount: 0, itemCount: 0, totalTokens: 0, sourceCount: 0, categories: {} },
        },
      ],
    });
    const plan = planner.plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [{ type: "generate_digest", input: { kind: "evening" } }],
    });
    expect(plan.actions.find((a) => a.type === "generate_digest")).toBeUndefined();
  });

  it("keeps generate_digest for a different kind", () => {
    const planner = new ActionPlanner({
      listDigests: () => [
        {
          id: "digest-1",
          metadata: { kind: "morning", createdAt: NOW, updatedAt: NOW, status: "draft", read: false, priority: "high", tags: [], window: { from: NOW, to: NOW } },
          sections: [],
          statistics: { sectionCount: 0, itemCount: 0, totalTokens: 0, sourceCount: 0, categories: {} },
        },
      ],
    });
    const plan = planner.plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [{ type: "generate_digest", input: { kind: "weekly" } }],
    });
    expect(plan.actions.find((a) => a.type === "generate_digest")?.input).toMatchObject({ kind: "weekly" });
  });

  it("survives throwing data sources (failure isolation)", () => {
    const planner = new ActionPlanner({
      listMemories: () => {
        throw new Error("down");
      },
      listDigests: () => {
        throw new Error("down");
      },
    });
    const plan = planner.plan({
      text: "remember a fresh fact and give me a digest",
      userId: "u",
      now: NOW,
    });
    expect(plan.actions.some((a) => a.type === "create_memory")).toBe(true);
    expect(plan.actions.some((a) => a.type === "generate_digest")).toBe(true);
  });
});

describe("ActionPlanner robustness", () => {
  it("never throws for empty intents (plan with no actions)", () => {
    const plan = new ActionPlanner().plan({ text: "", userId: "u", now: NOW });
    expect(plan.actions).toEqual([]);
    expect(plan.summary).toBe("0 action(s): ");
  });

  it("degrades gracefully when a source throws", () => {
    const planner = new ActionPlanner({
      listConversations: () => {
        throw new Error("down");
      },
      listJobs: () => {
        throw new Error("down");
      },
    });
    const plan = planner.plan({ text: "update my conversation and run the job", userId: "u", now: NOW });
    expect(plan.actions).toEqual([]);
  });

  it("builds an execute_tool_plan action over matched search types", () => {
    const plan = new ActionPlanner().plan({
      text: "execute the tool plan for email",
      userId: "u",
      now: NOW,
      requests: [{ type: "execute_tool_plan" }],
    });
    const action = plan.actions[0];
    expect(action.type).toBe("execute_tool_plan");
    const input = action.input as { plan: { steps: readonly unknown[] } };
    expect(input.plan.steps[0]).toMatchObject({ toolId: "search.gmail" });
  });

  it("drops execute_tool_plan when no search types are matched", () => {
    const planner = new ActionPlanner();
    const plan = planner.plan({
      text: "hello",
      userId: "u",
      now: NOW,
      requests: [{ type: "execute_tool_plan" }],
    });
    expect(plan.actions.find((a) => a.type === "execute_tool_plan")).toBeUndefined();
  });

  it("keeps custom-type requests with their raw input", () => {
    const plan = new ActionPlanner().plan({
      text: "x",
      userId: "u",
      now: NOW,
      requests: [{ type: "custom", input: { myField: 1 } }],
    });
    expect(plan.actions[0].type).toBe("custom");
    expect(plan.actions[0].input).toEqual({ myField: 1 });
  });
});

describe("ActionPlan shape", () => {
  it("carries intent, userId, now, conversationId, actions, summary", () => {
    const plan: ActionPlan = new ActionPlanner().plan({
      text: "check email",
      userId: "u",
      now: NOW,
      conversationId: "c",
    });
    expect(plan.intent).toBe("check email");
    expect(plan.userId).toBe("u");
    expect(plan.now).toBe(NOW);
    expect(plan.actions.length).toBeGreaterThan(0);
  });

  it("planner ignores unused source surfaces", () => {
    const plan = new ActionPlanner({
      listMemories: () => [createMemory({ id: "m", title: "t", content: "c", createdAt: NOW })],
      listDigests: () => [],
    }).plan({ text: "check email", userId: "u", now: NOW });
    expect(plan.actions.length).toBe(1);
  });
});
