/**
 * Phase 5J STEP 3 — persistence production composition tests.
 */
import { describe, expect, it } from "vitest";
import {
  PersistenceEngine,
  createProductionPersistence,
  getProductionPersistence,
} from "@/lib/persistence/production";
import { MemoryPersistenceStore } from "@/lib/persistence/store";
import { PersistenceNotFoundError, PersistenceVersionError, type CollectionKind } from "@/lib/persistence/types";
import { createCollectionCodec } from "@/lib/persistence/serialization";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import { createProductionActionEngine } from "@/lib/actions/production";
import { createProductionWorkflowEngine } from "@/lib/workflows/production";
import { WorkflowManager } from "@/lib/workflows/manager";
import { WorkflowRepository } from "@/lib/workflows/repository";
import { createWorkflowStep, createWorkflow } from "@/lib/workflows/types";

const NOW = "2026-08-10T08:00:00.000Z";

/** An engine set with one record per collection (digest job pre-seeded). */
function seededEngines() {
  const memory = createProductionMemoryEngine().remember({
    id: "mem-1",
    title: "A",
    content: "one",
    createdAt: NOW,
  }).engine;
  const conversation = createProductionConversationEngine()
    .startConversation({ id: "conv-1", createdAt: NOW, title: "Chat" }).engine;
  const jobs = createProductionJobEngine();
  const digest = createProductionDigestEngine();
  const { manager: digestManager } = digest.manager.createDigest({
    id: "digest-1",
    kind: "morning",
    createdAt: NOW,
    window: { from: NOW, to: NOW },
  });
  const digestSeeded = createProductionDigestEngine({ manager: digestManager });
  const action = createProductionActionEngine();
  const step = createWorkflowStep({ id: "step-1", name: "Run", action: { kind: "job", jobId: "bg-daily-digest" } });
  const workflowRecord = createWorkflow({ id: "wf-1", name: "Watch", trigger: { kind: "memory" }, steps: [step], createdAt: NOW });
  const { repository } = new WorkflowRepository().add(workflowRecord);
  const workflows = createProductionWorkflowEngine({ manager: new WorkflowManager(repository) });
  return { memory, conversation, jobs, digest: digestSeeded, actions: action, workflows };
}

describe("PersistenceEngine core contract", () => {
  it("snapshot serializes an engine without writing to the store", async () => {
    const store = new MemoryPersistenceStore();
    const persistence = new PersistenceEngine({ store });
    const engine = createProductionMemoryEngine().remember({
      id: "mem-1",
      title: "A",
      content: "one",
      createdAt: NOW,
    }).engine;
    const snapshot = persistence.snapshot("user-1", "memory", engine);
    expect(snapshot.kind).toBe("memory");
    expect(snapshot.scope).toBe("user-1");
    expect(snapshot.version).toBe(1);
    expect(JSON.parse(snapshot.payload)).toHaveLength(1);
    expect(await store.read("user-1", "memory")).toBeUndefined();
  });

  it("save writes through and load reads back the records", async () => {
    const persistence = new PersistenceEngine({ store: new MemoryPersistenceStore() });
    const engine = createProductionMemoryEngine().remember({
      id: "mem-1",
      title: "A",
      content: "one",
      createdAt: NOW,
    }).engine;
    await persistence.save("user-1", "memory", engine);
    const records = await persistence.load<never, { id: string }>("user-1", "memory");
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("mem-1");
  });

  it("load throws PersistenceNotFoundError for unpersisted collections", async () => {
    const persistence = new PersistenceEngine({ store: new MemoryPersistenceStore() });
    await expect(persistence.load("user-1", "workflow")).rejects.toThrow(PersistenceNotFoundError);
    await expect(persistence.loadOrEmpty("user-1", "workflow")).resolves.toEqual([]);
  });

  it("replace is a full-snapshot write (same records back)", async () => {
    const persistence = new PersistenceEngine({ store: new MemoryPersistenceStore() });
    const engine = createProductionMemoryEngine();
    const stored = await persistence.replace("user-1", "memory", engine);
    expect(stored.kind).toBe("memory");
    expect(await persistence.loadOrEmpty("user-1", "memory")).toEqual([]);
  });

  it("clear removes the persisted collection", async () => {
    const persistence = new PersistenceEngine({ store: new MemoryPersistenceStore() });
    const engine = createProductionMemoryEngine().remember({
      id: "mem-1",
      title: "A",
      content: "one",
      createdAt: NOW,
    }).engine;
    await persistence.save("user-1", "memory", engine);
    await persistence.clear("user-1", "memory");
    await expect(persistence.load("user-1", "memory")).rejects.toThrow(PersistenceNotFoundError);
  });

  it("loadEngine rebuilds a fresh engine over the records (restart recovery)", async () => {
    const persistence = new PersistenceEngine({ store: new MemoryPersistenceStore() });
    const engine = createProductionMemoryEngine().remember({
      id: "mem-1",
      title: "A",
      content: "one",
      createdAt: NOW,
    }).engine;
    await persistence.saveMemory("user-1", engine);
    const restored = await persistence.loadMemory("user-1");
    expect(restored.listMemories()).toEqual(engine.listMemories());
    expect(restored).not.toBe(engine);
  });

  it("typed conveniences cover all six collections", async () => {
    const persistence = new PersistenceEngine({ store: new MemoryPersistenceStore() });
    const { memory, conversation, jobs, digest, actions, workflows } = seededEngines();
    await persistence.saveMemory("u", memory);
    await persistence.saveConversation("u", conversation);
    await persistence.saveJobs("u", jobs);
    await persistence.saveDigests("u", digest);
    await persistence.saveActions("u", actions);
    await persistence.saveWorkflows("u", workflows);
    expect((await persistence.loadMemory("u")).count()).toBe(1);
    expect((await persistence.loadConversation("u")).count()).toBe(1);
    expect((await persistence.loadJobs("u")).manager.list().length).toBeGreaterThan(0);
    expect((await persistence.loadDigests("u")).count()).toBe(1);
    expect((await persistence.loadActions("u")).count()).toBe(0);
    expect((await persistence.loadWorkflows("u")).count()).toBe(1);
  });
});

describe("PersistenceEngine saveAll / restoreAll", () => {
  it("persists and restores the full engine set (restart recovery round-trip)", async () => {
    const persistence = new PersistenceEngine({ store: new MemoryPersistenceStore() });
    const engines = seededEngines();
    const { saved, errors } = await persistence.saveAll("user-1", engines);
    expect(saved).toHaveLength(6);
    expect(errors).toEqual([]);

    const { engines: restored, errors: restoreErrors } = await persistence.restoreAll("user-1");
    expect(restoreErrors).toEqual([]);
    expect(restored.memory.listMemories()).toEqual(engines.memory.listMemories());
    expect(restored.conversation.listConversations()).toEqual(engines.conversation.listConversations());
    expect(restored.jobs.manager.list()).toEqual(engines.jobs.manager.list());
    expect(restored.digest.manager.list()).toEqual(engines.digest.manager.list());
    expect(restored.actions.manager.list()).toEqual(engines.actions.manager.list());
    expect(restored.workflows.manager.list()).toEqual(engines.workflows.manager.list());
  });

  it("restoreAll recovers missing collections as empty engines", async () => {
    const persistence = new PersistenceEngine({ store: new MemoryPersistenceStore() });
    const { engines, errors } = await persistence.restoreAll("fresh");
    expect(errors).toEqual([]);
    expect(engines.memory.count()).toBe(0);
    expect(engines.conversation.count()).toBe(0);
    expect(engines.digest.count()).toBe(0);
    expect(engines.actions.count()).toBe(0);
    expect(engines.workflows.count()).toBe(0);
  });

  it("clearAll removes every collection under a scope", async () => {
    const persistence = new PersistenceEngine({ store: new MemoryPersistenceStore() });
    await persistence.saveAll("user-1", seededEngines());
    await persistence.clearAll("user-1");
    expect(await persistence.loadOrEmpty("user-1", "memory")).toEqual([]);
    expect(await persistence.loadOrEmpty("user-1", "workflow")).toEqual([]);
  });

  it("isolates per-collection failures in saveAll/restoreAll", async () => {
    const failing = new FailingStore();
    const persistence = new PersistenceEngine({ store: failing });
    const { saved, errors } = await persistence.saveAll("user-1", seededEngines());
    expect(saved).toHaveLength(0);
    expect(errors).toHaveLength(6);
    expect(errors.every((e) => e.message.includes("boom"))).toBe(true);
  });
});

describe("PersistenceEngine schema versioning", () => {
  it("rejects payloads written by a newer codec version", async () => {
    const store = new MemoryPersistenceStore();
    const persistence = new PersistenceEngine({ store });
    const engine = createProductionMemoryEngine();
    await persistence.save("user-1", "memory", engine);
    const stored = (await store.read("user-1", "memory"))!;
    // Simulate a future build writing version 2.
    await store.write("user-1", "memory", { ...stored, version: 2, payload: createCollectionCodec("memory", 2).serialize([]) });
    await expect(persistence.load("user-1", "memory")).rejects.toThrow(PersistenceVersionError);
  });
});

describe("PersistenceEngine adapters", () => {
  it("exposes the registered adapters", () => {
    const persistence = new PersistenceEngine();
    expect(persistence.kinds()).toEqual(["memory", "conversation", "job", "digest", "action", "workflow"]);
    expect(persistence.hasAdapter("digest")).toBe(true);
    expect(persistence.hasAdapter("bogus" as CollectionKind)).toBe(false);
    expect(persistence.adapter("memory")?.codec.version).toBe(1);
  });

  it("rejects duplicate adapter registrations", () => {
    expect(
      () =>
        new PersistenceEngine({
          adapters: [
            { kind: "memory", codec: createCollectionCodec("memory"), snapshot: () => [], restore: () => ({} as never) },
            { kind: "memory", codec: createCollectionCodec("memory"), snapshot: () => [], restore: () => ({} as never) },
          ],
        }),
    ).toThrow(/already contains adapter/);
  });
});

describe("production factory and singleton", () => {
  it("creates a production persistence engine over the in-memory store by default", () => {
    const persistence = createProductionPersistence();
    expect(persistence.store).toBeInstanceOf(MemoryPersistenceStore);
    expect(persistence.kinds()).toHaveLength(6);
  });

  it("is a stable singleton", () => {
    expect(getProductionPersistence()).toBe(getProductionPersistence());
    expect(getProductionPersistence()).toBeInstanceOf(PersistenceEngine);
  });
});

/** A store whose every method fails — for failure-isolation tests. */
class FailingStore implements import("@/lib/persistence/types").PersistenceStore {
  async read(): Promise<never> {
    throw new Error("boom");
  }
  async write(): Promise<never> {
    throw new Error("boom");
  }
  async clear(): Promise<never> {
    throw new Error("boom");
  }
}
