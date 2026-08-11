import { describe, it, expect, vi } from "vitest";
import {
  SearchGmailTool,
  SearchCalendarTool,
  SearchDriveTool,
  SearchGitHubTool,
  createBuiltInReadTools,
} from "@/lib/tools/builtin";
import { ToolRegistry } from "@/lib/tools/registry";
import { ToolExecutor } from "@/lib/tools/executor";
import { createExecutionPlan } from "@/lib/tools/plan";
import type { Planner, PlannerContext } from "@/lib/tools/planner";
import type { ProductionGmailService } from "@/lib/context/adapters/gmailServiceAdapter";
import type { ProductionCalendarService } from "@/lib/context/adapters/calendarServiceAdapter";
import type { ProductionDriveService } from "@/lib/context/adapters/driveServiceAdapter";
import type { ProductionGitHubService } from "@/lib/context/adapters/githubServiceAdapter";
import type { MessageSummary, ListMessagesResult } from "@/lib/services/gmail/types";
import type { EventSummary, ListEventsResult } from "@/lib/services/calendar/types";
import type { DriveFile, ListFilesResult } from "@/lib/services/drive/types";
import type { RepositorySummary, SearchRepositoriesResult } from "@/lib/services/github";

// ──────────────────────────────────────────────
//  Fixtures
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

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: "evt-1",
    summary: "Design review",
    description: "Review the new landing page mockups.",
    start: "2026-08-10T14:00:00Z",
    end: "2026-08-10T15:00:00Z",
    organizer: { email: "alice@example.com", displayName: "Alice Chen" },
    status: "confirmed",
    ...overrides,
  };
}

function makeDriveFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: "file-1",
    name: "Q3 Roadmap",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2026-08-05T09:00:00Z",
    owners: [{ displayName: "Alice Chen", emailAddress: "alice@example.com" }],
    parents: ["folder-1"],
    isFolder: false,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    id: 1001,
    name: "briefly",
    fullName: "acme/briefly",
    owner: "acme",
    ownerAvatarUrl: null,
    description: "AI-powered meeting summarizer.",
    htmlUrl: "https://github.com/acme/briefly",
    apiUrl: "https://api.github.com/repos/acme/briefly",
    isPrivate: false,
    isFork: false,
    language: "TypeScript",
    starCount: 10,
    watchersCount: 1,
    openIssuesCount: 3,
    defaultBranch: "main",
    updatedAt: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

// ──────────────────────────────────────────────
//  Mock production services (spy-able)
// ──────────────────────────────────────────────

interface MockGmailService extends ProductionGmailService {
  createClientForUser: ReturnType<typeof vi.fn>;
  searchMessages: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
}

function makeGmailService(messages: MessageSummary[]): MockGmailService {
  return {
    createClientForUser: vi.fn(async () => ({ client: {}, integration: { id: "g" } })),
    searchMessages: vi.fn(async (): Promise<ListMessagesResult> => ({ messages })),
    listMessages: vi.fn(async (): Promise<ListMessagesResult> => ({ messages })),
  } as unknown as MockGmailService;
}

interface MockCalendarService extends ProductionCalendarService {
  createClientForUser: ReturnType<typeof vi.fn>;
  searchEvents: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
}

function makeCalendarService(events: EventSummary[]): MockCalendarService {
  return {
    createClientForUser: vi.fn(async () => ({ client: {}, integration: { id: "c" } })),
    searchEvents: vi.fn(async (): Promise<ListEventsResult> => ({ events })),
    listEvents: vi.fn(async (): Promise<ListEventsResult> => ({ events })),
  } as unknown as MockCalendarService;
}

interface MockDriveService extends ProductionDriveService {
  createClientForUser: ReturnType<typeof vi.fn>;
  searchFiles: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
}

function makeDriveService(files: DriveFile[]): MockDriveService {
  return {
    createClientForUser: vi.fn(async () => ({ client: {}, integration: { id: "d" } })),
    searchFiles: vi.fn(async (): Promise<ListFilesResult> => ({ files })),
    listFiles: vi.fn(async (): Promise<ListFilesResult> => ({ files })),
  } as unknown as MockDriveService;
}

interface MockGithubService extends ProductionGitHubService {
  createClientForUser: ReturnType<typeof vi.fn>;
  searchRepositories: ReturnType<typeof vi.fn>;
  listRepositories: ReturnType<typeof vi.fn>;
}

function makeGithubService(repositories: RepositorySummary[]): MockGithubService {
  const noPagination = { next: null, prev: null, first: null, last: null, hasNext: false };
  return {
    createClientForUser: vi.fn(async () => ({ client: {}, integration: { id: "gh" } })),
    searchRepositories: vi.fn(
      async (): Promise<SearchRepositoriesResult> => ({
        repositories,
        totalCount: repositories.length,
        pagination: noPagination,
      }),
    ),
    listRepositories: vi.fn(async () => ({ repositories, pagination: noPagination })),
  } as unknown as MockGithubService;
}

// ──────────────────────────────────────────────
//  Read tool delegation
// ──────────────────────────────────────────────

describe("SearchGmailTool", () => {
  it("delegates to searchMessages and returns the production result", async () => {
    const messages = [makeMessage()];
    const service = makeGmailService(messages);
    const tool = new SearchGmailTool(service);
    const output = await tool.execute({ query: "invoice", maxResults: 5 });
    expect(service.searchMessages).toHaveBeenCalledWith("invoice", 5);
    expect(output.messages).toEqual(messages);
  });

  it("leaves maxResults undefined when omitted", async () => {
    const service = makeGmailService([]);
    await new SearchGmailTool(service).execute({ query: "invoice" });
    expect(service.searchMessages).toHaveBeenCalledWith("invoice", undefined);
  });

  it("exposes planner-facing metadata", () => {
    const tool = new SearchGmailTool();
    expect(tool.id).toBe("search.gmail");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("defaults to the production Gmail service", () => {
    expect(new SearchGmailTool()).toBeInstanceOf(SearchGmailTool);
  });
});

describe("SearchCalendarTool", () => {
  it("delegates to searchEvents with calendarId left undefined", async () => {
    const events = [makeEvent()];
    const service = makeCalendarService(events);
    const output = await new SearchCalendarTool(service).execute({ query: "meeting", maxResults: 5 });
    // production signature: searchEvents(q, calendarId?, maxResults?, pageToken?)
    expect(service.searchEvents).toHaveBeenCalledWith("meeting", undefined, 5);
    expect(output.events).toEqual(events);
  });
});

describe("SearchDriveTool", () => {
  it("delegates to searchFiles with maxResults as pageSize", async () => {
    const files = [makeDriveFile()];
    const service = makeDriveService(files);
    const output = await new SearchDriveTool(service).execute({ query: "roadmap", maxResults: 3 });
    // production signature: searchFiles(q, pageSize?, pageToken?)
    expect(service.searchFiles).toHaveBeenCalledWith("roadmap", 3);
    expect(output.files).toEqual(files);
  });
});

describe("SearchGitHubTool", () => {
  it("delegates to searchRepositories with perPage", async () => {
    const repositories = [makeRepo()];
    const service = makeGithubService(repositories);
    const output = await new SearchGitHubTool(service).execute({ query: "briefly", maxResults: 3 });
    expect(service.searchRepositories).toHaveBeenCalledWith({ query: "briefly", perPage: 3 });
    expect(output.repositories).toEqual(repositories);
  });
});

// ──────────────────────────────────────────────
//  Input schemas
// ──────────────────────────────────────────────

describe("read tool input schemas", () => {
  it("reject an empty query", () => {
    const tool = new SearchGmailTool();
    expect(tool.inputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ query: "x" }).success).toBe(true);
  });

  it("validate maxResults", () => {
    const tool = new SearchGmailTool();
    expect(tool.inputSchema.safeParse({ query: "x", maxResults: 5 }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ query: "x", maxResults: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ query: "x", maxResults: -1 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ query: "x", maxResults: 2.5 }).success).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  Factory and end-to-end
// ──────────────────────────────────────────────

describe("createBuiltInReadTools", () => {
  it("returns the four read tools in a fixed order with unique ids", () => {
    const tools = createBuiltInReadTools();
    expect(tools.map((tool) => tool.id)).toEqual([
      "search.gmail",
      "search.calendar",
      "search.drive",
      "search.github",
    ]);
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(4);
    expect(new ToolRegistry(tools).list()).toHaveLength(4);
  });
});

describe("Planner contract end-to-end", () => {
  it("executes a planner-produced plan across the built-in tools", async () => {
    const gmail = makeGmailService([makeMessage()]);
    const calendar = makeCalendarService([makeEvent()]);
    const drive = makeDriveService([makeDriveFile()]);
    const github = makeGithubService([makeRepo()]);

    const registry = new ToolRegistry([
      new SearchGmailTool(gmail),
      new SearchCalendarTool(calendar),
      new SearchDriveTool(drive),
      new SearchGitHubTool(github),
    ]);

    // A provider-agnostic rule planner: synchronously maps a query to a plan.
    const rulePlanner: Planner = {
      plan(context: PlannerContext) {
        return createExecutionPlan({
          id: "rule-plan",
          steps: [
            { stepId: "step-1", toolId: "search.gmail", input: { query: context.query, maxResults: 5 }, dependsOn: [] },
            { stepId: "step-2", toolId: "search.github", input: { query: context.query, maxResults: 3 }, dependsOn: ["step-1"] },
          ],
        });
      },
    };

    const context: PlannerContext = {
      userId: "user-1",
      query: "project",
      availableToolIds: ["search.gmail", "search.calendar", "search.drive", "search.github"],
    };

    const plan = await rulePlanner.plan(context);
    const result = await new ToolExecutor(registry).execute(plan);

    expect(result.results.map((r) => r.status)).toEqual(["success", "success"]);
    const gmailOutput = result.results[0].output as ListMessagesResult;
    const githubOutput = result.results[1].output as SearchRepositoriesResult;
    expect(gmailOutput.messages).toHaveLength(1);
    expect(githubOutput.repositories).toHaveLength(1);
    expect(gmail.searchMessages).toHaveBeenCalledWith("project", 5);
    expect(github.searchRepositories).toHaveBeenCalledWith({ query: "project", perPage: 3 });
  });

  it("isolates a failing built-in tool inside a plan (partial success)", async () => {
    const failingGmail = makeGmailService([makeMessage()]);
    failingGmail.searchMessages.mockRejectedValue(new Error("gmail down"));
    const github = makeGithubService([makeRepo()]);

    const registry = new ToolRegistry([
      new SearchGmailTool(failingGmail),
      new SearchGitHubTool(github),
    ]);

    const plan = createExecutionPlan({
      id: "partial-plan",
      steps: [
        { stepId: "step-1", toolId: "search.gmail", input: { query: "x" }, dependsOn: [] },
        { stepId: "step-2", toolId: "search.github", input: { query: "x" }, dependsOn: [] },
      ],
    });

    const result = await new ToolExecutor(registry).execute(plan);
    expect(result.results[0].status).toBe("failure");
    expect(result.results[0].error?.code).toBe("execution_error");
    expect(result.results[1].status).toBe("success");
  });
});
