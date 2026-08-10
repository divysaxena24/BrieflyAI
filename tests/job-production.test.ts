import { describe, it, expect } from "vitest";
import {
  JobEngine,
  createProductionJobEngine,
  getProductionJobEngine,
  runBackgroundJobs,
  createBackgroundDigestHandler,
  buildDigest,
  createDigestJobInput,
  createProductionJobTools,
  BackgroundGatherTool,
  BackgroundRecordTool,
  DIGEST_JOB_ID,
  DIGEST_JOB_NAME,
  DIGEST_SCHEDULE_INTERVAL_MS,
  DIGEST_USER_ID,
  BG_GATHER_TOOL_ID,
  BG_RECORD_TOOL_ID,
  type BackgroundDigest,
} from "@/lib/jobs/production";
import { getProductionContextEngine } from "@/lib/context/production";
import type { ContextEngine } from "@/lib/context/engine";
import { JobHandlerRegistry, type JobHandler } from "@/lib/jobs/executor";
import { JobManager } from "@/lib/jobs/manager";
import { createJob } from "@/lib/jobs/types";
import { createMemory, type CreateMemoryInput, type Memory } from "@/lib/memory/types";
import { MemoryRepository } from "@/lib/memory/repository";
import { MemoryEngine, createProductionMemoryEngine } from "@/lib/memory/production";
import { ConversationEngine, createProductionConversationEngine } from "@/lib/conversation/production";

// ──────────────────────────────────────────────
//  Fixtures
// ──────────────────────────────────────────────

const NOW = "2026-08-10T10:00:00.000Z";

/** Deterministic stub Context Engine — never touches production services. */
const stubContextEngine = {
  buildPrompt: async (): Promise<string> => "MOCK CONTEXT PROMPT",
} as unknown as ContextEngine;

function makeEngine(overrides: {
  memory?: MemoryEngine;
  conversation?: ConversationEngine;
  seedDigestJob?: boolean;
  manager?: JobManager;
} = {}): JobEngine {
  return createProductionJobEngine({
    contextEngine: stubContextEngine,
    now: () => NOW,
    memoryEngine: overrides.memory,
    conversationEngine: overrides.conversation,
    seedDigestJob: overrides.seedDigestJob,
    manager: overrides.manager,
  });
}

function makeMemory(id: string, overrides: Partial<CreateMemoryInput> = {}): Memory {
  return createMemory({
    id,
    title: `Memory ${id}`,
    content: "Some content",
    createdAt: NOW,
    ...overrides,
  });
}

// ──────────────────────────────────────────────
//  Factory and seeding
// ──────────────────────────────────────────────

describe("createProductionJobEngine", () => {
  it("builds a JobEngine", () => {
    expect(createProductionJobEngine()).toBeInstanceOf(JobEngine);
  });

  it("seeds the recurring digest job by default", () => {
    const engine = makeEngine();
    const digest = engine.digestJob();
    expect(digest).toBeDefined();
    expect(digest?.id).toBe(DIGEST_JOB_ID);
    expect(digest?.name).toBe(DIGEST_JOB_NAME);
    expect(digest?.trigger).toBe("recurring");
    expect(digest?.schedule?.everyMs).toBe(DIGEST_SCHEDULE_INTERVAL_MS);
    expect(digest?.status).toBe("pending");
  });

  it("does not seed the digest job when seedDigestJob is false", () => {
    const engine = makeEngine({ seedDigestJob: false });
    expect(engine.count()).toBe(0);
    expect(engine.digestJob()).toBeUndefined();
  });

  it("returns fresh independent engines from the factory", () => {
    const a = makeEngine();
    const b = makeEngine();
    expect(a).not.toBe(b);
    expect(a).not.toBe(getProductionJobEngine());
  });

  it("returns the same singleton from getProductionJobEngine", () => {
    expect(getProductionJobEngine()).toBe(getProductionJobEngine());
  });

  it("reuses the production Context Engine singleton by default", () => {
    const engine = createProductionJobEngine({ now: () => NOW });
    expect(engine.contextEngine).toBe(getProductionContextEngine());
  });
});

// ──────────────────────────────────────────────
//  Digest job execution through the engine
// ──────────────────────────────────────────────

describe("digest execution through the engine", () => {
  it("runs the digest job once and re-arms it", async () => {
    const engine = makeEngine();
    const summary = await engine.run({ now: NOW });
    expect(summary.total).toBe(1);
    expect(summary.completed).toBe(1);
    const digest = engine.digestJob();
    expect(digest?.status).toBe("pending");
    expect(digest?.scheduledAt).toBe("2026-08-10T11:00:00.000Z");
    expect(digest?.attempts).toBe(1);
  });

  it("does not re-run the digest job before its next occurrence", async () => {
    const engine = makeEngine();
    await engine.run({ now: NOW });
    const summary = await engine.run({ now: "2026-08-10T10:30:00.000Z" });
    expect(summary.total).toBe(0);
  });

  it("stores a derived memory through the record tool", async () => {
    const engine = makeEngine();
    await engine.run({ now: NOW });
    expect(engine.memoryCount()).toBe(1);
    const stored = engine.listStoredMemories()[0];
    expect(stored.metadata.kind).toBe("context");
    expect(stored.metadata.source).toBe("derived");
    expect(stored.metadata.title).toBe("Background digest");
    expect(stored.content).toContain("No LLM invoked");
  });

  it("returns a structured BackgroundDigest as the job output", async () => {
    const engine = makeEngine();
    const summary = await engine.run({ now: NOW });
    const output = summary.executed[0].output as BackgroundDigest;
    expect(output.id).toMatch(/^digest-[0-9a-f]{8}$/);
    expect(output.userId).toBe(DIGEST_USER_ID);
    expect(output.createdAt).toBe(NOW);
    expect(output.sourceCount).toBe(4);
    expect(output.memoryCount).toBe(0);
    expect(output.contextPromptLength).toBe("MOCK CONTEXT PROMPT".length);
    expect(output.summary).toContain("gathered 4 context sources");
  });

  it("consults existing memories in the digest", async () => {
    const memoryEngine = createProductionMemoryEngine(new MemoryRepository([makeMemory("m1")]));
    const engine = makeEngine({ memory: memoryEngine });
    const summary = await engine.run({ now: NOW });
    const output = summary.executed[0].output as BackgroundDigest;
    expect(output.memoryCount).toBe(1);
    expect(engine.memoryCount()).toBe(2); // 1 seeded + 1 stored by the digest
  });

  it("updates conversation context when a conversation exists", async () => {
    let conversationEngine = createProductionConversationEngine();
    conversationEngine = conversationEngine.startConversation({
      id: "conv-1",
      createdAt: NOW,
    }).engine;
    const engine = makeEngine({ conversation: conversationEngine });
    await engine.run({ now: NOW });
    expect(engine.conversationCount()).toBe(1);
    const conversation = engine.listConversations()[0];
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0].role).toBe("system");
    expect(conversation.messages[0].content).toContain("Background digest");
  });

  it("is idempotent across repeated executions at the same time", async () => {
    const engine = makeEngine({ seedDigestJob: false });
    const handler = createBackgroundDigestHandler({
      contextEngine: stubContextEngine,
      toolExecutor: engine.toolExecutor,
      listMemories: () => engine.listStoredMemories(),
      listConversations: () => engine.listConversations(),
      appendConversationMessage: () => undefined,
    });
    const context = {
      job: createJob({ id: DIGEST_JOB_ID, name: DIGEST_JOB_NAME, createdAt: NOW }),
      attempt: 1,
      now: NOW,
    };
    const first = (await handler(context)) as BackgroundDigest;
    const second = (await handler(context)) as BackgroundDigest;
    expect(first.id).toBe(second.id);
    expect(engine.memoryCount()).toBe(1);
  });

  it("runs through runOnce, runScheduled, and runManual passthroughs", async () => {
    const okHandler: JobHandler = async () => ({ ok: true });
    let manager = new JobManager();
    manager = manager.registerJob({
      id: "manual-1",
      name: "Manual",
      trigger: "manual",
      createdAt: NOW,
    }).manager;
    const handlerRegistry = new JobHandlerRegistry([{ id: "manual-1", handler: okHandler }]);
    const withManual = createProductionJobEngine({
      contextEngine: stubContextEngine,
      now: () => NOW,
      manager,
      seedDigestJob: false,
      handlerRegistry,
    });
    const manualSummary = await withManual.runManual({ jobId: "manual-1" }, NOW);
    expect(manualSummary.total).toBe(1);
    expect(manualSummary.completed).toBe(1);
    expect(withManual.manager.find("manual-1")?.status).toBe("completed");
    const scheduledSummary = await withManual.runScheduled(NOW);
    expect(scheduledSummary.total).toBe(0);
    const onceSummary = await withManual.runOnce(NOW);
    expect(onceSummary.total).toBe(0);
  });

  it("isolates a failing unrelated job from the digest", async () => {
    let manager = new JobManager();
    manager = manager.registerJob({
      id: "no-handler",
      name: "No handler",
      trigger: "manual",
      createdAt: NOW,
    }).manager;
    const engine = makeEngine({ manager, seedDigestJob: true });
    const summary = await engine.run({ now: NOW });
    expect(summary.total).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(1);
  });
});

// ──────────────────────────────────────────────
//  buildDigest
// ──────────────────────────────────────────────

describe("buildDigest", () => {
  it("builds a deterministic structured digest", () => {
    const first = buildDigest({ userId: "u1", now: NOW, sourceCount: 4, memoryCount: 2, contextPrompt: "abc" });
    const second = buildDigest({ userId: "u1", now: NOW, sourceCount: 4, memoryCount: 2, contextPrompt: "abc" });
    expect(first).toEqual(second);
    expect(first.id).toMatch(/^digest-[0-9a-f]{8}$/);
    expect(first.summary).toContain("gathered 4 context sources");
    expect(first.summary).toContain("consulted 2 memories");
    expect(first.contextPromptLength).toBe(3);
  });

  it("differs across times and users", () => {
    const a = buildDigest({ userId: "u1", now: NOW, sourceCount: 4, memoryCount: 0, contextPrompt: "" });
    const b = buildDigest({ userId: "u1", now: "2026-08-11T10:00:00.000Z", sourceCount: 4, memoryCount: 0, contextPrompt: "" });
    const c = buildDigest({ userId: "u2", now: NOW, sourceCount: 4, memoryCount: 0, contextPrompt: "" });
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });
});

// ──────────────────────────────────────────────
//  Background tools
// ──────────────────────────────────────────────

describe("background tools", () => {
  it("createProductionJobTools builds a registry with both tools", () => {
    const registry = createProductionJobTools();
    expect(registry.has(BG_GATHER_TOOL_ID)).toBe(true);
    expect(registry.has(BG_RECORD_TOOL_ID)).toBe(true);
    expect(registry.list()).toHaveLength(2);
  });

  it("gather tool passes its signals through", async () => {
    const tool = new BackgroundGatherTool();
    const output = await tool.execute({ sourceCount: 2, memoryCount: 3, contextPromptLength: 4 });
    expect(output).toEqual({ sourceCount: 2, memoryCount: 3, contextPromptLength: 4 });
  });

  it("record tool stores a derived memory through the injected closure", async () => {
    let stored: Memory | undefined;
    const tool = new BackgroundRecordTool((input) => {
      stored = createMemory(input);
      return stored;
    });
    const memory = await tool.execute({
      memoryId: "mem-digest-abc",
      title: "Background digest",
      content: "summary",
      createdAt: NOW,
    });
    expect(stored?.id).toBe("mem-digest-abc");
    expect(stored?.metadata.kind).toBe("context");
    expect(stored?.metadata.source).toBe("derived");
    expect(memory).toBe(stored);
  });

  it("record tool isolates a missing store into an error", async () => {
    const tool = new BackgroundRecordTool();
    await expect(
      tool.execute({ memoryId: "m", title: "t", content: "c", createdAt: NOW }),
    ).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────
//  createDigestJobInput
// ──────────────────────────────────────────────

describe("createDigestJobInput", () => {
  it("builds a recurring digest job at the given time with the stable id", () => {
    const input = createDigestJobInput(NOW);
    expect(input.id).toBe(DIGEST_JOB_ID);
    expect(input.name).toBe(DIGEST_JOB_NAME);
    expect(input.trigger).toBe("recurring");
    expect(input.schedule?.everyMs).toBe(DIGEST_SCHEDULE_INTERVAL_MS);
    expect(input.scheduledAt).toBe(NOW);
    expect(input.maxAttempts).toBe(2);
  });

  it("is deterministic for the same time", () => {
    const job = createJob(createDigestJobInput(NOW));
    const again = createJob(createDigestJobInput(NOW));
    expect(job).toEqual(again);
  });

  it("keeps the stable id across times (only timestamps differ)", () => {
    const job = createJob(createDigestJobInput(NOW));
    const later = createJob(createDigestJobInput("2026-08-11T10:00:00.000Z"));
    expect(job.id).toBe(later.id);
    expect(job.scheduledAt).not.toBe(later.scheduledAt);
  });
});

// ──────────────────────────────────────────────
//  Determinism
// ──────────────────────────────────────────────

describe("determinism", () => {
  it("identical engines produce identical run summaries", async () => {
    const run = async (): Promise<unknown> => {
      const engine = makeEngine();
      const summary = await engine.run({ now: NOW });
      return summary.executed.map((result) => [result.reference.jobId, result.status]);
    };
    expect(await run()).toEqual(await run());
  });

  it("never mutates the seeded digest job through reads", () => {
    const engine = makeEngine();
    const before = engine.listStoredMemories();
    void engine.digestJob();
    expect(engine.listStoredMemories()).toEqual(before);
  });
});

// ──────────────────────────────────────────────
//  runBackgroundJobs
// ──────────────────────────────────────────────

describe("runBackgroundJobs", () => {
  it("runs through the production singleton and returns a summary", async () => {
    // The singleton seeds the digest at module load; a far-future `now` is
    // guaranteed to be at/after its first scheduled occurrence.
    const summary = await runBackgroundJobs({ now: "2030-01-01T00:00:00.000Z" });
    expect(summary.total).toBeGreaterThanOrEqual(1);
    expect(summary.completed).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────
//  createBackgroundDigestHandler
// ──────────────────────────────────────────────

describe("createBackgroundDigestHandler", () => {
  it("produces a BackgroundDigest from the injected dependencies", async () => {
    let appended = 0;
    const handler = createBackgroundDigestHandler({
      contextEngine: stubContextEngine,
      toolExecutor: makeEngine().toolExecutor,
      listMemories: () => [],
      listConversations: () => [],
      appendConversationMessage: () => {
        appended += 1;
      },
    });
    const output = (await handler({ job: createJob({ id: "j", name: "j", createdAt: NOW }), attempt: 1, now: NOW })) as BackgroundDigest;
    expect(output.userId).toBe(DIGEST_USER_ID);
    expect(output.sourceCount).toBe(4);
    expect(appended).toBe(0);
  });
});


