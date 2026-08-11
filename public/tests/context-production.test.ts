import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createProductionContextEngine,
  getProductionContextEngine,
  buildProductionPrompt,
  PRODUCTION_SOURCE_IDS,
  type ProductionPromptOptions,
} from "@/lib/context/production";
import { ContextEngine } from "@/lib/context/engine";
import { createContextEngine } from "@/lib/context/createContextEngine";
import { GmailServiceAdapter, type ProductionGmailService } from "@/lib/context/adapters/gmailServiceAdapter";
import {
  CalendarServiceAdapter,
  type ProductionCalendarService,
} from "@/lib/context/adapters/calendarServiceAdapter";
import { DriveServiceAdapter, type ProductionDriveService } from "@/lib/context/adapters/driveServiceAdapter";
import {
  GitHubServiceAdapter,
  type ProductionGitHubService,
} from "@/lib/context/adapters/githubServiceAdapter";
import {
  CONTEXT_PIPELINE_STAGES,
  isContextDebugEnabled,
  logContextDebug,
} from "@/lib/context/debug";
import type { MessageSummary, ListMessagesResult } from "@/lib/services/gmail/types";
import type { EventSummary, ListEventsResult } from "@/lib/services/calendar/types";
import type { DriveFile, ListFilesResult } from "@/lib/services/drive/types";
import type {
  RepositorySummary,
  ListRepositoriesResult,
  SearchRepositoriesResult,
} from "@/lib/services/github";
import { logger } from "@/lib/logger";
import type { ContextBuilder } from "@/lib/context/contextBuilder";
import type { ContextSource } from "@/lib/context/types";

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

function makeGmailService(
  overrides: { messages?: MessageSummary[]; availabilityError?: unknown; searchError?: unknown } = {},
): MockGmailService {
  const messages = overrides.messages ?? [];
  const service = {
    createClientForUser: vi.fn(async () => {
      if (overrides.availabilityError !== undefined) throw overrides.availabilityError;
      return { client: {}, integration: { id: "int-gmail" } };
    }),
    searchMessages: vi.fn(async (): Promise<ListMessagesResult> => {
      if (overrides.searchError !== undefined) throw overrides.searchError;
      return { messages };
    }),
    listMessages: vi.fn(async (): Promise<ListMessagesResult> => ({ messages })),
  };
  return service as unknown as MockGmailService;
}

interface MockCalendarService extends ProductionCalendarService {
  createClientForUser: ReturnType<typeof vi.fn>;
  searchEvents: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
}

function makeCalendarService(
  overrides: { events?: EventSummary[]; availabilityError?: unknown; searchError?: unknown } = {},
): MockCalendarService {
  const events = overrides.events ?? [];
  const service = {
    createClientForUser: vi.fn(async () => {
      if (overrides.availabilityError !== undefined) throw overrides.availabilityError;
      return { client: {}, integration: { id: "int-calendar" } };
    }),
    searchEvents: vi.fn(async (): Promise<ListEventsResult> => {
      if (overrides.searchError !== undefined) throw overrides.searchError;
      return { events };
    }),
    listEvents: vi.fn(async (): Promise<ListEventsResult> => ({ events })),
  };
  return service as unknown as MockCalendarService;
}

interface MockDriveService extends ProductionDriveService {
  createClientForUser: ReturnType<typeof vi.fn>;
  searchFiles: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
}

function makeDriveService(
  overrides: { files?: DriveFile[]; availabilityError?: unknown; searchError?: unknown } = {},
): MockDriveService {
  const files = overrides.files ?? [];
  const service = {
    createClientForUser: vi.fn(async () => {
      if (overrides.availabilityError !== undefined) throw overrides.availabilityError;
      return { client: {}, integration: { id: "int-drive" } };
    }),
    searchFiles: vi.fn(async (): Promise<ListFilesResult> => {
      if (overrides.searchError !== undefined) throw overrides.searchError;
      return { files };
    }),
    listFiles: vi.fn(async (): Promise<ListFilesResult> => ({ files })),
  };
  return service as unknown as MockDriveService;
}

interface MockGithubService extends ProductionGitHubService {
  createClientForUser: ReturnType<typeof vi.fn>;
  searchRepositories: ReturnType<typeof vi.fn>;
  listRepositories: ReturnType<typeof vi.fn>;
}

function makeGithubService(
  overrides: {
    repositories?: RepositorySummary[];
    availabilityError?: unknown;
    searchError?: unknown;
  } = {},
): MockGithubService {
  const repositories = overrides.repositories ?? [];
  const noPagination = { next: null, prev: null, first: null, last: null, hasNext: false };
  const service = {
    createClientForUser: vi.fn(async () => {
      if (overrides.availabilityError !== undefined) throw overrides.availabilityError;
      return { client: {}, integration: { id: "int-github" } };
    }),
    searchRepositories: vi.fn(async (): Promise<SearchRepositoriesResult> => {
      if (overrides.searchError !== undefined) throw overrides.searchError;
      return { repositories, totalCount: repositories.length, pagination: noPagination };
    }),
    listRepositories: vi.fn(async (): Promise<ListRepositoriesResult> => ({
      repositories,
      pagination: noPagination,
    })),
  };
  return service as unknown as MockGithubService;
}

// ──────────────────────────────────────────────
//  Engine wiring helpers
// ──────────────────────────────────────────────

function makeMockedEngine(mocks: {
  gmail?: MockGmailService;
  calendar?: MockCalendarService;
  drive?: MockDriveService;
  github?: MockGithubService;
} = {}) {
  return createContextEngine({
    gmailService: mocks.gmail ? new GmailServiceAdapter(mocks.gmail) : undefined,
    calendarService: mocks.calendar ? new CalendarServiceAdapter(mocks.calendar) : undefined,
    driveService: mocks.drive ? new DriveServiceAdapter(mocks.drive) : undefined,
    githubService: mocks.github ? new GitHubServiceAdapter(mocks.github) : undefined,
  });
}

function makeMockedProductionOptions(overrides: Partial<ProductionPromptOptions> = {}): ProductionPromptOptions {
  return {
    retrievalQuery: { userId: "user-1", query: "project status" },
    tokenBudget: 4000,
    userQuery: "What is the status of the project?",
    ...overrides,
  };
}

/** The source ids wired into an engine's builder (via a private-field cast). */
function builderSourceIds(engine: ContextEngine): string[] {
  const builder = (engine as unknown as { builder: ContextBuilder }).builder as unknown as {
    sources: ContextSource[];
  };
  return builder.sources.map((source) => source.id);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ──────────────────────────────────────────────
//  Production factory
// ──────────────────────────────────────────────

describe("production factory", () => {
  it("builds a ContextEngine", () => {
    expect(createProductionContextEngine()).toBeInstanceOf(ContextEngine);
  });

  it("wires exactly the four production source ids", () => {
    expect(builderSourceIds(createProductionContextEngine())).toEqual([
      "gmail",
      "calendar",
      "github",
      "drive",
    ]);
  });

  it("exposes the wired source ids as a constant", () => {
    expect(PRODUCTION_SOURCE_IDS).toEqual(["gmail", "calendar", "github", "drive"]);
  });

  it("returns the same singleton from getProductionContextEngine", () => {
    expect(getProductionContextEngine()).toBe(getProductionContextEngine());
  });

  it("returns fresh independent engines from the factory", () => {
    const a = createProductionContextEngine();
    const b = createProductionContextEngine();
    expect(a).not.toBe(b);
    expect(a).not.toBe(getProductionContextEngine());
  });
});

// ──────────────────────────────────────────────
//  Production factory end-to-end (no auth)
// ──────────────────────────────────────────────

describe("production engine end-to-end", () => {
  it("resolves a full prompt through the real adapters (unauthenticated → empty context)", async () => {
    // In a test environment no request auth exists, so every production
    // adapter reports unavailable and the pipeline degrades to empty context.
    const prompt = await getProductionContextEngine().buildPrompt(
      makeMockedProductionOptions(),
    );
    expect(prompt).toContain("================ SYSTEM ================");
    expect(prompt).toContain("================ CONTEXT ================");
    expect(prompt).toContain("================ USER ================");
    expect(prompt).toContain("================ ASSISTANT ================");
    expect(prompt).toContain("(No context available)");
  });
});

// ──────────────────────────────────────────────
//  Individual adapters through the engine
// ──────────────────────────────────────────────

describe("gmail adapter through the engine", () => {
  it("retrieves, maps, and includes email content in the prompt", async () => {
    const gmail = makeGmailService({ messages: [makeMessage()] });
    const engine = makeMockedEngine({ gmail });
    const prompt = await engine.buildPrompt(makeMockedProductionOptions());
    expect(prompt).toContain("Project update");
    expect(prompt).toContain("The login flow is fixed and deployed.");
    expect(gmail.searchMessages).toHaveBeenCalledWith("project status", undefined);
    expect(gmail.listMessages).not.toHaveBeenCalled();
  });
});

describe("calendar adapter through the engine", () => {
  it("retrieves, maps, and includes event content in the prompt", async () => {
    const calendar = makeCalendarService({ events: [makeEvent()] });
    const engine = makeMockedEngine({ calendar });
    const prompt = await engine.buildPrompt(makeMockedProductionOptions());
    expect(prompt).toContain("Review the new landing page mockups.");
    expect(calendar.searchEvents).toHaveBeenCalledWith("project status", undefined, undefined);
    expect(calendar.listEvents).not.toHaveBeenCalled();
  });
});

describe("drive adapter through the engine", () => {
  it("retrieves, maps, and includes file metadata in the prompt", async () => {
    const drive = makeDriveService({ files: [makeDriveFile()] });
    const engine = makeMockedEngine({ drive });
    const prompt = await engine.buildPrompt(makeMockedProductionOptions());
    expect(prompt).toContain("Q3 Roadmap");
    expect(drive.searchFiles).toHaveBeenCalledWith("project status", undefined);
    expect(drive.listFiles).not.toHaveBeenCalled();
  });
});

describe("github adapter through the engine", () => {
  it("retrieves, maps, and includes repository content in the prompt", async () => {
    const github = makeGithubService({ repositories: [makeRepo()] });
    const engine = makeMockedEngine({ github });
    const prompt = await engine.buildPrompt(makeMockedProductionOptions());
    expect(prompt).toContain("AI-powered meeting summarizer.");
    expect(github.searchRepositories).toHaveBeenCalledWith({
      query: "project status",
      perPage: undefined,
    });
    expect(github.listRepositories).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
//  Mixed / unavailable / failing adapters
// ──────────────────────────────────────────────

describe("mixed adapters through the engine", () => {
  it("combines items from all four production adapters into one prompt", async () => {
    const engine = makeMockedEngine({
      gmail: makeGmailService({ messages: [makeMessage()] }),
      calendar: makeCalendarService({ events: [makeEvent()] }),
      drive: makeDriveService({ files: [makeDriveFile()] }),
      github: makeGithubService({ repositories: [makeRepo()] }),
    });
    const prompt = await engine.buildPrompt(makeMockedProductionOptions());
    expect(prompt).toContain("The login flow is fixed and deployed.");
    expect(prompt).toContain("Review the new landing page mockups.");
    expect(prompt).toContain("Q3 Roadmap");
    expect(prompt).toContain("AI-powered meeting summarizer.");
  });
});

describe("unavailable adapters through the engine", () => {
  it("skips an unavailable adapter and keeps the available ones", async () => {
    const gmail = makeGmailService({ messages: [makeMessage()], availabilityError: new Error("not connected") });
    const calendar = makeCalendarService({ events: [makeEvent()] });
    const drive = makeDriveService({ files: [makeDriveFile()] });
    const github = makeGithubService({ repositories: [makeRepo()] });
    const engine = makeMockedEngine({ gmail, calendar, drive, github });
    const prompt = await engine.buildPrompt(makeMockedProductionOptions());
    expect(prompt).not.toContain("The login flow is fixed and deployed.");
    expect(prompt).toContain("Review the new landing page mockups.");
    expect(prompt).toContain("Q3 Roadmap");
    expect(prompt).toContain("AI-powered meeting summarizer.");
    expect(gmail.searchMessages).not.toHaveBeenCalled();
    expect(calendar.searchEvents).toHaveBeenCalled();
  });
});

describe("failing adapters through the engine", () => {
  it("does not fail the pipeline when an adapter's service rejects", async () => {
    const gmail = makeGmailService({ messages: [makeMessage()], searchError: new Error("gmail down") });
    const calendar = makeCalendarService({ events: [makeEvent()] });
    const engine = makeMockedEngine({ gmail, calendar });
    const prompt = await engine.buildPrompt(makeMockedProductionOptions());
    expect(prompt).toContain("Review the new landing page mockups.");
    expect(prompt).not.toContain("The login flow is fixed and deployed.");
    expect(gmail.searchMessages).toHaveBeenCalledTimes(1);
  });
});

describe("empty context through the engine", () => {
  it("renders the no-context placeholder when every adapter is unavailable", async () => {
    const engine = makeMockedEngine({
      gmail: makeGmailService({ availabilityError: new Error("down") }),
      calendar: makeCalendarService({ availabilityError: new Error("down") }),
      drive: makeDriveService({ availabilityError: new Error("down") }),
      github: makeGithubService({ availabilityError: new Error("down") }),
    });
    const prompt = await engine.buildPrompt(makeMockedProductionOptions());
    expect(prompt).toContain("(No context available)");
  });
});

// ──────────────────────────────────────────────
//  Prompt generation
// ──────────────────────────────────────────────

describe("prompt generation", () => {
  it("renders the full SYSTEM / HISTORY / CONTEXT / USER / ASSISTANT structure", async () => {
    const gmail = makeGmailService({ messages: [makeMessage()] });
    const engine = makeMockedEngine({ gmail });
    const options = makeMockedProductionOptions({
      history: ["User: hello", "Assistant: hi there"],
      systemPrompt: "You are a test assistant.",
    });
    const prompt = await engine.buildPrompt(options);
    expect(prompt).toContain("================ SYSTEM ================\n\nYou are a test assistant.");
    expect(prompt).toContain("================ HISTORY ================\n\nUser: hello\nAssistant: hi there");
    expect(prompt).toContain("================ CONTEXT ================");
    expect(prompt).toContain("================ USER ================\n\nWhat is the status of the project?");
    expect(prompt.endsWith("================ ASSISTANT ================")).toBe(true);
  });

  it("buildProductionPrompt returns the prompt through the production singleton", async () => {
    const prompt = await buildProductionPrompt(makeMockedProductionOptions());
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("================ USER ================");
  });

  it("buildProductionPrompt forwards systemPrompt and history into the prompt", async () => {
    const prompt = await buildProductionPrompt(
      makeMockedProductionOptions({
        history: ["User: hello", "Assistant: hi"],
        systemPrompt: "You are a test assistant.",
      }),
    );
    expect(prompt).toContain("================ SYSTEM ================\n\nYou are a test assistant.");
    expect(prompt).toContain("================ HISTORY ================\n\nUser: hello\nAssistant: hi");
    expect(prompt).toContain("================ USER ================\n\nWhat is the status of the project?");
  });
});

// ──────────────────────────────────────────────
//  Debug helpers (CONTEXT_DEBUG)
// ──────────────────────────────────────────────

describe("context debug helpers", () => {
  it("is disabled by default", () => {
    expect(isContextDebugEnabled()).toBe(false);
  });

  it("is enabled when CONTEXT_DEBUG=true", () => {
    vi.stubEnv("CONTEXT_DEBUG", "true");
    expect(isContextDebugEnabled()).toBe(true);
  });

  it("lists the fixed pipeline stages in execution order", () => {
    expect([...CONTEXT_PIPELINE_STAGES]).toEqual([
      "retrieve",
      "rank",
      "deduplicate",
      "compress",
      "assemble",
      "prompt",
    ]);
  });

  it("does not log through the shared logger when disabled", () => {
    const debugSpy = vi.spyOn(logger, "debug");
    logContextDebug("should not appear");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("logs through the shared logger when enabled", () => {
    vi.stubEnv("CONTEXT_DEBUG", "true");
    const debugSpy = vi.spyOn(logger, "debug");
    logContextDebug("pipeline started", { sources: ["gmail"] });
    expect(debugSpy).toHaveBeenCalledWith("[context] pipeline started", { sources: ["gmail"] });
  });

  it("buildProductionPrompt logs counts and timings when CONTEXT_DEBUG=true", async () => {
    vi.stubEnv("CONTEXT_DEBUG", "true");
    const debugSpy = vi.spyOn(logger, "debug");
    await buildProductionPrompt(makeMockedProductionOptions());
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("pipeline started"),
      expect.objectContaining({ sources: PRODUCTION_SOURCE_IDS }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("pipeline completed"),
      expect.objectContaining({ durationMs: expect.any(Number), promptLength: expect.any(Number) }),
    );
  });
});
