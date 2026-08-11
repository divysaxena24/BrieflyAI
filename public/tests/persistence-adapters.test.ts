/**
 * Phase 5J STEP 2 — engine persistence adapter tests.
 */
import { describe, expect, it } from "vitest";
import {
  actionAdapter,
  conversationAdapter,
  ALL_ADAPTERS,
  adapterFor,
  digestAdapter,
  jobAdapter,
  memoryAdapter,
  workflowAdapter,
} from "@/lib/persistence/adapters";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import { createProductionActionEngine } from "@/lib/actions/production";
import { createProductionWorkflowEngine } from "@/lib/workflows/production";
import { createAction } from "@/lib/actions/types";
import { ActionManager } from "@/lib/actions/manager";
import { ActionRepository } from "@/lib/actions/repository";
import { createWorkflow, createWorkflowStep } from "@/lib/workflows/types";
import { WorkflowManager } from "@/lib/workflows/manager";
import { WorkflowRepository } from "@/lib/workflows/repository";

const NOW = "2026-08-10T08:00:00.000Z";

describe("memoryAdapter", () => {
  it("snapshots the engine's memories as detached clones", () => {
    let engine = createProductionMemoryEngine();
    engine = engine.remember({
      id: "mem-1",
      title: "First",
      content: "hello",
      createdAt: NOW,
      tags: ["work"],
    }).engine;
    const records = memoryAdapter.snapshot(engine);
    expect(records).toEqual(engine.listMemories());
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("mem-1");
  });

  it("restores a fresh engine over the records (round-trip)", () => {
    const original = createProductionMemoryEngine()
      .remember({ id: "mem-1", title: "A", content: "one", createdAt: NOW })
      .engine.remember({ id: "mem-2", title: "B", content: "two", createdAt: NOW })
      .engine;
    const restored = memoryAdapter.restore(memoryAdapter.snapshot(original));
    expect(restored.listMemories()).toEqual(original.listMemories());
    expect(restored).not.toBe(original);
  });

  it("restoring an empty snapshot yields an empty engine", () => {
    const restored = memoryAdapter.restore([]);
    expect(restored.count()).toBe(0);
  });

  it("is detached: restoring never mutates the input records", () => {
    const engine = createProductionMemoryEngine().remember({
      id: "mem-1",
      title: "A",
      content: "one",
      createdAt: NOW,
    }).engine;
    const records = memoryAdapter.snapshot(engine);
    const restored = memoryAdapter.restore(records);
    expect(records).toHaveLength(1);
    expect(restored.count()).toBe(1);
    // Mutating the snapshot input can never leak into the restored engine.
    (records as { id: string }[]).length = 0;
    expect(restored.count()).toBe(1);
  });
});

describe("conversationAdapter", () => {
  it("round-trips conversations with messages", () => {
    let engine = createProductionConversationEngine();
    engine = engine.startConversation({ id: "conv-1", createdAt: NOW, title: "Chat" }).engine;
    engine = engine.appendMessage("conv-1", { role: "user", content: "hi", createdAt: NOW }).engine;
    const restored = conversationAdapter.restore(conversationAdapter.snapshot(engine));
    expect(restored.listConversations()).toEqual(engine.listConversations());
    expect(restored.getConversation("conv-1")?.messages).toHaveLength(1);
  });

  it("restores an empty conversation engine from []", () => {
    expect(conversationAdapter.restore([]).count()).toBe(0);
  });
});

describe("jobAdapter", () => {
  it("round-trips the production job engine including the seeded digest job", () => {
    const original = createProductionJobEngine();
    const records = jobAdapter.snapshot(original);
    expect(records.some((job) => job.id === "bg-daily-digest")).toBe(true);
    const restored = jobAdapter.restore(records);
    expect(restored.manager.list()).toEqual(original.manager.list());
    // No duplicate digest job was seeded by the restore.
    expect(restored.manager.list().filter((job) => job.id === "bg-daily-digest")).toHaveLength(1);
  });

  it("restores jobs with executions verbatim", () => {
    const registered = createProductionJobEngine().manager.registerJob({
      id: "manual-1",
      name: "Manual",
      trigger: "manual",
      createdAt: NOW,
      scheduledAt: NOW,
    });
    const engine = createProductionJobEngine({
      manager: registered.manager,
      seedDigestJob: false,
    });
    const restored = jobAdapter.restore(jobAdapter.snapshot(engine));
    expect(restored.manager.find("manual-1")).toEqual(engine.manager.find("manual-1"));
  });
});

describe("digestAdapter", () => {
  it("round-trips stored digests", () => {
    const engine = createProductionDigestEngine();
    const { manager } = engine.manager.createDigest({
      id: "digest-1",
      kind: "morning",
      createdAt: NOW,
      window: { from: NOW, to: NOW },
    });
    const seeded = createProductionDigestEngine({ manager });
    const restored = digestAdapter.restore(digestAdapter.snapshot(seeded));
    expect(restored.manager.list()).toEqual(seeded.manager.list());
    expect(restored.findDigest("digest-1")?.metadata.kind).toBe("morning");
  });
});

describe("actionAdapter", () => {
  it("round-trips stored actions", () => {
    const action = createAction({
      id: "action-1",
      name: "Remember",
      type: "create_memory",
      trigger: "intent",
      createdAt: NOW,
      input: { title: "T", content: "C" },
    });
    const { repository } = new ActionRepository().add(action);
    const seeded = createProductionActionEngine({ manager: new ActionManager(repository) });
    const restored = actionAdapter.restore(actionAdapter.snapshot(seeded));
    expect(restored.manager.list()).toEqual(seeded.manager.list());
    expect(restored.findAction("action-1")?.type).toBe("create_memory");
  });
});

describe("workflowAdapter", () => {
  it("round-trips stored workflows with steps", () => {
    const step = createWorkflowStep({
      id: "step-1",
      name: "Run job",
      action: { kind: "job", jobId: "bg-daily-digest" },
    });
    const workflow = createWorkflow({
      id: "workflow-1",
      name: "On memory",
      trigger: { kind: "memory" },
      steps: [step],
      createdAt: NOW,
    });
    const { repository } = new WorkflowRepository().add(workflow);
    const seeded = createProductionWorkflowEngine({ manager: new WorkflowManager(repository) });
    const restored = workflowAdapter.restore(workflowAdapter.snapshot(seeded));
    expect(restored.manager.list()).toEqual(seeded.manager.list());
    expect(restored.findWorkflow("workflow-1")?.steps[0]?.name).toBe("Run job");
  });
});

describe("ALL_ADAPTERS / adapterFor", () => {
  it("covers every collection kind exactly once in canonical order", () => {
    expect(ALL_ADAPTERS.map((adapter) => adapter.kind)).toEqual([
      "memory",
      "conversation",
      "job",
      "digest",
      "action",
      "workflow",
    ]);
  });

  it("looks up adapters by kind", () => {
    expect(adapterFor("digest").kind).toBe("digest");
    expect(adapterFor("memory").codec.version).toBe(1);
  });

  it("throws for unknown kinds", () => {
    expect(() => adapterFor("bogus" as "memory")).toThrow(/No persistence adapter/);
  });
});
