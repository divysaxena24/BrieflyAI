import { describe, it, expect, vi } from "vitest";
import { ContextSourceRegistry } from "@/lib/context/sourceRegistry";
import { MemorySource } from "@/lib/context/sources/memorySource";
import type { MemoryService } from "@/lib/context/sources/memorySource";
import { GmailSource } from "@/lib/context/sources/gmailSource";
import type { GmailService } from "@/lib/context/sources/gmailSource";
import { CalendarSource } from "@/lib/context/sources/calendarSource";
import type { CalendarService } from "@/lib/context/sources/calendarSource";
import { GitHubSource } from "@/lib/context/sources/githubSource";
import type { GitHubService } from "@/lib/context/sources/githubSource";
import { DriveSource } from "@/lib/context/sources/driveSource";
import type { DriveService } from "@/lib/context/sources/driveSource";
import type { ContextSource } from "@/lib/context/types";

function makeMemoryService(): MemoryService {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantMemory: vi.fn(async () => []),
  } as unknown as MemoryService;
}

function makeGmailService(): GmailService {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantEmails: vi.fn(async () => []),
  } as unknown as GmailService;
}

function makeCalendarService(): CalendarService {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantEvents: vi.fn(async () => []),
  } as unknown as CalendarService;
}

function makeGithubService(): GitHubService {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantItems: vi.fn(async () => []),
  } as unknown as GitHubService;
}

function makeDriveService(): DriveService {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantFiles: vi.fn(async () => []),
  } as unknown as DriveService;
}

describe("ContextSourceRegistry construction", () => {
  it("creates no sources for empty options", () => {
    const registry = new ContextSourceRegistry({});
    expect(registry.getSources()).toEqual([]);
  });

  it("creates no sources when options is undefined", () => {
    const registry = new ContextSourceRegistry();
    expect(registry.getSources()).toEqual([]);
  });

  it("creates only a MemorySource when only memoryService is provided", () => {
    const registry = new ContextSourceRegistry({ memoryService: makeMemoryService() });
    const sources = registry.getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(MemorySource);
  });

  it("creates only a GmailSource when only gmailService is provided", () => {
    const registry = new ContextSourceRegistry({ gmailService: makeGmailService() });
    const sources = registry.getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(GmailSource);
  });

  it("creates only a CalendarSource when only calendarService is provided", () => {
    const registry = new ContextSourceRegistry({ calendarService: makeCalendarService() });
    const sources = registry.getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(CalendarSource);
  });

  it("creates only a GitHubSource when only githubService is provided", () => {
    const registry = new ContextSourceRegistry({ githubService: makeGithubService() });
    const sources = registry.getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(GitHubSource);
  });

  it("creates only a DriveSource when only driveService is provided", () => {
    const registry = new ContextSourceRegistry({ driveService: makeDriveService() });
    const sources = registry.getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(DriveSource);
  });

  it("creates all five sources when every service is provided", () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService(),
      calendarService: makeCalendarService(),
      githubService: makeGithubService(),
      driveService: makeDriveService(),
    });
    const sources = registry.getSources();
    expect(sources).toHaveLength(5);
    expect(sources.map((s) => s.constructor)).toEqual([
      MemorySource,
      GmailSource,
      CalendarSource,
      GitHubSource,
      DriveSource,
    ]);
  });

  it("creates sources for arbitrary partial combinations", () => {
    const memoryOnly = new ContextSourceRegistry({ memoryService: makeMemoryService() });
    expect(memoryOnly.getSources().map((s) => s.id)).toEqual(["memory"]);

    const gmailAndDrive = new ContextSourceRegistry({
      gmailService: makeGmailService(),
      driveService: makeDriveService(),
    });
    expect(gmailAndDrive.getSources().map((s) => s.id)).toEqual(["gmail", "drive"]);

    const calendarAndGithub = new ContextSourceRegistry({
      calendarService: makeCalendarService(),
      githubService: makeGithubService(),
    });
    expect(calendarAndGithub.getSources().map((s) => s.id)).toEqual(["calendar", "github"]);
  });

  it("does not create a source for an omitted service", () => {
    const registry = new ContextSourceRegistry({
      gmailService: makeGmailService(),
      githubService: makeGithubService(),
    });
    const ids = registry.getSources().map((s) => s.id);
    expect(ids).toEqual(["gmail", "github"]);
    expect(ids).not.toContain("memory");
    expect(ids).not.toContain("calendar");
    expect(ids).not.toContain("drive");
  });
});

describe("ContextSourceRegistry ordering", () => {
  it("exposes the fixed creation order Memory → Gmail → Calendar → GitHub → Drive", () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService(),
      calendarService: makeCalendarService(),
      githubService: makeGithubService(),
      driveService: makeDriveService(),
    });
    expect(registry.getSources().map((s) => s.id)).toEqual([
      "memory",
      "gmail",
      "calendar",
      "github",
      "drive",
    ]);
  });

  it("keeps the fixed order even when option keys are passed in another order", () => {
    const registry = new ContextSourceRegistry({
      driveService: makeDriveService(),
      memoryService: makeMemoryService(),
      githubService: makeGithubService(),
    });
    expect(registry.getSources().map((s) => s.id)).toEqual(["memory", "github", "drive"]);
  });

  it("never sorts by priority", () => {
    // Creation order (memory→gmail→calendar→github→drive) is preserved as-is;
    // the registry performs no sorting of any kind.
    const registry = new ContextSourceRegistry({
      gmailService: makeGmailService(),
      calendarService: makeCalendarService(),
      driveService: makeDriveService(),
      memoryService: makeMemoryService(),
    });
    const ids = registry.getSources().map((s) => s.id);
    expect(ids).toEqual(["memory", "gmail", "calendar", "drive"]);
  });

  it("is deterministic for identical options", () => {
    const options = {
      memoryService: makeMemoryService(),
      calendarService: makeCalendarService(),
      driveService: makeDriveService(),
    };
    const a = new ContextSourceRegistry(options).getSources().map((s) => s.id);
    const b = new ContextSourceRegistry(options).getSources().map((s) => s.id);
    expect(b).toEqual(a);
  });
});

describe("ContextSourceRegistry immutability", () => {
  it("returns a new array on every call", () => {
    const registry = new ContextSourceRegistry({ memoryService: makeMemoryService() });
    const first = registry.getSources();
    const second = registry.getSources();
    expect(first).not.toBe(second);
  });

  it("returns independent arrays on repeated calls", () => {
    const registry = new ContextSourceRegistry({ memoryService: makeMemoryService() });
    const first = registry.getSources() as ContextSource[];
    first.push({} as unknown as ContextSource);
    expect(registry.getSources()).toHaveLength(1);
  });

  it("is unaffected by caller push/pop/splice on the returned array", () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService(),
    });
    const returned = registry.getSources() as ContextSource[];
    returned.pop();
    returned.splice(0, 1);
    returned.push({} as unknown as ContextSource);
    expect(registry.getSources()).toHaveLength(2);
    expect(registry.getSources().map((s) => s.id)).toEqual(["memory", "gmail"]);
  });

  it("exposes a shallow copy that never aliases the internal array", () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService(),
    });
    const first = registry.getSources();
    const second = registry.getSources();
    expect(first).not.toBe(second);
    expect(first[0]).toBe(second[0]); // same source instances, different arrays
  });
});

describe("ContextSourceRegistry identity", () => {
  it("creates the correct source class instances", () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService(),
      calendarService: makeCalendarService(),
      githubService: makeGithubService(),
      driveService: makeDriveService(),
    });
    const sources = registry.getSources();
    expect(sources[0]).toBeInstanceOf(MemorySource);
    expect(sources[1]).toBeInstanceOf(GmailSource);
    expect(sources[2]).toBeInstanceOf(CalendarSource);
    expect(sources[3]).toBeInstanceOf(GitHubSource);
    expect(sources[4]).toBeInstanceOf(DriveSource);
  });

  it("exposes the correct source ids", () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService(),
      calendarService: makeCalendarService(),
      githubService: makeGithubService(),
      driveService: makeDriveService(),
    });
    expect(registry.getSources().map((s) => s.id)).toEqual([
      "memory",
      "gmail",
      "calendar",
      "github",
      "drive",
    ]);
  });

  it("exposes the correct source priorities", () => {
    const registry = new ContextSourceRegistry({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService(),
      calendarService: makeCalendarService(),
      githubService: makeGithubService(),
      driveService: makeDriveService(),
    });
    expect(registry.getSources().map((s) => s.priority)).toEqual([100, 80, 60, 40, 20]);
  });
});

describe("ContextSourceRegistry dependency injection", () => {
  it("passes the memory service into the constructed MemorySource", async () => {
    const service = makeMemoryService();
    const registry = new ContextSourceRegistry({ memoryService: service });
    const [source] = registry.getSources();
    await source.isAvailable("user-1");
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("passes the gmail service into the constructed GmailSource", async () => {
    const service = makeGmailService();
    const registry = new ContextSourceRegistry({ gmailService: service });
    const [source] = registry.getSources();
    await source.isAvailable("user-1");
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("passes the calendar service into the constructed CalendarSource", async () => {
    const service = makeCalendarService();
    const registry = new ContextSourceRegistry({ calendarService: service });
    const [source] = registry.getSources();
    await source.isAvailable("user-1");
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("passes the github service into the constructed GitHubSource", async () => {
    const service = makeGithubService();
    const registry = new ContextSourceRegistry({ githubService: service });
    const [source] = registry.getSources();
    await source.isAvailable("user-1");
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("passes the drive service into the constructed DriveSource", async () => {
    const service = makeDriveService();
    const registry = new ContextSourceRegistry({ driveService: service });
    const [source] = registry.getSources();
    await source.isAvailable("user-1");
    expect(service.isAvailable).toHaveBeenCalledWith("user-1");
  });

  it("creates no extra source instances", () => {
    const registry = new ContextSourceRegistry({ memoryService: makeMemoryService() });
    const sources = registry.getSources();
    expect(sources).toHaveLength(1);
    expect(sources.filter((s) => s instanceof MemorySource)).toHaveLength(1);
    expect(sources.some((s) => s instanceof GmailSource)).toBe(false);
    expect(sources.some((s) => s instanceof CalendarSource)).toBe(false);
    expect(sources.some((s) => s instanceof GitHubSource)).toBe(false);
    expect(sources.some((s) => s instanceof DriveSource)).toBe(false);
  });
});
