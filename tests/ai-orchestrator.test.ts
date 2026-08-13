import { describe, it, expect, vi } from "vitest";
import { AIOrchestrator } from "@/lib/ai/orchestrator";
import { AIToolPlanner } from "@/lib/ai/planner";
import { routeQuery } from "@/lib/ai/router";
import { createAITools, type AIToolResult } from "@/lib/ai/tools";
import { ToolRegistry } from "@/lib/tools/registry";
import type { Tool } from "@/lib/tools/types";
import type { GroqClient, GroqCompletion, GroqCompletionOptions } from "@/lib/ai/groq";
import { AppError } from "@/lib/errors";
import type { MessageSummary } from "@/lib/services/gmail/types";

// ──────────────────────────────────────────────
//  Stubbed Groq client
// ──────────────────────────────────────────────

function makeGroqStub(overrides: {
  text?: string;
  jsonSelection?: { tool?: string; input?: Record<string, unknown> };
  fail?: boolean;
  calls?: GroqCompletionOptions[];
} = {}) {
  const calls: GroqCompletionOptions[] = [];
  const stub: GroqClient = {
    async complete(options: GroqCompletionOptions): Promise<GroqCompletion> {
      calls.push(options);
      if (overrides.fail) {
        throw new AppError("Groq is down", 502, "groq_error");
      }
      // The planner asks for JSON mode (tool selection).
      if (options.jsonMode) {
        const tool = overrides.jsonSelection?.tool;
        if (tool) {
          return {
            text: JSON.stringify({ tool, input: overrides.jsonSelection?.input ?? {} }),
            model: "test",
          };
        }
        return { text: JSON.stringify({ tool: "" }), model: "test" };
      }
      return { text: overrides.text ?? "Here is the summary.", model: "test" };
    },
  };
  return { stub, calls };
}

// ──────────────────────────────────────────────
//  Mock services
// ──────────────────────────────────────────────

function makeMessage(overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: "msg-1",
    threadId: "thread-1",
    subject: "Project update",
    from: "alice@example.com",
    to: "bob@example.com",
    date: "2026-08-08T10:00:00Z",
    snippet: "The login flow is fixed and deployed.",
    labelIds: ["INBOX"],
    isUnread: false,
    ...overrides,
  };
}

/** Build a registry whose services are all mocked. */
function mockRegistry(): ToolRegistry {
  const gmailMessages = [makeMessage({ id: "m1", subject: "Urgent: deploy", isUnread: true })];
  const gmailService = {
    listMessages: vi.fn(async () => ({ messages: gmailMessages, nextPageToken: null })),
    searchMessages: vi.fn(async () => ({ messages: gmailMessages, nextPageToken: null })),
    getMessage: vi.fn(async () => gmailMessages[0]),
    getThread: vi.fn(async () => ({ id: "thread-1", messages: gmailMessages })),
  };
  const calendarService = {
    listEvents: vi.fn(async () => ({
      events: [
        {
          id: "evt-1",
          summary: "Design review",
          start: "2026-08-10T14:00:00Z",
          end: "2026-08-10T15:00:00Z",
          organizer: { email: "alice@example.com", displayName: "Alice" },
          attendees: [{ email: "bob@example.com", displayName: "Bob" }],
          status: "confirmed",
        },
      ],
      nextPageToken: null,
    })),
    getEvent: vi.fn(async () => ({
      id: "evt-1",
      summary: "Design review",
      start: "2026-08-10T14:00:00Z",
      end: "2026-08-10T15:00:00Z",
    })),
  };
  const driveService = {
    listFiles: vi.fn(async () => ({
      files: [{ id: "f1", name: "Q3 Roadmap", mimeType: "text/plain", modifiedTime: "2026-08-01T00:00:00Z", isFolder: false }],
      nextPageToken: null,
    })),
    searchFiles: vi.fn(async () => ({ files: [], nextPageToken: null })),
    getFile: vi.fn(async () => ({ id: "f1", name: "Q3 Roadmap", mimeType: "text/plain", isFolder: false })),
  };
  const githubService = {
    getRepository: vi.fn(async () => ({ id: 1, name: "briefly", fullName: "acme/briefly", owner: "acme", description: "AI", htmlUrl: "", apiUrl: "", isPrivate: false, isFork: false, language: "TS", starCount: 1, watchersCount: 0, openIssuesCount: 1, defaultBranch: "main", updatedAt: null, homepage: null, topics: [], visibility: null, license: null, size: null, forksCount: 0, createdAt: null, pushedAt: null, archived: false, disabled: false })),
    listRepositories: vi.fn(async () => ({
      repositories: [
        { id: 1, name: "briefly", fullName: "acme/briefly", owner: "acme", ownerAvatarUrl: null, description: "AI", htmlUrl: "", apiUrl: "", isPrivate: false, isFork: false, language: "TS", starCount: 1, watchersCount: 0, openIssuesCount: 1, defaultBranch: "main", updatedAt: null },
      ],
      pagination: { next: null, prev: null, first: null, last: null, hasNext: false },
    })),
    listIssues: vi.fn(async () => ({ issues: [], pagination: { next: null, prev: null, first: null, last: null, hasNext: false } })),
    listRepositoryEvents: vi.fn(async () => ({ events: [], pagination: { next: null, prev: null, first: null, last: null, hasNext: false } })),
  };
  const discordService = {
    listGuilds: vi.fn(async () => ({ guilds: [{ id: "g1", name: "Acme", icon: null, owner: false, permissions: "", memberCount: null, features: [], joinedAt: null }], pagination: { hasMore: false } })),
  };
  const telegramService = {
    listChats: vi.fn(async () => ({ chats: [{ id: 123, title: "Dev", username: null, type: "group" }] })),
    listMessages: vi.fn(async () => ({
      messages: [{ id: 1, chatId: 123, senderId: 1, senderName: "Alice", text: "Standup at 10", date: "2026-08-10T00:00:00Z", attachments: [] }],
    })),
  };

  const services: Record<string, unknown> = {
    "gmail.summarizeInbox": gmailService,
    "gmail.findImportantEmails": gmailService,
    "gmail.findUnreadEmails": gmailService,
    "gmail.searchEmails": gmailService,
    "gmail.summarizeThread": gmailService,
    "calendar.todaySchedule": calendarService,
    "calendar.upcomingMeetings": calendarService,
    "calendar.meetingPreparation": calendarService,
    "calendar.scheduleSummary": calendarService,
    "drive.searchFiles": driveService,
    "drive.recentFiles": driveService,
    "drive.summarizeDocument": driveService,
    "github.repositorySummary": githubService,
    "github.recentActivity": githubService,
    "github.openIssuesSummary": githubService,
    "discord.listGuilds": discordService,
    "discord.botRequired": discordService,
    "telegram.chatSummary": telegramService,
    "telegram.recentMessages": telegramService,
    "telegram.newsDigest": telegramService,
  };

  // Reconstruct each tool with its mocked service via the first constructor arg.
  const tools = createAITools().map((tool) => {
    const service = services[tool.id];
    return new (tool.constructor as new (service: unknown) => Tool)(service);
  });
  return new ToolRegistry(tools);
}

// ──────────────────────────────────────────────
//  Router
// ──────────────────────────────────────────────

describe("routeQuery", () => {
  it.each([
    ["Summarize my inbox", "gmail.summarizeInbox"],
    ["Find important emails", "gmail.findImportantEmails"],
    ["What are my unread emails?", "gmail.findUnreadEmails"],
    ["search my emails for invoices", "gmail.searchEmails"],
    ["What's on my calendar today?", "calendar.todaySchedule"],
    ["What meetings do I have tomorrow?", "calendar.upcomingMeetings"],
    ["Prepare me for my next meeting", "calendar.meetingPreparation"],
    ["Give me a schedule summary for this week", "calendar.scheduleSummary"],
    ["Find my recent Drive files", "drive.recentFiles"],
    ["search my drive for roadmaps", "drive.searchFiles"],
    ["Summarize this Drive document", "drive.summarizeDocument"],
    ["What are the important open GitHub issues?", "github.openIssuesSummary"],
    ["What happened in my briefly repo?", "github.recentActivity"],
    ["Give me a summary of my BrieflyAI GitHub repo", "github.repositorySummary"],
    ["Extract action items from Discord", "discord.botRequired"],
    ["What happened in my Discord channels today?", "discord.botRequired"],
    ["What happened in #general?", "discord.botRequired"],
    ["Show me recent Discord messages", "discord.botRequired"],
    ["Show my Discord servers", "discord.listGuilds"],
    ["Which Discord servers am I in?", "discord.listGuilds"],
    ["Summarize my Discord servers", "discord.listGuilds"],
    ["Summarize my Telegram updates", "telegram.newsDigest"],
    ["Summarize the Telegram chat", "telegram.chatSummary"],
    ["Show me recent Telegram messages", "telegram.recentMessages"],
  ])("routes %s → %s", (query, toolId) => {
    expect(routeQuery(query)?.toolId).toBe(toolId);
  });

  it("extracts a search topic from email queries", () => {
    const route = routeQuery("find emails about invoice #42");
    expect(route?.toolId).toBe("gmail.searchEmails");
    expect(String(route?.input.query)).toContain("invoice");
  });

  it("returns null for unmatched queries", () => {
    expect(routeQuery("what is the meaning of life?")).toBeNull();
  });
});

// ──────────────────────────────────────────────
//  Planner
// ──────────────────────────────────────────────

describe("AIToolPlanner", () => {
  it("falls back to the router when Groq selection is unavailable", async () => {
    const registry = mockRegistry();
    const { stub } = makeGroqStub({ fail: true });
    const planner = new AIToolPlanner({ registry, groq: stub });
    const plan = await planner.plan({
      userId: "u",
      query: "Summarize my inbox",
      availableToolIds: registry.list().map((tool) => tool.id),
    });
    expect(plan.steps[0].toolId).toBe("gmail.summarizeInbox");
  });

  it("uses the Groq selection when valid", async () => {
    const registry = mockRegistry();
    const { stub } = makeGroqStub({ jsonSelection: { tool: "calendar.todaySchedule" } });
    const planner = new AIToolPlanner({ registry, groq: stub });
    const plan = await planner.plan({
      userId: "u",
      query: "my day please",
      availableToolIds: registry.list().map((tool) => tool.id),
    });
    expect(plan.steps[0].toolId).toBe("calendar.todaySchedule");
  });

  it("throws no_matching_tool when nothing matches", async () => {
    const registry = mockRegistry();
    const planner = new AIToolPlanner({ registry, groq: makeGroqStub().stub });
    await expect(
      planner.plan({
        userId: "u",
        query: "explain quantum physics",
        availableToolIds: registry.list().map((tool) => tool.id),
      }),
    ).rejects.toMatchObject({ code: "no_matching_tool" });
  });
});

// ──────────────────────────────────────────────
//  Orchestrator
// ──────────────────────────────────────────────

describe("AIOrchestrator", () => {
  it("runs a query end-to-end and returns a Groq response", async () => {
    const registry = mockRegistry();
    const { stub, calls } = makeGroqStub({ text: "You have 1 urgent email." });
    const orchestrator = new AIOrchestrator({
      registry,
      planner: new AIToolPlanner({ registry, groq: stub }),
      groq: stub,
    });
    const result = await orchestrator.handle({ query: "Summarize my inbox" });
    expect(result.success).toBe(true);
    expect(result.tool).toBe("gmail.summarizeInbox");
    expect(result.response).toBe("You have 1 urgent email.");
    expect(result.generatedAt).toBeTruthy();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("short-circuits informational tools: returns the canned Discord Bot Required message without Groq summarization", async () => {
    const registry = mockRegistry();
    const { stub, calls } = makeGroqStub({ jsonSelection: { tool: "discord.botRequired" } });
    const planner = new AIToolPlanner({ registry, groq: stub });
    const orchestrator = new AIOrchestrator({ registry, planner, groq: stub });

    const result = await orchestrator.handle({ query: "Show me recent Discord messages" });

    expect(result.success).toBe(true);
    expect(result.tool).toBe("discord.botRequired");
    // The exact canned explanation is returned (HTTP 200 semantics — no error,
    // no unsupported Discord API call, no reconnect prompt).
    expect(result.response).toContain("requires installing a Discord Bot");
    expect(result.aiError).toBeUndefined();
    // The planner made exactly one Groq call (tool selection); the
    // summarization step was skipped entirely.
    expect(calls.length).toBe(1);
  });

  it("returns response null + aiError when Groq summarization fails (real data preserved)", async () => {
    const registry = mockRegistry();
    const { stub } = makeGroqStub({ fail: true });
    const planner = new AIToolPlanner({ registry, groq: stub });
    const orchestrator = new AIOrchestrator({ registry, planner, groq: stub });
    const result = await orchestrator.handle({ query: "Summarize my inbox" });
    expect(result.success).toBe(true);
    expect(result.tool).toBe("gmail.summarizeInbox");
    expect(result.response).toBeNull();
    expect(result.aiError?.code).toBe("groq_error");
  });

  it("throws AppError when tool execution fails", async () => {
    const registry = mockRegistry();
    const { stub } = makeGroqStub();
    const failingTool: Tool = {
      ...registry.get("gmail.summarizeInbox")!,
      execute: async (): Promise<AIToolResult> => {
        throw new AppError("No Google integration found for user", 404, "google_not_connected");
      },
    };
    const failingRegistry = new ToolRegistry(
      registry.list().map((tool) => (tool.id === failingTool.id ? failingTool : tool)),
    );
    const orchestrator = new AIOrchestrator({
      registry: failingRegistry,
      planner: new AIToolPlanner({ registry: failingRegistry, groq: stub }),
      groq: stub,
    });
    // The ToolExecutor preserves the underlying AppError code + status so an
    // integration/auth failure surfaces cleanly (not flattened to a 502).
    await expect(orchestrator.handle({ query: "Summarize my inbox" })).rejects.toMatchObject({
      code: "google_not_connected",
      status: 404,
      message: "No Google integration found for user",
    });
  });

  it("rejects empty queries", async () => {
    const { stub } = makeGroqStub();
    const registry = mockRegistry();
    const orchestrator = new AIOrchestrator({
      registry,
      planner: new AIToolPlanner({ registry, groq: stub }),
      groq: stub,
    });
    await expect(orchestrator.handle({ query: "   " })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
