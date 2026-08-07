import { afterEach, describe, it, expect, vi } from "vitest";
import { createContextEngine } from "@/lib/context/createContextEngine";
import { ContextEngine } from "@/lib/context/engine";
import { ContextBuilder } from "@/lib/context/contextBuilder";
import { ContextRanker } from "@/lib/context/contextRanker";
import { ContextDeduplicator } from "@/lib/context/contextDeduplicator";
import { ContextCompressor } from "@/lib/context/contextCompressor";
import { ContextAssembler } from "@/lib/context/contextAssembler";
import { PromptBuilder } from "@/lib/context/promptBuilder";
import { ContextSourceRegistry } from "@/lib/context/sourceRegistry";
import type { MemoryService } from "@/lib/context/sources/memorySource";
import type { GmailService } from "@/lib/context/sources/gmailSource";
import type { CalendarService } from "@/lib/context/sources/calendarSource";
import type { GitHubService } from "@/lib/context/sources/githubSource";
import type { DriveService } from "@/lib/context/sources/driveSource";
import type { ContextSource } from "@/lib/context/types";

interface MemoryServiceMock extends MemoryService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantMemory: ReturnType<typeof vi.fn>;
}

interface GmailServiceMock extends GmailService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantEmails: ReturnType<typeof vi.fn>;
}

interface CalendarServiceMock extends CalendarService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantEvents: ReturnType<typeof vi.fn>;
}

interface GitHubServiceMock extends GitHubService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantItems: ReturnType<typeof vi.fn>;
}

interface DriveServiceMock extends DriveService {
  isAvailable: ReturnType<typeof vi.fn>;
  retrieveRelevantFiles: ReturnType<typeof vi.fn>;
}

function makeMemoryService(): MemoryServiceMock {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantMemory: vi.fn(async () => [
      { id: "mem-1", title: "Memory", content: "Remembered fact", timestamp: null },
    ]),
  } as unknown as MemoryServiceMock;
}

function makeGmailService(): GmailServiceMock {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantEmails: vi.fn(async () => [
      { id: "e-1", subject: "Subject", body: "Email body", timestamp: null },
    ]),
  } as unknown as GmailServiceMock;
}

function makeCalendarService(): CalendarServiceMock {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantEvents: vi.fn(async () => [
      { id: "ev-1", title: "Meeting", description: "Meeting description", startTime: null },
    ]),
  } as unknown as CalendarServiceMock;
}

function makeGithubService(): GitHubServiceMock {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantItems: vi.fn(async () => [
      { id: "gh-1", title: "Issue", content: "GitHub issue body", timestamp: null },
    ]),
  } as unknown as GitHubServiceMock;
}

function makeDriveService(): DriveServiceMock {
  return {
    isAvailable: vi.fn(async () => true),
    retrieveRelevantFiles: vi.fn(async () => [
      { id: "dr-1", title: "Doc", content: "Drive file content", timestamp: null },
    ]),
  } as unknown as DriveServiceMock;
}

/** The runtime shape of ContextEngine's private component fields. */
interface EngineInternals {
  builder: ContextBuilder;
  ranker: ContextRanker;
  deduplicator: ContextDeduplicator;
  compressor: ContextCompressor;
  assembler: ContextAssembler;
  promptBuilder: PromptBuilder;
}

/** Read the engine's private components via a cast (no `any`). */
function internals(engine: ContextEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

/** The source ids wired into the engine's builder. */
function builderSourceIds(engine: ContextEngine): string[] {
  const builder = internals(engine).builder as unknown as { sources: ContextSource[] };
  return builder.sources.map((s) => s.id);
}

const basePromptOptions = {
  retrievalQuery: { userId: "user-1", query: "remember" },
  tokenBudget: 1000,
  userQuery: "What should I remember?",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createContextEngine factory", () => {
  it("returns a ContextEngine", () => {
    expect(createContextEngine()).toBeInstanceOf(ContextEngine);
  });

  it("accepts empty options", () => {
    const engine = createContextEngine({});
    expect(engine).toBeInstanceOf(ContextEngine);
    expect(builderSourceIds(engine)).toEqual([]);
  });

  it("accepts undefined options", () => {
    const engine = createContextEngine(undefined);
    expect(engine).toBeInstanceOf(ContextEngine);
    expect(builderSourceIds(engine)).toEqual([]);
  });

  it("accepts all five services", () => {
    const engine = createContextEngine({
      memoryService: makeMemoryService(),
      gmailService: makeGmailService(),
      calendarService: makeCalendarService(),
      githubService: makeGithubService(),
      driveService: makeDriveService(),
    });
    expect(builderSourceIds(engine)).toEqual(["memory", "gmail", "calendar", "github", "drive"]);
  });

  it("accepts partial services", () => {
    const engine = createContextEngine({
      calendarService: makeCalendarService(),
      githubService: makeGithubService(),
    });
    expect(builderSourceIds(engine)).toEqual(["calendar", "github"]);
  });
});

describe("createContextEngine construction", () => {
  it("constructs a ContextBuilder", () => {
    expect(internals(createContextEngine()).builder).toBeInstanceOf(ContextBuilder);
  });

  it("constructs a ContextRanker", () => {
    expect(internals(createContextEngine()).ranker).toBeInstanceOf(ContextRanker);
  });

  it("constructs a ContextDeduplicator", () => {
    expect(internals(createContextEngine()).deduplicator).toBeInstanceOf(ContextDeduplicator);
  });

  it("constructs a ContextCompressor", () => {
    expect(internals(createContextEngine()).compressor).toBeInstanceOf(ContextCompressor);
  });

  it("constructs a ContextAssembler", () => {
    expect(internals(createContextEngine()).assembler).toBeInstanceOf(ContextAssembler);
  });

  it("constructs a PromptBuilder", () => {
    expect(internals(createContextEngine()).promptBuilder).toBeInstanceOf(PromptBuilder);
  });

  it("uses a ContextSourceRegistry to build the source list", () => {
    const getSourcesSpy = vi.spyOn(ContextSourceRegistry.prototype, "getSources");
    createContextEngine({ memoryService: makeMemoryService() });
    expect(getSourcesSpy).toHaveBeenCalledTimes(1);
  });
});

describe("createContextEngine identity", () => {
  it("returns a fresh engine on every call (no singleton)", () => {
    const a = createContextEngine();
    const b = createContextEngine();
    expect(a).not.toBe(b);
  });

  it("constructs a different builder per call", () => {
    expect(internals(createContextEngine()).builder).not.toBe(
      internals(createContextEngine()).builder,
    );
  });

  it("constructs a different registry per call", () => {
    const getSourcesSpy = vi.spyOn(ContextSourceRegistry.prototype, "getSources");
    createContextEngine({ memoryService: makeMemoryService() });
    createContextEngine({ memoryService: makeMemoryService() });
    expect(getSourcesSpy).toHaveBeenCalledTimes(2);
  });

  it("constructs fresh pipeline components per call", () => {
    const first = internals(createContextEngine());
    const second = internals(createContextEngine());
    expect(first.ranker).not.toBe(second.ranker);
    expect(first.deduplicator).not.toBe(second.deduplicator);
    expect(first.compressor).not.toBe(second.compressor);
    expect(first.assembler).not.toBe(second.assembler);
    expect(first.promptBuilder).not.toBe(second.promptBuilder);
  });
});

describe("createContextEngine dependency injection", () => {
  it("forwards the memory service through the graph", async () => {
    const memoryService = makeMemoryService();
    const engine = createContextEngine({ memoryService });
    await engine.buildPrompt(basePromptOptions);
    expect(memoryService.retrieveRelevantMemory).toHaveBeenCalled();
  });

  it("forwards the gmail service through the graph", async () => {
    const gmailService = makeGmailService();
    const engine = createContextEngine({ gmailService });
    await engine.buildPrompt(basePromptOptions);
    expect(gmailService.retrieveRelevantEmails).toHaveBeenCalled();
  });

  it("forwards the calendar service through the graph", async () => {
    const calendarService = makeCalendarService();
    const engine = createContextEngine({ calendarService });
    await engine.buildPrompt(basePromptOptions);
    expect(calendarService.retrieveRelevantEvents).toHaveBeenCalled();
  });

  it("forwards the github service through the graph", async () => {
    const githubService = makeGithubService();
    const engine = createContextEngine({ githubService });
    await engine.buildPrompt(basePromptOptions);
    expect(githubService.retrieveRelevantItems).toHaveBeenCalled();
  });

  it("forwards the drive service through the graph", async () => {
    const driveService = makeDriveService();
    const engine = createContextEngine({ driveService });
    await engine.buildPrompt(basePromptOptions);
    expect(driveService.retrieveRelevantFiles).toHaveBeenCalled();
  });
});

describe("createContextEngine partial combinations", () => {
  it("works with only memory", async () => {
    const memoryService = makeMemoryService();
    const engine = createContextEngine({ memoryService });
    expect(builderSourceIds(engine)).toEqual(["memory"]);
    const prompt = await engine.buildPrompt(basePromptOptions);
    expect(prompt).toContain("Remembered fact");
  });

  it("works with only gmail", async () => {
    const gmailService = makeGmailService();
    const engine = createContextEngine({ gmailService });
    expect(builderSourceIds(engine)).toEqual(["gmail"]);
    const prompt = await engine.buildPrompt(basePromptOptions);
    expect(prompt).toContain("Email body");
  });

  it("works with only calendar", async () => {
    const calendarService = makeCalendarService();
    const engine = createContextEngine({ calendarService });
    expect(builderSourceIds(engine)).toEqual(["calendar"]);
    const prompt = await engine.buildPrompt(basePromptOptions);
    expect(prompt).toContain("Meeting description");
  });

  it("works with only github", async () => {
    const githubService = makeGithubService();
    const engine = createContextEngine({ githubService });
    expect(builderSourceIds(engine)).toEqual(["github"]);
    const prompt = await engine.buildPrompt(basePromptOptions);
    expect(prompt).toContain("GitHub issue body");
  });

  it("works with only drive", async () => {
    const driveService = makeDriveService();
    const engine = createContextEngine({ driveService });
    expect(builderSourceIds(engine)).toEqual(["drive"]);
    const prompt = await engine.buildPrompt(basePromptOptions);
    expect(prompt).toContain("Drive file content");
  });
});

describe("createContextEngine determinism", () => {
  it("creates equivalent graphs and prompts for identical inputs", async () => {
    const memoryService = makeMemoryService();
    const engineA = createContextEngine({ memoryService });
    const engineB = createContextEngine({ memoryService });
    expect(builderSourceIds(engineA)).toEqual(builderSourceIds(engineB));

    const promptA = await engineA.buildPrompt(basePromptOptions);
    const promptB = await engineB.buildPrompt(basePromptOptions);
    expect(promptB).toBe(promptA);
  });
});

describe("createContextEngine immutability", () => {
  it("does not mutate the options object", () => {
    const memoryService = makeMemoryService();
    const gmailService = makeGmailService();
    const options = { memoryService, gmailService };
    createContextEngine(options);
    expect(options).toEqual({ memoryService, gmailService });
    expect(options.memoryService).toBe(memoryService);
    expect(options.gmailService).toBe(gmailService);
  });

  it("does not mutate the injected services", () => {
    const memoryService = makeMemoryService();
    createContextEngine({ memoryService });
    expect(memoryService).toBeDefined();
    expect(memoryService.isAvailable).not.toHaveBeenCalled();
    expect(memoryService.retrieveRelevantMemory).not.toHaveBeenCalled();
  });
});

describe("createContextEngine no runtime work", () => {
  it("never invokes any service retrieval at construction", () => {
    const memoryService = makeMemoryService();
    const gmailService = makeGmailService();
    createContextEngine({ memoryService, gmailService });
    expect(memoryService.isAvailable).not.toHaveBeenCalled();
    expect(memoryService.retrieveRelevantMemory).not.toHaveBeenCalled();
    expect(gmailService.isAvailable).not.toHaveBeenCalled();
    expect(gmailService.retrieveRelevantEmails).not.toHaveBeenCalled();
  });

  it("never invokes pipeline logic at construction", () => {
    const buildSpy = vi.spyOn(ContextBuilder.prototype, "build");
    const rankSpy = vi.spyOn(ContextRanker.prototype, "rank");
    const dedupSpy = vi.spyOn(ContextDeduplicator.prototype, "deduplicate");
    const compressSpy = vi.spyOn(ContextCompressor.prototype, "compress");
    const assembleSpy = vi.spyOn(ContextAssembler.prototype, "assemble");
    const promptBuildSpy = vi.spyOn(PromptBuilder.prototype, "build");
    const engineBuildPromptSpy = vi.spyOn(ContextEngine.prototype, "buildPrompt");

    createContextEngine({ memoryService: makeMemoryService() });

    expect(buildSpy).not.toHaveBeenCalled();
    expect(rankSpy).not.toHaveBeenCalled();
    expect(dedupSpy).not.toHaveBeenCalled();
    expect(compressSpy).not.toHaveBeenCalled();
    expect(assembleSpy).not.toHaveBeenCalled();
    expect(promptBuildSpy).not.toHaveBeenCalled();
    expect(engineBuildPromptSpy).not.toHaveBeenCalled();
  });
});

describe("createContextEngine edge cases", () => {
  it("handles empty services (no sources, no errors)", async () => {
    const engine = createContextEngine({});
    const prompt = await engine.buildPrompt(basePromptOptions);
    // The assembler renders the empty-input placeholder for zero contexts.
    expect(prompt).toContain("(No context available)");
  });

  it("supports many sequential creations with fresh instances", () => {
    const engines = Array.from({ length: 50 }, () => createContextEngine());
    expect(engines).toHaveLength(50);
    expect(new Set(engines).size).toBe(50);
  });
});
