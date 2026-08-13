import { describe, it, expect, vi } from "vitest";
import {
  createAITools,
  createAIToolRegistry,
  AI_TOOL_IDS,
  GmailSummarizeInboxTool,
  GmailFindImportantEmailsTool,
  GmailFindUnreadEmailsTool,
  GmailSearchEmailsTool,
  GmailSummarizeThreadTool,
  CalendarTodayScheduleTool,
  CalendarUpcomingMeetingsTool,
  CalendarMeetingPreparationTool,
  CalendarScheduleSummaryTool,
  DriveSearchFilesTool,
  DriveRecentFilesTool,
  DriveSummarizeDocumentTool,
  GitHubRepositorySummaryTool,
  GitHubRecentActivityTool,
  GitHubOpenIssuesSummaryTool,
  DiscordListGuildsTool,
  DiscordBotRequiredTool,
  TelegramChatSummaryTool,
  TelegramRecentMessagesTool,
  TelegramNewsDigestTool,
  sanitizeForLLM,
} from "@/lib/ai";
import type { Tool } from "@/lib/tools/types";
import { AppError } from "@/lib/errors";
import type { MessageSummary, ThreadDetail } from "@/lib/services/gmail/types";
import type { EventDetail, EventSummary } from "@/lib/services/calendar/types";
import type { DriveFile } from "@/lib/services/drive/types";
import type { RepositoryDetail, RepositorySummary } from "@/lib/services/github";
import type { MessageSummary as TelegramMessage } from "@/lib/services/telegram/telegramService";

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
    isFolder: false,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<RepositoryDetail> = {}): RepositoryDetail {
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
    homepage: null,
    topics: ["ai", "summaries"],
    visibility: "public",
    license: null,
    size: 100,
    forksCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    pushedAt: "2026-08-01T10:00:00Z",
    archived: false,
    disabled: false,
    ...overrides,
  };
}

function makeRepoSummary(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  const detail = makeRepo(overrides);
  return {
    id: detail.id,
    name: detail.name,
    fullName: detail.fullName,
    owner: detail.owner,
    ownerAvatarUrl: detail.ownerAvatarUrl,
    description: detail.description,
    htmlUrl: detail.htmlUrl,
    apiUrl: detail.apiUrl,
    isPrivate: detail.isPrivate,
    isFork: detail.isFork,
    language: detail.language,
    starCount: detail.starCount,
    watchersCount: detail.watchersCount,
    openIssuesCount: detail.openIssuesCount,
    defaultBranch: detail.defaultBranch,
    updatedAt: detail.updatedAt,
  };
}

function makeTelegramMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    id: 1,
    chatId: 123,
    senderId: 1,
    senderName: "Alice",
    text: "Reminder: standup moved to 10am.",
    date: "2026-08-10T09:00:00Z",
    attachments: [],
    ...overrides,
  };
}

const noPagination = { next: null, prev: null, first: null, last: null, hasNext: false };

// ──────────────────────────────────────────────
//  Mock services
// ──────────────────────────────────────────────

function makeGmailService(overrides: Record<string, unknown> = {}) {
  const messages = (overrides.messages as MessageSummary[]) ?? [makeMessage()];
  return {
    listMessages: vi.fn(async () => ({ messages, nextPageToken: null })),
    searchMessages: vi.fn(async () => ({ messages, nextPageToken: null })),
    getMessage: vi.fn(async () => makeMessage()),
    getThread: vi.fn(async (): Promise<ThreadDetail> => ({ id: "thread-1", messages })),
    ...overrides,
  };
}

function makeCalendarService(overrides: Record<string, unknown> = {}) {
  const events = (overrides.events as EventSummary[]) ?? [makeEvent()];
  const getEvent =
    overrides.getEvent ?? vi.fn(async (): Promise<EventDetail> => makeEvent());
  return {
    listEvents: vi.fn(async () => ({ events, nextPageToken: null })),
    getEvent,
    ...overrides,
  };
}

function makeDriveService(overrides: Record<string, unknown> = {}) {
  const files = (overrides.files as DriveFile[]) ?? [makeDriveFile()];
  return {
    listFiles: vi.fn(async () => ({ files, nextPageToken: null })),
    searchFiles: vi.fn(async () => ({ files, nextPageToken: null })),
    getFile: vi.fn(async () => files[0]),
    ...overrides,
  };
}

function makeGithubService(overrides: Record<string, unknown> = {}) {
  const repo = (overrides.repository as RepositoryDetail) ?? makeRepo();
  return {
    getRepository: vi.fn(async () => repo),
    listRepositories: vi.fn(async () => ({ repositories: [makeRepoSummary(repo)], pagination: noPagination })),
    listIssues: vi.fn(async () => ({
      issues: [
        { id: 1, number: 1, title: "Bug", state: "open", body: "A bug", user: "alice", labels: ["bug"], createdAt: null, updatedAt: null, htmlUrl: "", comments: 0 },
      ],
      pagination: noPagination,
    })),
    listRepositoryEvents: vi.fn(async () => ({
      events: [
        { id: "e1", type: "PushEvent", actor: "alice", createdAt: "2026-08-01T10:00:00Z", action: null, ref: "main", commitCount: 2, issueNumber: null, pullRequestNumber: null, title: null },
      ],
      pagination: noPagination,
    })),
    ...overrides,
  };
}

function makeDiscordService(overrides: Record<string, unknown> = {}) {
  return {
    listGuilds: vi.fn(async () => ({ guilds: [{ id: "guild-1", name: "Acme", icon: null, owner: false, permissions: "", memberCount: null, features: [], joinedAt: null }], pagination: { hasMore: false } })),
    ...overrides,
  };
}

function makeTelegramService(overrides: Record<string, unknown> = {}) {
  return {
    listChats: vi.fn(async () => ({ chats: [{ id: 123, title: "Dev Team", username: null, type: "group" }] })),
    listMessages: vi.fn(async () => ({ messages: [makeTelegramMessage()] })),
    ...overrides,
  };
}

// ──────────────────────────────────────────────
//  Registration
// ──────────────────────────────────────────────

describe("AI tool registration", () => {
  it("creates the full tool set (20 tools) with unique ids in the declared order", () => {
    const tools = createAITools();
    expect(tools).toHaveLength(20);
    expect(tools.map((tool) => tool.id)).toEqual([...AI_TOOL_IDS]);
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(20);
  });

  it("builds a registry from the factory without duplicates", () => {
    const registry = createAIToolRegistry();
    expect(registry.list()).toHaveLength(20);
    expect(registry.get("gmail.summarizeInbox")).toBeDefined();
    expect(registry.get("telegram.newsDigest")).toBeDefined();
  });

  it("exposes planner-facing metadata (description + schemas) on every tool", () => {
    for (const tool of createAITools()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("covers all six integration families", () => {
    const ids = createAITools().map((tool) => tool.id);
    expect(ids.filter((id) => id.startsWith("gmail."))).toHaveLength(5);
    expect(ids.filter((id) => id.startsWith("calendar."))).toHaveLength(4);
    expect(ids.filter((id) => id.startsWith("drive."))).toHaveLength(3);
    expect(ids.filter((id) => id.startsWith("github."))).toHaveLength(3);
    // Discord: only the OAuth-supported guild list + the canned bot-required
    // explanation (channel/message tools were removed — they need a bot).
    expect(ids.filter((id) => id.startsWith("discord."))).toHaveLength(2);
    expect(ids.filter((id) => id.startsWith("telegram."))).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────
//  Input validation
// ──────────────────────────────────────────────

describe("AI tool input validation", () => {
  const tools: Tool[] = createAITools();

  it("rejects invalid maxResults values (0, negative, non-integer, over max)", () => {
    const tool = tools.find((t) => t.id === "gmail.summarizeInbox")!;
    expect(tool.inputSchema.safeParse({ maxResults: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ maxResults: -1 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ maxResults: 2.5 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ maxResults: 51 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ maxResults: 20 }).success).toBe(true);
  });

  it("rejects a missing search query", () => {
    const tool = tools.find((t) => t.id === "gmail.searchEmails")!;
    expect(tool.inputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ query: "invoices" }).success).toBe(true);
  });

  it("requires a threadId for thread summarization", () => {
    const tool = tools.find((t) => t.id === "gmail.summarizeThread")!;
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ threadId: "abc123" }).success).toBe(true);
  });

  it("rejects invalid window sizes", () => {
    const tool = tools.find((t) => t.id === "calendar.upcomingMeetings")!;
    expect(tool.inputSchema.safeParse({ days: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ days: 31 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ days: 7 }).success).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Gmail tools
// ──────────────────────────────────────────────

describe("Gmail tools", () => {
  it("gmail.summarizeInbox lists messages with sources", async () => {
    const service = makeGmailService({ messages: [makeMessage({ id: "m1", subject: "Hello" })] });
    const result = await new GmailSummarizeInboxTool(service).execute({});
    expect(service.listMessages).toHaveBeenCalledWith({ maxResults: 20 });
    expect(result.success).toBe(true);
    expect(result.tool).toBe("gmail.summarizeInbox");
    expect(result.data.count).toBe(1);
    expect(result.sources[0]).toMatchObject({ integration: "gmail", id: "m1", title: "Hello" });
  });

  it("gmail.findImportantEmails ranks unread first deterministically", async () => {
    const old = makeMessage({ id: "old", isUnread: false, date: "2026-08-01T00:00:00Z" });
    const unread = makeMessage({ id: "unread", isUnread: true, date: "2026-08-08T00:00:00Z" });
    const recent = makeMessage({ id: "recent", isUnread: false, date: "2026-08-09T00:00:00Z" });
    const service = makeGmailService({ messages: [old, unread, recent] });
    const result = await new GmailFindImportantEmailsTool(service).execute({ maxResults: 3 });
    const ids = (result.data.emails as Array<{ id: string; reason: string }>).map((e) => e.id);
    expect(ids).toEqual(["unread", "recent", "old"]);
    expect((result.data.emails as Array<{ reason: string }>)[0].reason).toBe("Unread");
  });

  it("gmail.findUnreadEmails requests the UNREAD label and returns only unread", async () => {
    const service = makeGmailService({
      messages: [
        makeMessage({ id: "u1", isUnread: true }),
        makeMessage({ id: "r1", isUnread: false }),
      ],
    });
    const result = await new GmailFindUnreadEmailsTool(service).execute({});
    expect(service.listMessages).toHaveBeenCalledWith({ maxResults: 30, labelIds: ["UNREAD"] });
    expect((result.data.emails as Array<{ id: string }>).map((e) => e.id)).toEqual(["u1"]);
  });

  it("gmail.searchEmails delegates the query", async () => {
    const service = makeGmailService();
    await new GmailSearchEmailsTool(service).execute({ query: "invoice", maxResults: 5 });
    expect(service.searchMessages).toHaveBeenCalledWith("invoice", 5);
  });

  it("gmail.summarizeThread fetches the thread and truncates messages", async () => {
    const service = makeGmailService({
      getThread: vi.fn(async (): Promise<ThreadDetail> => ({
        id: "thread-9",
        messages: [makeMessage({ id: "a" }), makeMessage({ id: "b" }), makeMessage({ id: "c" })],
      })),
    });
    const result = await new GmailSummarizeThreadTool(service).execute({ threadId: "thread-9", maxMessages: 2 });
    expect(service.getThread).toHaveBeenCalledWith("thread-9");
    expect(result.data.messages).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────
//  Calendar tools
// ──────────────────────────────────────────────

describe("Calendar tools", () => {
  const NOW = new Date("2026-08-10T12:00:00Z");
  const nowFn = () => NOW;

  it("calendar.todaySchedule lists today's events in chronological order", async () => {
    const later = makeEvent({ id: "later", start: "2026-08-10T15:00:00Z" });
    const earlier = makeEvent({ id: "earlier", start: "2026-08-10T09:00:00Z" });
    const service = makeCalendarService({ events: [later, earlier] });
    const result = await new CalendarTodayScheduleTool(service, nowFn).execute({});
    // Expected boundaries mirror the tool's local-timezone day computation.
    const expectedFrom = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 0, 0, 0, 0);
    const expectedTo = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1, 0, 0, 0, 0);
    expect(service.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        from: expectedFrom.toISOString(),
        to: expectedTo.toISOString(),
      }),
    );
    expect((result.data.events as Array<{ id: string }>).map((e) => e.id)).toEqual(["earlier", "later"]);
  });

  it("calendar.upcomingMeetings applies the days window", async () => {
    const service = makeCalendarService();
    await new CalendarUpcomingMeetingsTool(service, nowFn).execute({ days: 3, maxResults: 5 });
    expect(service.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ from: "2026-08-10T12:00:00.000Z", to: "2026-08-13T12:00:00.000Z", maxResults: 5 }),
    );
  });

  it("calendar.meetingPreparation fetches a specific event", async () => {
    const service = makeCalendarService({ getEvent: vi.fn(async (): Promise<EventDetail> => makeEvent()) });
    const result = await new CalendarMeetingPreparationTool(service, nowFn).execute({ eventId: "evt-9" });
    expect(service.getEvent).toHaveBeenCalledWith("evt-9");
    expect(result.data.event).toBeDefined();
  });

  it("calendar.meetingPreparation resolves the next meeting when no eventId is given", async () => {
    const service = makeCalendarService();
    const result = await new CalendarMeetingPreparationTool(service, nowFn).execute({});
    expect(service.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ from: "2026-08-10T12:00:00.000Z", maxResults: 1 }),
    );
    expect(service.getEvent).toHaveBeenCalledWith("evt-1");
    expect(result.data.event).toBeDefined();
  });

  it("calendar.meetingPreparation fails honestly when there is no next meeting", async () => {
    const service = makeCalendarService({ events: [] });
    await expect(new CalendarMeetingPreparationTool(service, nowFn).execute({})).rejects.toMatchObject({
      code: "no_upcoming_events",
    });
  });

  it("calendar.scheduleSummary lists the window events", async () => {
    const service = makeCalendarService();
    const result = await new CalendarScheduleSummaryTool(service, nowFn).execute({ days: 7 });
    expect(result.data.window).toMatchObject({ days: 7 });
    expect(result.data.count).toBe(1);
  });
});

// ──────────────────────────────────────────────
//  Drive tools
// ──────────────────────────────────────────────

describe("Drive tools", () => {
  it("drive.searchFiles delegates the query", async () => {
    const service = makeDriveService();
    await new DriveSearchFilesTool(service).execute({ query: "roadmap", maxResults: 3 });
    expect(service.searchFiles).toHaveBeenCalledWith("roadmap", 3);
  });

  it("drive.recentFiles sorts by modified time descending", async () => {
    const older = makeDriveFile({ id: "older", modifiedTime: "2026-08-01T00:00:00Z" });
    const newer = makeDriveFile({ id: "newer", modifiedTime: "2026-08-09T00:00:00Z" });
    const service = makeDriveService({ files: [older, newer] });
    const result = await new DriveRecentFilesTool(service).execute({});
    expect((result.data.files as Array<{ id: string }>).map((f) => f.id)).toEqual(["newer", "older"]);
  });

  it("drive.summarizeDocument returns metadata with contentAvailable false (no fake summary)", async () => {
    const service = makeDriveService({ files: [makeDriveFile({ id: "doc-1", name: "plan.pdf" })] });
    const result = await new DriveSummarizeDocumentTool(service).execute({ fileId: "doc-1" });
    expect(service.getFile).toHaveBeenCalledWith("doc-1");
    expect(result.data.contentAvailable).toBe(false);
    expect(result.data.file).toMatchObject({ id: "doc-1", name: "plan.pdf" });
    expect(result.data.summary).toBeUndefined();
  });

  it("drive.summarizeDocument defaults to the most recent file", async () => {
    const service = makeDriveService({ files: [makeDriveFile({ id: "only" })] });
    const result = await new DriveSummarizeDocumentTool(service).execute({});
    expect(service.listFiles).toHaveBeenCalledWith({ pageSize: 1 });
    expect(result.data.file).toMatchObject({ id: "only" });
  });
});

// ──────────────────────────────────────────────
//  GitHub tools
// ──────────────────────────────────────────────

describe("GitHub tools", () => {
  it("github.repositorySummary fetches the parsed owner/repo (verified against the user's repos)", async () => {
    const service = makeGithubService();
    await new GitHubRepositorySummaryTool(service).execute({ repository: "acme/briefly" });
    // The reference is matched against the authenticated user's repository list
    // before the detail fetch (same identity, no blind trust of raw strings).
    expect(service.listRepositories).toHaveBeenCalledWith({ perPage: 100 });
    expect(service.getRepository).toHaveBeenCalledWith("acme", "briefly");
  });

  it("github.repositorySummary defaults to the most recently updated non-fork repo", async () => {
    const service = makeGithubService();
    const result = await new GitHubRepositorySummaryTool(service).execute({});
    expect(service.listRepositories).toHaveBeenCalledWith({
      sort: "updated",
      direction: "desc",
      perPage: 20,
    });
    expect(service.getRepository).toHaveBeenCalledWith("acme", "briefly");
    expect(result.data.repository).toMatchObject({ fullName: "acme/briefly" });
  });

  it("github.recentActivity returns normalized events", async () => {
    const service = makeGithubService();
    const result = await new GitHubRecentActivityTool(service).execute({ repository: "acme/briefly", limit: 10 });
    expect(service.listRepositoryEvents).toHaveBeenCalledWith("acme", "briefly", 10);
    expect(result.data.events[0]).toMatchObject({ type: "PushEvent", actor: "alice", commitCount: 2 });
  });

  it("github.openIssuesSummary requests open issues", async () => {
    const service = makeGithubService();
    const result = await new GitHubOpenIssuesSummaryTool(service).execute({ repository: "acme/briefly" });
    expect(service.listIssues).toHaveBeenCalledWith("acme", "briefly", { state: "open", perPage: 30 });
    expect(result.data.issues[0]).toMatchObject({ number: 1, labels: ["bug"] });
  });

  it("fails honestly when the user has no repositories", async () => {
    const service = makeGithubService({
      listRepositories: vi.fn(async () => ({ repositories: [], pagination: noPagination })),
    });
    await expect(new GitHubRepositorySummaryTool(service).execute({})).rejects.toMatchObject({
      code: "no_repositories",
    });
  });

  it("sanitizes trailing punctuation and URLs in repository references", async () => {
    const service = makeGithubService();
    await new GitHubRepositorySummaryTool(service).execute({ repository: "https://github.com/acme/briefly." });
    expect(service.getRepository).toHaveBeenCalledWith("acme", "briefly");
  });

  it("strips .git suffixes from clone URLs and owner/repo references", async () => {
    const service = makeGithubService();
    await new GitHubRepositorySummaryTool(service).execute({ repository: "https://github.com/acme/briefly.git" });
    expect(service.getRepository).toHaveBeenCalledWith("acme", "briefly");
    await new GitHubRepositorySummaryTool(service).execute({ repository: "acme/briefly.git" });
    expect(service.getRepository).toHaveBeenCalledWith("acme", "briefly");
  });

  it("matches repository references case-insensitively against the user's repos", async () => {
    const service = makeGithubService();
    const result = await new GitHubRepositorySummaryTool(service).execute({ repository: "ACME/Briefly" });
    expect(service.getRepository).toHaveBeenCalledWith("acme", "briefly");
    expect(result.data.repository).toMatchObject({ fullName: "acme/briefly" });
  });

  it("resolves a bare repo name against the authenticated user's own repositories", async () => {
    const service = makeGithubService();
    const result = await new GitHubRepositorySummaryTool(service).execute({ repository: "briefly" });
    expect(service.listRepositories).toHaveBeenCalledWith({ perPage: 100 });
    expect(service.getRepository).toHaveBeenCalledWith("acme", "briefly");
    expect(result.data.repository).toMatchObject({ fullName: "acme/briefly" });
  });

  it("falls back to the default repo when an ownerless name matches nothing", async () => {
    const service = makeGithubService();
    await new GitHubRepositorySummaryTool(service).execute({ repository: "unknown-project" });
    // No name match → deterministic default (most recently updated non-fork).
    expect(service.listRepositories).toHaveBeenCalledWith({
      sort: "updated",
      direction: "desc",
      perPage: 20,
    });
    expect(service.getRepository).toHaveBeenCalledWith("acme", "briefly");
  });

  it("never reports a repository that is not in the user's repos and cannot be verified", async () => {
    const service = makeGithubService({
      // The user's repo list does NOT contain the requested repo, and the
      // direct verification 404s — the tool must fail, not fabricate a summary.
      listRepositories: vi.fn(async () => ({ repositories: [], pagination: noPagination })),
      getRepository: vi.fn(async () => {
        throw new AppError("Not Found", 404, "not_found");
      }),
    });
    await expect(new GitHubRepositorySummaryTool(service).execute({ repository: "acme/missing" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

// ──────────────────────────────────────────────
//  Discord tools
// ──────────────────────────────────────────────

describe("Discord tools", () => {
  it("lists the user's Discord servers via the OAuth-supported guilds endpoint", async () => {
    const service = makeDiscordService();
    const result = await new DiscordListGuildsTool(service).execute();
    expect(service.listGuilds).toHaveBeenCalledTimes(1);
    expect(result.data.guilds[0]).toMatchObject({ id: "guild-1", name: "Acme" });
    expect(result.sources[0]).toMatchObject({ integration: "discord", type: "guild" });
  });

  it("is honest when the user has no Discord servers", async () => {
    const service = makeDiscordService({ listGuilds: vi.fn(async () => ({ guilds: [], pagination: { hasMore: false } })) });
    const result = await new DiscordListGuildsTool(service).execute();
    expect(result.data.count).toBe(0);
    expect(result.data.guilds).toEqual([]);
  });

  it("never calls the Discord API for the bot-required explanation", async () => {
    const service = makeDiscordService();
    const tool = new DiscordBotRequiredTool(service);
    const result = await tool.execute();
    // Canned explanation only — no listGuilds (or any other API) call.
    expect(service.listGuilds).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data.message).toContain("requires installing a Discord Bot");
    expect(result.sources).toEqual([]);
  });

  it("marks the bot-required tool as informational for the orchestrator", () => {
    const tool = new DiscordBotRequiredTool();
    expect(tool.informational.title).toBe("Discord Bot Required");
    expect(tool.informational.message.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────
//  Telegram tools
// ──────────────────────────────────────────────

describe("Telegram tools", () => {
  it("resolves the first chat and returns messages", async () => {
    const service = makeTelegramService();
    const result = await new TelegramChatSummaryTool(service).execute({});
    expect(service.listChats).toHaveBeenCalled();
    expect(service.listMessages).toHaveBeenCalledWith("123", 50);
    expect(result.data.chat).toMatchObject({ title: "Dev Team" });
    expect(result.data.messages[0]).toMatchObject({ senderName: "Alice" });
  });

  it("honors an explicit chatId and limit", async () => {
    const service = makeTelegramService();
    const result = await new TelegramRecentMessagesTool(service).execute({ chatId: "999", limit: 5 });
    expect(service.listMessages).toHaveBeenCalledWith("999", 5);
    expect(result.data.chat.id).toBe(999);
  });

  it("fails honestly when the bot has no accessible chats (clean 404 state, not an internal failure)", async () => {
    const service = makeTelegramService({ listChats: vi.fn(async () => ({ chats: [] })) });
    await expect(new TelegramNewsDigestTool(service).execute({})).rejects.toMatchObject({
      code: "no_telegram_chats",
      status: 404,
    });
  });
});

// ──────────────────────────────────────────────
//  Empty results, errors, token protection
// ──────────────────────────────────────────────

describe("AI tool edge cases", () => {
  it("returns success with count 0 for an empty inbox (no fake data)", async () => {
    const service = makeGmailService({ messages: [] });
    const result = await new GmailSummarizeInboxTool(service).execute({});
    expect(result.success).toBe(true);
    expect(result.data.count).toBe(0);
    expect(result.sources).toEqual([]);
  });

  it("propagates AppError from the underlying service (disconnected integration)", async () => {
    const error = new AppError("No Google integration found for user", 404, "google_not_connected");
    const service = makeGmailService({
      listMessages: vi.fn(async () => {
        throw error;
      }),
    });
    await expect(new GmailSummarizeInboxTool(service).execute({})).rejects.toBe(error);
  });

  it("propagates generic service failures", async () => {
    const service = makeCalendarService({
      listEvents: vi.fn(async () => {
        throw new Error("calendar down");
      }),
    });
    await expect(new CalendarTodayScheduleTool(service).execute({})).rejects.toThrow("calendar down");
  });

  it("tool results never carry token/authorization fields (whatever the snippet says)", async () => {
    const service = makeGmailService({
      messages: [
        makeMessage({
          id: "m1",
          snippet: "the real content never includes credential fields",
        }),
      ],
    });
    const result = await new GmailSummarizeInboxTool(service).execute({});
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("Authorization");
    // The normalized shape exposes only the documented fields.
    const message = (result.data.messages as Array<Record<string, unknown>>)[0];
    expect(Object.keys(message).sort()).toEqual(
      ["date", "from", "id", "isUnread", "snippet", "subject", "threadId"].sort(),
    );
  });

  it("sanitizeForLLM strips sensitive keys and truncates long strings", () => {
    const input = {
      emails: [
        {
          id: "1",
          subject: "Hello",
          access_token: "gsk_secret",
          refresh_token: "rt",
          Authorization: "Bearer x",
          nested: { apiKey: "abc", ok: true },
        },
      ],
      longText: "x".repeat(2000),
    };
    const sanitized = sanitizeForLLM(input) as Record<string, unknown>;
    const email = (sanitized.emails as Array<Record<string, unknown>>)[0];
    expect(email.access_token).toBeUndefined();
    expect(email.refresh_token).toBeUndefined();
    expect(email.Authorization).toBeUndefined();
    expect((email.nested as Record<string, unknown>).apiKey).toBeUndefined();
    expect((email.nested as Record<string, unknown>).ok).toBe(true);
    expect((sanitized.longText as string).length).toBeLessThan(800);
  });

  it("sanitizeForLLM never mutates the input", () => {
    const input = { messages: [{ content: "hi", token: "secret" }] };
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    sanitizeForLLM(input);
    expect(input).toEqual(snapshot);
  });
});
