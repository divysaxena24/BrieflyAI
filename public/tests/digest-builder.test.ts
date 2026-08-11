import { describe, expect, it } from "vitest";
import {
  DigestBuilder,
  gatherDigestContext,
  createDigestToolPlan,
  defaultQueryFor,
  templateWindowFor,
  DIGEST_GMAIL_TOOL_ID,
  type DigestDataSources,
} from "@/lib/digest/builder";
import { createDigestTemplate, type DigestTemplate } from "@/lib/digest/types";
import { createMemory } from "@/lib/memory/types";
import { createConversation, createMessage } from "@/lib/conversation/types";
import { createJob } from "@/lib/jobs/types";
import type { ExecutionPlan, ExecutionStep } from "@/lib/tools/plan";

const NOW = "2026-08-10T12:00:00.000Z";

/** A template covering every content category. */
const TEMPLATE: DigestTemplate = createDigestTemplate({
  id: "template-test",
  kind: "custom",
  title: "Test Digest",
  windowDays: 1,
  sections: [
    { category: "calendar", title: "Meetings", priority: "high", maxItems: 3 },
    { category: "emails", title: "Emails", priority: "high", maxItems: 3 },
    { category: "github", title: "GitHub", priority: "normal", maxItems: 3 },
    { category: "memories", title: "Memories", priority: "normal", maxItems: 3 },
    { category: "conversation", title: "Conversation", priority: "normal", maxItems: 1 },
    { category: "actions", title: "Actions", priority: "high", maxItems: 3 },
    { category: "files", title: "Files", priority: "normal", maxItems: 3 },
  ],
});

/** A fully controllable fake of the data sources. */
function fakeSources(overrides: Partial<DigestDataSources> = {}): DigestDataSources {
  return {
    listMemories: () => [],
    listConversations: () => [],
    buildContextPrompt: async () => "assembled context prompt",
    listJobs: () => [],
    executeTools: async (plan) => ({
      planId: plan.id,
      results: plan.steps.map((step) => ({
        stepId: step.stepId,
        toolId: step.toolId,
        status: "success",
        output: {},
        durationMs: 0,
      })),
      succeededStepIds: plan.steps.map((step) => step.stepId),
      failedStepIds: [],
      cancelledStepIds: [],
    }),
    ...overrides,
  };
}

function message(overrides: Partial<Parameters<typeof createMessage>[0]> = {}) {
  return createMessage({ role: "user", content: "hello", createdAt: NOW, ...overrides });
}

function conversation(overrides: Partial<Parameters<typeof createConversation>[0]> = {}) {
  return createConversation({
    id: "conv-1",
    createdAt: NOW,
    title: "Planning",
    messages: [message()],
    ...overrides,
  });
}

function memory(overrides: Partial<Parameters<typeof createMemory>[0]> = {}) {
  return createMemory({
    id: "mem-1",
    title: "Preference",
    content: "Prefers concise replies",
    createdAt: NOW,
    ...overrides,
  });
}

function job(overrides: Partial<Parameters<typeof createJob>[0]> = {}) {
  return createJob({
    id: "job-1",
    name: "Daily Digest",
    createdAt: NOW,
    ...overrides,
  });
}

function emailStepResult(stepId: string, messages: unknown[]): unknown {
  return {
    stepId,
    toolId: DIGEST_GMAIL_TOOL_ID,
    status: "success",
    output: { messages },
    durationMs: 0,
  };
}

describe("createDigestToolPlan", () => {
  it("builds one independent step per source in fixed order", () => {
    const plan = createDigestToolPlan("digest query", 10);
    expect(plan.steps.map((step) => step.toolId)).toEqual([
      "search.gmail",
      "search.calendar",
      "search.github",
      "search.drive",
    ]);
    for (const step of plan.steps) {
      expect(step.dependsOn).toEqual([]);
    }
    expect(plan.id).toMatch(/^digest-tools-[0-9a-f]{8}$/);
  });

  it("derives a deterministic plan id from the query", () => {
    expect(createDigestToolPlan("q", 5).id).toBe(createDigestToolPlan("q", 5).id);
    expect(createDigestToolPlan("q", 5).id).not.toBe(createDigestToolPlan("other", 5).id);
  });

  it("forwards maxResults to every step", () => {
    const plan = createDigestToolPlan("q", 7);
    for (const step of plan.steps) {
      expect((step.input as { maxResults?: number }).maxResults).toBe(7);
    }
  });
});

describe("defaultQueryFor and templateWindowFor", () => {
  it("defaults the query per template kind", () => {
    expect(defaultQueryFor("morning")).toBe("morning digest");
    expect(defaultQueryFor("evening")).toBe("evening digest");
    expect(defaultQueryFor("weekly")).toBe("weekly digest");
    expect(defaultQueryFor("custom")).toBe("daily digest");
  });

  it("derives a day window from the start of the day to now", () => {
    const window = templateWindowFor(TEMPLATE, NOW);
    expect(window).toEqual({
      from: "2026-08-10T00:00:00.000Z",
      to: NOW,
    });
  });

  it("derives a 7-day window for weekly templates", () => {
    const weekly = createDigestTemplate({
      id: "template-weekly",
      kind: "weekly",
      title: "Weekly",
      windowDays: 7,
      sections: [{ category: "emails", title: "Emails", priority: "normal" }],
    });
    const window = templateWindowFor(weekly, NOW);
    expect(window.from).toBe("2026-08-03T12:00:00.000Z");
    expect(window.to).toBe(NOW);
  });
});

describe("gatherDigestContext", () => {
  it("gathers, maps, and deduplicates items from every source", async () => {
    const context = await gatherDigestContext(
      fakeSources({
        listMemories: () => [memory()],
        listJobs: () => [job()],
        listConversations: () => [conversation()],
        executeTools: async (plan) => ({
          planId: plan.id,
          results: [
            emailStepResult("emails", [{ id: "msg-1", subject: "Hello", snippet: "Hi" }]),
          ] as unknown[],
          succeededStepIds: ["emails"],
          failedStepIds: [],
          cancelledStepIds: [],
        }),
      }),
      { userId: "user-1", now: NOW, window: { from: NOW, to: NOW }, query: "q" },
    );
    expect(context.userId).toBe("user-1");
    expect(context.contextPrompt).toBe("assembled context prompt");
    expect(context.conversationSummary.length).toBeGreaterThan(0);
    const categories = new Set(context.items.map((item) => item.category));
    expect(categories.has("emails")).toBe(true);
    expect(categories.has("memories")).toBe(true);
    expect(categories.has("actions")).toBe(true);
    expect(categories.has("conversation")).toBe(true);
  });

  it("deduplicates items by id (first occurrence wins)", async () => {
    const sources = fakeSources({
      executeTools: async (plan) => ({
        planId: plan.id,
        results: [
          emailStepResult("emails", [
            { id: "msg-1", subject: "S", snippet: "Sn" },
            { id: "msg-2", subject: "T", snippet: "Tw" },
          ]),
        ] as unknown[],
        succeededStepIds: ["emails"],
        failedStepIds: [],
        cancelledStepIds: [],
      }),
    });
    // Inject the duplicate manually through memory (same id derivation path is
    // separate; simulate by overriding listMemories with a colliding item).
    const sources2: DigestDataSources = {
      ...sources,
      listMemories: () => [
        createMemory({
          id: "mem-1",
          title: "First",
          content: "First memory",
          createdAt: NOW,
        }),
        createMemory({
          id: "mem-1",
          title: "First",
          content: "First memory",
          createdAt: NOW,
        }),
      ],
    };
    const context = await gatherDigestContext(sources2, {
      userId: "u",
      now: NOW,
      window: { from: NOW, to: NOW },
      query: "q",
    });
    const memoryItems = context.items.filter((item) => item.source === "memory");
    expect(memoryItems).toHaveLength(1);
    expect(memoryItems[0].title).toBe("First");
  });

  it("ranks memories with the shared ranker", async () => {
    const context = await gatherDigestContext(
      fakeSources({
        listMemories: () => [
          memory({ id: "mem-a", title: "Alpha", content: "Project plan details" }),
          memory({ id: "mem-b", title: "Beta", content: "Unrelated note" }),
        ],
      }),
      { userId: "u", now: NOW, window: { from: NOW, to: NOW }, query: "project" },
    );
    const ranked = context.items.filter((item) => item.source === "memory");
    expect(ranked).toHaveLength(2);
    expect(ranked[0].title).toBe("Alpha");
  });

  it("summarizes only the most recent conversation", async () => {
    const older = createConversation({
      id: "conv-old",
      createdAt: "2026-08-09T00:00:00.000Z",
      messages: [message({ createdAt: "2026-08-09T00:00:00.000Z" })],
    });
    const context = await gatherDigestContext(
      fakeSources({
        listConversations: () => [older, conversation()],
      }),
      { userId: "u", now: NOW, window: { from: NOW, to: NOW }, query: "q" },
    );
    const item = context.items.find((i) => i.source === "conversation");
    expect(item?.content).toContain("hello");
  });

  it("contributes no conversation item when there are no conversations", async () => {
    const context = await gatherDigestContext(fakeSources(), {
      userId: "u",
      now: NOW,
      window: { from: NOW, to: NOW },
      query: "q",
    });
    expect(context.conversationSummary).toBe("");
    expect(context.items.find((i) => i.source === "conversation")).toBeUndefined();
  });

  it("counts only pending non-archived jobs as actions", async () => {
    const context = await gatherDigestContext(
      fakeSources({
        listJobs: () => [
          job({ id: "job-pending", name: "Pending job" }),
          job({ id: "job-archived", name: "Archived job", archived: true }),
          job({ id: "job-completed", name: "Completed job", status: "completed" }),
        ],
      }),
      { userId: "u", now: NOW, window: { from: NOW, to: NOW }, query: "q" },
    );
    const actionItems = context.items.filter((item) => item.category === "actions");
    expect(actionItems.map((item) => item.title)).toEqual(["Pending job"]);
  });

  it("isolates throwing sources (failure isolation)", async () => {
    const context = await gatherDigestContext(
      fakeSources({
        listMemories: () => {
          throw new Error("memory source down");
        },
        listConversations: () => {
          throw new Error("conversation source down");
        },
        listJobs: () => {
          throw new Error("job source down");
        },
        buildContextPrompt: async () => {
          throw new Error("context source down");
        },
        executeTools: async () => {
          throw new Error("tool source down");
        },
      }),
      { userId: "u", now: NOW, window: { from: NOW, to: NOW }, query: "q" },
    );
    expect(context.contextPrompt).toBe("");
    expect(context.conversationSummary).toBe("");
    expect(context.items).toEqual([]);
  });

  it("skips failed tool steps and maps successful ones", async () => {
    const context = await gatherDigestContext(
      fakeSources({
        executeTools: async (plan) => ({
          planId: plan.id,
          results: [
            {
              stepId: "emails",
              toolId: DIGEST_GMAIL_TOOL_ID,
              status: "failure",
              error: { code: "timeout", message: "timed out" },
              durationMs: 100,
            },
            {
              stepId: "calendar",
              toolId: "search.calendar",
              status: "success",
              output: { events: [{ id: "ev-1", summary: "Standup" }] },
              durationMs: 0,
            },
          ] as unknown[],
          succeededStepIds: ["calendar"],
          failedStepIds: ["emails"],
          cancelledStepIds: [],
        }),
      }),
      { userId: "u", now: NOW, window: { from: NOW, to: NOW }, query: "q" },
    );
    const emailItems = context.items.filter((item) => item.source === "gmail");
    const calendarItems = context.items.filter((item) => item.source === "calendar");
    expect(emailItems).toEqual([]);
    expect(calendarItems).toHaveLength(1);
  });

  it("degrades gracefully when a successful tool output is malformed", async () => {
    const context = await gatherDigestContext(
      fakeSources({
        executeTools: async (plan) => ({
          planId: plan.id,
          results: [
            {
              stepId: "emails",
              toolId: DIGEST_GMAIL_TOOL_ID,
              status: "success",
              // Not an array: mapping must degrade to no items, not throw.
              output: { messages: "not-an-array" },
              durationMs: 0,
            },
            {
              stepId: "calendar",
              toolId: "search.calendar",
              status: "success",
              output: { events: [{ id: "ev-1", summary: "Standup" }] },
              durationMs: 0,
            },
          ] as unknown[],
          succeededStepIds: ["emails", "calendar"],
          failedStepIds: [],
          cancelledStepIds: [],
        }),
      }),
      { userId: "u", now: NOW, window: { from: NOW, to: NOW }, query: "q" },
    );
    const emailItems = context.items.filter((item) => item.source === "gmail");
    const calendarItems = context.items.filter((item) => item.source === "calendar");
    expect(emailItems).toEqual([]);
    expect(calendarItems).toHaveLength(1);
  });

  it("caps items gathered per source", async () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      id: `msg-${i}`,
      subject: `S${i}`,
      snippet: `Sn${i}`,
    }));
    const context = await gatherDigestContext(
      fakeSources({
        executeTools: async (plan) => ({
          planId: plan.id,
          results: [emailStepResult("emails", messages)] as unknown[],
          succeededStepIds: ["emails"],
          failedStepIds: [],
          cancelledStepIds: [],
        }),
      }),
      {
        userId: "u",
        now: NOW,
        window: { from: NOW, to: NOW },
        query: "q",
        maxItemsPerSource: 10,
      },
    );
    expect(context.items.filter((item) => item.source === "gmail")).toHaveLength(10);
  });

  it("maps GitHub and Drive outputs to items", async () => {
    const context = await gatherDigestContext(
      fakeSources({
        executeTools: async (plan) => ({
          planId: plan.id,
          results: [
            {
              stepId: "github",
              toolId: "search.github",
              status: "success",
              output: {
                repositories: [
                  {
                    id: 1,
                    name: "briefly",
                    fullName: "user/briefly",
                    description: "AI assistant",
                    updatedAt: "2026-08-09T00:00:00.000Z",
                  },
                ],
              },
              durationMs: 0,
            },
            {
              stepId: "files",
              toolId: "search.drive",
              status: "success",
              output: {
                files: [
                  {
                    id: "file-1",
                    name: "Roadmap",
                    mimeType: "application/pdf",
                    owners: [{ displayName: "User" }],
                    modifiedTime: "2026-08-10T00:00:00.000Z",
                    isFolder: false,
                  },
                ],
              },
              durationMs: 0,
            },
          ] as unknown[],
          succeededStepIds: ["github", "files"],
          failedStepIds: [],
          cancelledStepIds: [],
        }),
      }),
      { userId: "u", now: NOW, window: { from: NOW, to: NOW }, query: "q" },
    );
    const github = context.items.find((item) => item.source === "github");
    const files = context.items.find((item) => item.source === "drive");
    expect(github?.title).toBe("user/briefly");
    expect(github?.content).toBe("AI assistant");
    expect(files?.title).toBe("Roadmap");
    expect(files?.content).toContain("User");
  });
});

describe("DigestBuilder.build", () => {
  it("builds a complete deterministic digest with statistics", async () => {
    const builder = new DigestBuilder(
      fakeSources({
        listMemories: () => [memory()],
        listJobs: () => [job()],
        listConversations: () => [conversation()],
      }),
    );
    const built = await builder.build({ template: TEMPLATE, userId: "user-1", now: NOW });
    expect(built.metadata.kind).toBe("custom");
    expect(built.metadata.status).toBe("draft");
    expect(built.metadata.window).toEqual({ from: "2026-08-10T00:00:00.000Z", to: NOW });
    // Sections in template order; statistics last.
    const sectionCategories = built.sections.map((section) => section.category);
    expect(sectionCategories[sectionCategories.length - 1]).toBe("statistics");
    expect(sectionCategories.slice(0, -1)).toEqual(["memories", "conversation", "actions"]);
    // Statistics consistent with content.
    expect(built.statistics.itemCount).toBeGreaterThan(0);
    expect(built.statistics.sectionCount).toBe(built.sections.length);
  });

  it("is deterministic for identical inputs", async () => {
    const sources = fakeSources({
      listMemories: () => [memory(), memory({ id: "mem-2", title: "Second", content: "Two" })],
    });
    const a = await new DigestBuilder(sources).build({ template: TEMPLATE, userId: "u", now: NOW });
    const b = await new DigestBuilder(sources).build({ template: TEMPLATE, userId: "u", now: NOW });
    expect(a).toEqual(b);
  });

  it("emits sections in template order, skipping empty ones", async () => {
    const builder = new DigestBuilder(fakeSources());
    const built = await builder.build({ template: TEMPLATE, userId: "u", now: NOW });
    const categories = built.sections.map((section) => section.category);
    expect(categories).toEqual(["statistics"]); // only statistics when nothing gathered
  });

  it("emits each category at most once (no duplicate sections)", async () => {
    const builder = new DigestBuilder(
      fakeSources({
        listMemories: () => [
          memory({ id: "mem-1", title: "One", content: "A" }),
          memory({ id: "mem-2", title: "Two", content: "B" }),
        ],
      }),
    );
    const built = await builder.build({ template: TEMPLATE, userId: "u", now: NOW });
    const categories = built.sections.map((section) => section.category);
    expect(new Set(categories).size).toBe(categories.length);
  });

  it("never emits duplicate items within a section", async () => {
    const builder = new DigestBuilder(
      fakeSources({
        listMemories: () => [
          memory({ id: "mem-1", title: "One", content: "A" }),
          memory({ id: "mem-1", title: "One", content: "A" }),
        ],
      }),
    );
    const built = await builder.build({ template: TEMPLATE, userId: "u", now: NOW });
    const memorySection = built.sections.find((section) => section.category === "memories");
    expect(memorySection?.items).toHaveLength(1);
  });

  it("caps items per section via the template maxItems", async () => {
    const builder = new DigestBuilder(
      fakeSources({
        listMemories: () =>
          Array.from({ length: 20 }, (_, i) =>
            memory({ id: `mem-${i}`, title: `M${i}`, content: `C${i}` }),
          ),
      }),
    );
    const built = await builder.build({ template: TEMPLATE, userId: "u", now: NOW });
    const memorySection = built.sections.find((section) => section.category === "memories");
    expect(memorySection?.items.length).toBeLessThanOrEqual(3);
  });

  it("uses the per-kind default query when none is provided", async () => {
    let captured: string | undefined;
    const builder = new DigestBuilder(
      fakeSources({
        buildContextPrompt: async (query) => {
          captured = query;
          return "ctx";
        },
      }),
    );
    await builder.build({
      template: createDigestTemplate({
        id: "template-m",
        kind: "morning",
        title: "Morning",
        sections: [{ category: "emails", title: "Emails", priority: "normal" }],
      }),
      userId: "u",
      now: NOW,
    });
    expect(captured).toBe("morning digest");
  });

  it("builds from an explicit window when provided", async () => {
    const builder = new DigestBuilder(fakeSources());
    const built = await builder.build({
      template: TEMPLATE,
      userId: "u",
      now: NOW,
      window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-10T12:00:00.000Z" },
    });
    expect(built.metadata.window).toEqual({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-10T12:00:00.000Z",
    });
  });

  it("never mutates the injected sources (read-only contract)", async () => {
    const memories = [memory()];
    const conversations = [conversation()];
    const jobs = [job()];
    const builder = new DigestBuilder(
      fakeSources({
        listMemories: () => memories,
        listConversations: () => conversations,
        listJobs: () => jobs,
      }),
    );
    await builder.build({ template: TEMPLATE, userId: "u", now: NOW });
    expect(memories).toHaveLength(1);
    expect(conversations).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it("builds digest items with deterministic ids", async () => {
    const builder = new DigestBuilder(
      fakeSources({ listMemories: () => [memory()] }),
    );
    const built = await builder.build({ template: TEMPLATE, userId: "u", now: NOW });
    const item = built.sections.find((s) => s.category === "memories")?.items[0];
    expect(item?.id).toMatch(/^item-[0-9a-f]{8}$/);
    expect(item?.source).toBe("memory");
  });
});

describe("DigestBuilder plan plumbing", () => {
  it("passes the digest tool plan to the executor", async () => {
    let received: ExecutionPlan | undefined;
    const builder = new DigestBuilder(
      fakeSources({
        executeTools: async (plan) => {
          received = plan;
          return { planId: plan.id, results: [], succeededStepIds: [], failedStepIds: [], cancelledStepIds: [] };
        },
      }),
    );
    await builder.build({ template: TEMPLATE, userId: "u", now: NOW });
    expect(received?.steps.map((step: ExecutionStep) => step.toolId)).toEqual([
      "search.gmail",
      "search.calendar",
      "search.github",
      "search.drive",
    ]);
  });
});
