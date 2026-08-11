import { describe, expect, it } from "vitest";
import { DigestBuilder, gatherDigestContext, type DigestDataSources } from "@/lib/digest/builder";
import { DigestManager } from "@/lib/digest/manager";
import { DigestRepository } from "@/lib/digest/repository";
import { DigestDeliveryEngine, type DigestPublisher } from "@/lib/digest/delivery";
import {
  createDigestTemplate,
  freezeDigest,
  type Digest,
  type DigestTemplate,
} from "@/lib/digest/types";
import { createMemory } from "@/lib/memory/types";
import { createConversation, createMessage } from "@/lib/conversation/types";
import { createJob } from "@/lib/jobs/types";

const NOW = "2026-08-10T12:00:00.000Z";

/** Store a fully-formed digest through the manager (input projection). */
function storeDigest(manager: DigestManager, digest: Digest) {
  return manager.createDigest({
    kind: digest.metadata.kind,
    title: digest.metadata.title,
    createdAt: digest.metadata.createdAt,
    updatedAt: digest.metadata.updatedAt,
    status: digest.metadata.status,
    read: digest.metadata.read,
    priority: digest.metadata.priority,
    tags: digest.metadata.tags,
    window: digest.metadata.window,
    delivery: digest.metadata.delivery,
    sections: digest.sections,
  });
}

/** A full template covering every content category. */
const FULL_TEMPLATE: DigestTemplate = createDigestTemplate({
  id: "template-full",
  kind: "custom",
  title: "Full Digest",
  windowDays: 1,
  sections: [
    { category: "calendar", title: "Meetings", priority: "high", maxItems: 100 },
    { category: "emails", title: "Emails", priority: "high", maxItems: 100 },
    { category: "github", title: "GitHub", priority: "normal", maxItems: 100 },
    { category: "memories", title: "Memories", priority: "normal", maxItems: 100 },
    { category: "conversation", title: "Conversation", priority: "normal", maxItems: 1 },
    { category: "actions", title: "Actions", priority: "high", maxItems: 100 },
    { category: "files", title: "Files", priority: "normal", maxItems: 100 },
  ],
});

/**
 * Sources backed by large, deterministic datasets: 1000 memories, 1000
 * conversations, 1000 pending jobs, and 1000 messages/events/repositories/
 * files from the tool plan.
 */
function largeSources(): DigestDataSources {
  const memories = Array.from({ length: 1000 }, (_, i) =>
    createMemory({
      id: `mem-${i}`,
      title: `Memory ${i}`,
      content: `Content of memory number ${i}`,
      createdAt: "2026-08-10T00:00:00.000Z",
      importance: i % 3 === 0 ? "high" : "normal",
    }),
  );
  const conversations = Array.from({ length: 1000 }, (_, i) =>
    createConversation({
      id: `conv-${i}`,
      createdAt: `2026-08-10T00:00:00.000Z`,
      title: `Conversation ${i}`,
      messages: [
        createMessage({
          role: "user",
          content: `Message body ${i}`,
          createdAt: `2026-08-10T00:00:00.000Z`,
        }),
      ],
    }),
  );
  const jobs = Array.from({ length: 1000 }, (_, i) =>
    createJob({
      id: `job-${i}`,
      name: `Job ${i}`,
      createdAt: "2026-08-10T00:00:00.000Z",
      status: i % 10 === 0 ? "completed" : "pending",
      priority: i % 5 === 0 ? "high" : "normal",
    }),
  );
  return {
    listMemories: () => memories,
    listConversations: () => conversations,
    buildContextPrompt: async () => "context prompt".repeat(100),
    listJobs: () => jobs,
    executeTools: async (plan) => ({
      planId: plan.id,
      results: plan.steps.map((step) => {
        const make = <T>(idPrefix: string, titleKey: string): T[] =>
          Array.from({ length: 1000 }, (_, i) => ({
            id: `${idPrefix}-${i}`,
            [titleKey]: `${idPrefix} ${i}`,
          })) as unknown as T[];
        switch (step.toolId) {
          case "search.gmail":
            return {
              stepId: step.stepId,
              toolId: step.toolId,
              status: "success",
              output: { messages: make("msg", "subject") },
              durationMs: 0,
            };
          case "search.calendar":
            return {
              stepId: step.stepId,
              toolId: step.toolId,
              status: "success",
              output: { events: make("ev", "summary") },
              durationMs: 0,
            };
          case "search.github":
            return {
              stepId: step.stepId,
              toolId: step.toolId,
              status: "success",
              output: { repositories: make("repo", "fullName") },
              durationMs: 0,
            };
          case "search.drive":
            return {
              stepId: step.stepId,
              toolId: step.toolId,
              status: "success",
              output: { files: make("file", "name") },
              durationMs: 0,
            };
          default:
            return {
              stepId: step.stepId,
              toolId: step.toolId,
              status: "failure",
              error: { code: "unknown_tool", message: "unknown" },
              durationMs: 0,
            };
        }
      }),
      succeededStepIds: plan.steps.map((step) => step.stepId),
      failedStepIds: [],
      cancelledStepIds: [],
    }),
  };
}

describe("Digest E2E — morning digest", () => {
  it("builds a full morning digest from large datasets (gather caps apply)", async () => {
    const builder = new DigestBuilder(largeSources());
    const digest = await builder.build({
      template: FULL_TEMPLATE,
      userId: "user-1",
      now: NOW,
    });
    expect(digest.metadata.kind).toBe("custom");
    // The builder gathers at most 10 items per source by default, so the
    // 1000-item sources are capped per section; every category is present.
    expect(digest.statistics.itemCount).toBeGreaterThan(0);
    const categories = digest.sections.map((section) => section.category);
    expect(categories).toContain("emails");
    expect(categories).toContain("calendar");
    expect(categories).toContain("github");
    expect(categories).toContain("memories");
    expect(categories).toContain("conversation");
    expect(categories).toContain("actions");
    expect(categories).toContain("files");
    expect(categories[categories.length - 1]).toBe("statistics");
    // Per-section caps honored (default gather cap 10; conversation cap 1).
    const calendar = digest.sections.find((s) => s.category === "calendar");
    const conversation = digest.sections.find((s) => s.category === "conversation");
    expect(calendar?.items.length).toBe(10);
    expect(conversation?.items.length).toBe(1);
  });

  it("keeps section order stable and statistics last", async () => {
    const builder = new DigestBuilder(largeSources());
    const digest = await builder.build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const order = digest.sections.map((section) => section.category);
    expect(order.slice(0, -1)).toEqual([
      "calendar",
      "emails",
      "github",
      "memories",
      "conversation",
      "actions",
      "files",
    ]);
    expect(order[order.length - 1]).toBe("statistics");
  });
});

describe("Digest E2E — determinism", () => {
  it("produces identical digests for identical sources and time", async () => {
    const sources = largeSources();
    const a = await new DigestBuilder(sources).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const b = await new DigestBuilder(sources).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces different digests for different times", async () => {
    const a = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const b = await new DigestBuilder(largeSources()).build({
      template: FULL_TEMPLATE,
      userId: "u",
      now: "2026-08-11T12:00:00.000Z",
    });
    expect(a.id).not.toBe(b.id);
    expect(a.metadata.createdAt).not.toBe(b.metadata.createdAt);
  });

  it("item ids are deterministic across runs", async () => {
    const sources = largeSources();
    const a = await new DigestBuilder(sources).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const b = await new DigestBuilder(sources).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const idsA = a.sections.flatMap((section) => section.items.map((item) => item.id));
    const idsB = b.sections.flatMap((section) => section.items.map((item) => item.id));
    expect(idsA).toEqual(idsB);
  });
});

describe("Digest E2E — immutability", () => {
  it("built digests are detached from the source datasets", async () => {
    const memories = [
      createMemory({ id: "mem-1", title: "T", content: "C", createdAt: NOW }),
      createMemory({ id: "mem-2", title: "U", content: "D", createdAt: NOW }),
    ];
    const sources: DigestDataSources = {
      listMemories: () => memories,
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
    const digest = await new DigestBuilder(sources).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const memoryItems = digest.sections.flatMap((s) => s.items).filter((item) => item.source === "memory");
    expect(memoryItems).toHaveLength(2);
    // Mutating the source array after the build never affects the digest.
    memories.length = 0;
    const after = digest.sections.flatMap((s) => s.items).filter((item) => item.source === "memory");
    expect(after).toHaveLength(2);
  });

  it("freezeDigest deep-freezes a built digest", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const frozen = freezeDigest(digest);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.metadata)).toBe(true);
    expect(Object.isFrozen(frozen.sections)).toBe(true);
    expect(Object.isFrozen(frozen.sections[0])).toBe(true);
    expect(Object.isFrozen(frozen.sections[0].items[0])).toBe(true);
    expect(Object.isFrozen(frozen.statistics)).toBe(true);
  });
});

describe("Digest E2E — repository and manager", () => {
  it("stores built digests and queries them back", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const { manager, digest: stored } = storeDigest(new DigestManager(), digest);
    expect(manager.find(stored.id)).toEqual(stored);
    expect(manager.list()).toHaveLength(1);
  });

  it("survives the full lifecycle: draft → published → read → archived", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    let { manager, digest: current } = storeDigest(new DigestManager(), digest);
    ({ manager, digest: current } = manager.publishDigest(current.id, NOW));
    expect(current.metadata.status).toBe("published");
    ({ manager, digest: current } = manager.markRead(current.id, NOW));
    expect(current.metadata.read).toBe(true);
    ({ manager, digest: current } = manager.archiveDigest(current.id, NOW));
    expect(current.metadata.status).toBe("archived");
    expect(manager.find(current.id)?.metadata.status).toBe("archived");
  });

  it("repository returns detached clones after storage", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const repository = new DigestRepository([digest]);
    const stored = repository.find(digest.id);
    expect(stored).not.toBe(digest);
    expect(stored?.sections).not.toBe(digest.sections);
    expect(Object.isFrozen(stored ?? {})).toBe(false);
  });
});

describe("Digest E2E — delivery", () => {
  it("formats, publishes, and records a delivery end-to-end", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const published: string[] = [];
    const publisher: DigestPublisher = {
      publish: async (_delivery, content) => {
        published.push(String(content).slice(0, 20));
      },
    };
    const manager = storeDigest(new DigestManager(), digest).manager;
    const engine = new DigestDeliveryEngine(manager, { publisher, now: () => NOW });
    const { manager: next, result } = await engine.deliver(digest, {
      format: "markdown",
      recipients: [{ address: "user@briefly.ai" }],
    });
    expect(published).toHaveLength(1);
    expect(result.format).toBe("markdown");
    expect(next.find(digest.id)?.metadata.delivery?.recipients[0].address).toBe("user@briefly.ai");
    // Receiver manager unchanged.
    expect(manager.find(digest.id)?.metadata.delivery).toBeUndefined();
  });

  it("renders every format from the same digest", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const engine = new DigestDeliveryEngine(new DigestManager(), { now: () => NOW });
    const markdown = engine.format(digest, "markdown") as string;
    const plain = engine.format(digest, "plain") as string;
    const json = engine.format(digest, "json") as string;
    expect(markdown).toContain("# Full Digest");
    expect(plain).toContain("FULL DIGEST");
    expect(JSON.parse(json).id).toBe(digest.id);
  });
});

describe("Digest E2E — failure isolation", () => {
  it("builds despite a partially failing tool plan", async () => {
    const failing: DigestDataSources = {
      ...largeSources(),
      executeTools: async (plan) => ({
        planId: plan.id,
        results: plan.steps.map((step) =>
          step.toolId === "search.drive"
            ? {
                stepId: step.stepId,
                toolId: step.toolId,
                status: "failure",
                error: { code: "timeout", message: "drive down" },
                durationMs: 10,
              }
            : {
                stepId: step.stepId,
                toolId: step.toolId,
                status: "success",
                output: { messages: [{ id: "m-1", subject: "S", snippet: "Sn" }] },
                durationMs: 0,
              },
        ),
        succeededStepIds: plan.steps.filter((s) => s.toolId !== "search.drive").map((s) => s.stepId),
        failedStepIds: ["files"],
        cancelledStepIds: [],
      }),
    };
    const digest = await new DigestBuilder(failing).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    expect(digest.metadata.kind).toBe("custom");
    expect(digest.sections.find((s) => s.category === "files")).toBeUndefined();
    expect(digest.sections.find((s) => s.category === "emails")).toBeDefined();
  });

  it("builds an empty digest when every source fails", async () => {
    const down: DigestDataSources = {
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
    const digest = await new DigestBuilder(down).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    expect(digest.sections).toHaveLength(1);
    expect(digest.sections[0].category).toBe("statistics");
    expect(digest.statistics.itemCount).toBe(0);
  });
});

describe("Digest E2E — no duplicates", () => {
  it("never emits duplicate sections", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const categories = digest.sections.map((section) => section.category);
    expect(new Set(categories).size).toBe(categories.length);
  });

  it("never emits duplicate items within or across sections", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const ids = digest.sections.flatMap((section) => section.items.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Digest E2E — production composition", () => {
  it("composes builder, manager, and delivery into one engine flow", async () => {
    const builder = new DigestBuilder(largeSources());
    const digest = await builder.build({ template: FULL_TEMPLATE, userId: "user-flow", now: NOW });
    const { manager: storedManager, digest: stored } = storeDigest(new DigestManager(), digest);
    const engine = new DigestDeliveryEngine(storedManager, { now: () => NOW });
    const { manager: deliveredManager } = await engine.deliver(stored, {
      recipients: [{ address: "a@b.c" }],
    });
    const finalDigest = deliveredManager.find(stored.id);
    expect(finalDigest?.metadata.status).toBe("draft");
    expect(finalDigest?.metadata.delivery?.format).toBe("markdown");
    expect(finalDigest?.metadata.delivery?.deliveredAt).toBe(NOW);
  });

  it("keeps every stored digest intact across the flow (no mutation leaks)", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const snapshot = JSON.stringify(digest);
    const manager = new DigestManager();
    const { manager: storedManager, digest: stored } = storeDigest(manager, digest);
    // The successor chain never mutates earlier managers.
    const next = storedManager.markRead(stored.id, NOW).manager;
    next.publishDigest(stored.id, NOW);
    expect(JSON.stringify(storedManager.find(stored.id))).toBe(snapshot);
    expect(JSON.stringify(manager.find(stored.id))).toBeUndefined();
  });
});

describe("Digest E2E — scale with 1000 datasets", () => {
  it("gathers the full 1000-item datasets before capping", async () => {
    const context = await gatherDigestContext(largeSources(), {
      userId: "u",
      now: NOW,
      window: { from: "2026-08-10T00:00:00.000Z", to: NOW },
      query: "digest",
      maxItemsPerSource: 1000,
    });
    // Tool items: 1000 per source × 4 sources, plus 1000 memories, 900
    // pending jobs, and 1 conversation summary — all deduplicated.
    expect(context.items.length).toBeGreaterThan(4000);
    const sources = new Set(context.items.map((item) => item.source));
    for (const source of ["gmail", "calendar", "github", "drive", "memory", "job", "conversation"]) {
      expect(sources.has(source)).toBe(true);
    }
    const ids = context.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builder output stays consistent at scale", async () => {
    const digest = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    // Statistics are consistent with the actual content sections.
    const totalItems = digest.sections.reduce((sum, section) => sum + section.items.length, 0);
    const statsItems = digest.sections.find((s) => s.category === "statistics")?.items.length ?? 0;
    expect(digest.statistics.itemCount).toBe(totalItems - statsItems);
    const ids = digest.sections.flatMap((s) => s.items.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("produces the same digest twice at scale", async () => {
    const a = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    const b = await new DigestBuilder(largeSources()).build({ template: FULL_TEMPLATE, userId: "u", now: NOW });
    expect(a).toEqual(b);
  });
});
