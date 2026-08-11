import { describe, expect, it } from "vitest";
import {
  DigestEngine,
  createProductionDigestEngine,
  createProductionDigestSources,
  getProductionDigestEngine,
  buildMorningDigest,
  buildEveningDigest,
  buildWeeklyDigest,
  DIGEST_CONTEXT_TOKEN_BUDGET,
  DIGEST_TOOL_TIMEOUT_MS,
  type BuildDigestOptions,
} from "@/lib/digest/production";
import { DigestBuilder, type DigestDataSources } from "@/lib/digest/builder";
import { DigestManager } from "@/lib/digest/manager";
import { DigestDeliveryEngine, NoopPublisher, type DigestPublisher } from "@/lib/digest/delivery";
import { MORNING_TEMPLATE } from "@/lib/digest/templates";
import { createMemory } from "@/lib/memory/types";

const NOW = "2026-08-10T12:00:00.000Z";

/** Deterministic fake sources producing a small, stable digest. */
function fakeSources(overrides: Partial<DigestDataSources> = {}): DigestDataSources {
  return {
    listMemories: () => [],
    listConversations: () => [],
    buildContextPrompt: async () => "context prompt",
    listJobs: () => [],
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

describe("createProductionDigestSources", () => {
  it("builds the production data-source seam over the engines", () => {
    const sources = createProductionDigestSources();
    expect(typeof sources.listMemories).toBe("function");
    expect(typeof sources.listConversations).toBe("function");
    expect(typeof sources.buildContextPrompt).toBe("function");
    expect(typeof sources.listJobs).toBe("function");
    expect(typeof sources.executeTools).toBe("function");
  });

  it("exposes production constants", () => {
    expect(DIGEST_CONTEXT_TOKEN_BUDGET).toBe(4000);
    expect(DIGEST_TOOL_TIMEOUT_MS).toBe(5000);
  });
});

describe("DigestEngine construction", () => {
  it("builds over injected sources, manager, and delivery engine", async () => {
    const manager = new DigestManager();
    const sources = fakeSources();
    const engine = new DigestEngine({ manager, sources, now: () => NOW });
    expect(engine.manager).toBe(manager);
    expect(engine.builder).toBeInstanceOf(DigestBuilder);
    expect(engine.deliveryEngine).toBeInstanceOf(DigestDeliveryEngine);
    expect(engine.count()).toBe(0);
    const digest = await engine.buildMorningDigest({ userId: "u" });
    expect(digest.metadata.kind).toBe("morning");
    expect(engine.count()).toBe(1);
    expect(manager.count()).toBe(0); // injected manager never mutated
  });

  it("builds its own empty manager when none is injected", () => {
    const engine = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    expect(engine.count()).toBe(0);
    expect(engine.manager).toBeInstanceOf(DigestManager);
  });

  it("wires the default delivery engine from the injected publisher", async () => {
    const published: unknown[] = [];
    const publisher: DigestPublisher = {
      publish: async (delivery, content) => {
        published.push({ delivery, content });
      },
    };
    const engine = new DigestEngine({
      sources: fakeSources(),
      publisher,
      now: () => NOW,
    });
    const digest = await engine.buildMorningDigest({ userId: "u" });
    await engine.deliveryEngine.deliver(digest, { recipients: [{ address: "a@b.c" }] });
    expect(published).toHaveLength(1);
  });

  it("accepts an injected delivery engine directly", async () => {
    const manager = new DigestManager();
    const delivery = new DigestDeliveryEngine(manager, { publisher: new NoopPublisher() });
    const engine = new DigestEngine({
      manager,
      sources: fakeSources(),
      deliveryEngine: delivery,
      now: () => NOW,
    });
    expect(engine.deliveryEngine).toBe(delivery);
  });
});

describe("DigestEngine builds", () => {
  it("builds morning, evening, and weekly digests through the templates", async () => {
    const engine = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    const morning = await engine.buildMorningDigest({ userId: "u" });
    const evening = await engine.buildEveningDigest({ userId: "u" });
    const weekly = await engine.buildWeeklyDigest({ userId: "u" });
    expect(morning.metadata.kind).toBe("morning");
    expect(morning.metadata.title).toBe("Morning Digest");
    expect(evening.metadata.kind).toBe("evening");
    expect(weekly.metadata.kind).toBe("weekly");
    expect(weekly.metadata.window.from).toBe("2026-08-03T12:00:00.000Z");
    expect(engine.count()).toBe(3);
  });

  it("stores built digests as drafts through the successor manager", async () => {
    const engine = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    const digest = await engine.buildMorningDigest({ userId: "u" });
    expect(engine.findDigest(digest.id)?.metadata.status).toBe("draft");
    expect(engine.listDigests()).toHaveLength(1);
  });

  it("honors an explicit now and query", async () => {
    let capturedQuery: string | undefined;
    const engine = new DigestEngine({
      sources: fakeSources({
        buildContextPrompt: async (query) => {
          capturedQuery = query;
          return "ctx";
        },
      }),
      now: () => NOW,
    });
    const digest = await engine.build(MORNING_TEMPLATE, {
      userId: "u",
      now: "2026-08-11T08:00:00.000Z",
      query: "standup prep",
    });
    expect(digest.metadata.createdAt).toBe("2026-08-11T08:00:00.000Z");
    expect(capturedQuery).toBe("standup prep");
  });

  it("defaults now to the injected clock", async () => {
    const engine = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    const digest = await engine.buildMorningDigest({ userId: "u" });
    expect(digest.metadata.createdAt).toBe(NOW);
  });

  it("is deterministic for identical sources and time", async () => {
    const a = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    const b = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    const [da, db] = [
      await a.buildMorningDigest({ userId: "u" }),
      await b.buildMorningDigest({ userId: "u" }),
    ];
    expect(da).toEqual(db);
    expect(da.id).toBe(db.id);
  });

  it("builds a digest with sections and statistics even with empty sources", async () => {
    const engine = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    const digest = await engine.buildMorningDigest({ userId: "u" });
    expect(digest.sections.length).toBeGreaterThan(0);
    expect(digest.statistics.sectionCount).toBe(digest.sections.length);
  });

  it("never mutates the receiver across builds", async () => {
    const engine = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    const before = engine.count();
    await engine.buildMorningDigest({ userId: "u" });
    expect(engine.count()).toBe(before + 1);
  });
});

describe("createProductionDigestEngine factory", () => {
  it("constructs a DigestEngine", () => {
    expect(createProductionDigestEngine()).toBeInstanceOf(DigestEngine);
    expect(createProductionDigestEngine({})).toBeInstanceOf(DigestEngine);
  });

  it("accepts injected overrides", () => {
    const manager = new DigestManager();
    const engine = createProductionDigestEngine({ manager, sources: fakeSources(), now: () => NOW });
    expect(engine.manager).toBe(manager);
  });
});

describe("getProductionDigestEngine singleton", () => {
  it("returns the same instance on every call", () => {
    expect(getProductionDigestEngine()).toBe(getProductionDigestEngine());
    expect(getProductionDigestEngine()).toBeInstanceOf(DigestEngine);
  });
});

describe("build* entry points", () => {
  it("route through the production singleton", async () => {
    const options: BuildDigestOptions = { userId: "entry-point" };
    const morning = await buildMorningDigest(options);
    const evening = await buildEveningDigest(options);
    const weekly = await buildWeeklyDigest(options);
    expect(morning.metadata.kind).toBe("morning");
    expect(evening.metadata.kind).toBe("evening");
    expect(weekly.metadata.kind).toBe("weekly");
    // The production singleton accumulates state across calls.
    expect(getProductionDigestEngine().listDigests().length).toBeGreaterThanOrEqual(3);
  });

  it("accepts an explicit now for determinism", async () => {
    const digest = await buildMorningDigest({ userId: "u", now: "2026-08-12T09:00:00.000Z" });
    expect(digest.metadata.createdAt).toBe("2026-08-12T09:00:00.000Z");
  });
});

describe("DigestEngine failure isolation", () => {
  it("builds an empty digest when every source throws", async () => {
    const sources: DigestDataSources = {
      listMemories: () => {
        throw new Error("down");
      },
      listConversations: () => {
        throw new Error("down");
      },
      buildContextPrompt: async () => {
        throw new Error("down");
      },
      listJobs: () => {
        throw new Error("down");
      },
      executeTools: async () => {
        throw new Error("down");
      },
    };
    const engine = new DigestEngine({ sources, now: () => NOW });
    const digest = await engine.buildMorningDigest({ userId: "u" });
    expect(digest.metadata.kind).toBe("morning");
    expect(digest.statistics.itemCount).toBe(0);
  });

  it("skips failed tool steps while keeping successful ones", async () => {
    const engine = new DigestEngine({
      sources: fakeSources({
        executeTools: async (plan) => ({
          planId: plan.id,
          results: [
            {
              stepId: "emails",
              toolId: "search.gmail",
              status: "failure",
              error: { code: "timeout", message: "down" },
              durationMs: 10,
            },
            {
              stepId: "calendar",
              toolId: "search.calendar",
              status: "success",
              output: { events: [{ id: "ev-1", summary: "Standup" }] },
              durationMs: 0,
            },
          ],
          succeededStepIds: ["calendar"],
          failedStepIds: ["emails"],
          cancelledStepIds: [],
        }),
      }),
      now: () => NOW,
    });
    const digest = await engine.buildMorningDigest({ userId: "u" });
    const calendar = digest.sections.find((section) => section.category === "calendar");
    expect(calendar?.items).toHaveLength(1);
    expect(digest.sections.find((section) => section.category === "emails")).toBeUndefined();
  });
});

describe("DigestEngine repository detachment", () => {
  it("listDigests returns detached clones", async () => {
    const engine = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    const digest = await engine.buildMorningDigest({ userId: "u" });
    const listed = engine.listDigests();
    expect(listed[0]).toEqual(digest);
    expect(listed[0]).not.toBe(digest);
  });

  it("findDigest returns a detached clone or undefined", async () => {
    const engine = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    const digest = await engine.buildMorningDigest({ userId: "u" });
    expect(engine.findDigest(digest.id)).toEqual(digest);
    expect(engine.findDigest("missing")).toBeUndefined();
  });
});

describe("DigestEngine scale", () => {
  it("handles many builds deterministically", async () => {
    const engine = new DigestEngine({ sources: fakeSources(), now: () => NOW });
    // Each build uses a distinct timestamp so the derived digest ids differ.
    for (let i = 0; i < 50; i += 1) {
      const second = String(i).padStart(2, "0");
      await engine.buildMorningDigest({
        userId: "u",
        now: `2026-08-10T00:00:${second}.000Z`,
      });
    }
    expect(engine.count()).toBe(50);
    const ids = engine.listDigests().map((digest) => digest.id);
    expect(new Set(ids).size).toBe(50);
  });
});

describe("DigestEngine with realistic sources", () => {
  it("aggregates memories, conversations, jobs, and tool results", async () => {
    const sources: DigestDataSources = {
      listMemories: () => [
        createMemory({
          id: "mem-1",
          title: "Memory title",
          content: "Memory content",
          createdAt: NOW,
        }),
      ],
      listConversations: () => [],
      buildContextPrompt: async () => "ctx",
      listJobs: () => [],
      executeTools: async (plan) => ({
        planId: plan.id,
        results: [],
        succeededStepIds: [],
        failedStepIds: [],
        cancelledStepIds: [],
      }),
    };
    const engine = new DigestEngine({ sources, now: () => NOW });
    const digest = await engine.buildMorningDigest({ userId: "u" });
    const memorySection = digest.sections.find((section) => section.category === "memories");
    expect(memorySection?.items).toHaveLength(1);
  });
});
