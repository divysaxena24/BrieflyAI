import { describe, it, expect } from "vitest";
import { DatabasePersistence } from "@/lib/database/persistence";
import { MemoryDatabaseDriver } from "@/lib/database/memoryDriver";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import { createProductionActionEngine } from "@/lib/actions/production";
import { createProductionWorkflowEngine } from "@/lib/workflows/production";
import type { MemoryEngine } from "@/lib/memory/production";
import type { ConversationEngine } from "@/lib/conversation/production";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T10:00:00.000Z";
const SCOPE = "app";

function persistence(): DatabasePersistence {
  return new DatabasePersistence({ driver: new MemoryDatabaseDriver() });
}

function memoryEngineWith(count: number): MemoryEngine {
  let engine = createProductionMemoryEngine();
  for (let index = 0; index < count; index += 1) {
    engine = engine
      .remember({
        id: `mem-${index}`,
        title: `Memory ${index}`,
        content: `content-${index}`,
        createdAt: NOW,
      })
      .engine;
  }
  return engine;
}

describe("snapshot", () => {
  it("wraps engine records into deterministic envelopes", () => {
    const p = persistence();
    const engine = memoryEngineWith(2);
    const envelopes = p.snapshot(SCOPE, "memory", engine, NOW);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].collection).toBe("memory");
    expect(envelopes[0].recordId).toBe("mem-0");
    expect(envelopes[0].version).toBe(1);
    expect(envelopes[0].createdAt).toBe(NOW);
    expect((envelopes[0].data as { id: string }).id).toBe("mem-0");
    // Deterministic: same input, same envelopes.
    expect(p.snapshot(SCOPE, "memory", engine, NOW).map((e) => e.id)).toEqual(
      envelopes.map((e) => e.id),
    );
    // Never mutates the engine.
    expect(engine.listMemories()).toHaveLength(2);
  });
});

describe("saveIncremental", () => {
  it("writes only new records on first save", async () => {
    const p = persistence();
    const engine = memoryEngineWith(3);
    const result = await p.saveIncremental(SCOPE, "memory", engine, NOW);
    expect(result.inserted).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(await p.hasData(SCOPE)).toBe(true);
  });

  it("is idempotent: second save with no changes reports all unchanged", async () => {
    const p = persistence();
    const engine = memoryEngineWith(3);
    await p.saveIncremental(SCOPE, "memory", engine, NOW);
    const second = await p.saveIncremental(SCOPE, "memory", engine, LATER);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(3);
  });

  it("writes only changed records on mutation", async () => {
    const p = persistence();
    let engine = memoryEngineWith(3);
    await p.saveIncremental(SCOPE, "memory", engine, NOW);
    // Mutate one memory (successor pattern via updateMemory).
    engine = engine.updateMemory("mem-1", {
      title: "Changed",
      content: "changed-content",
      updatedAt: LATER,
    }).engine;
    const result = await p.saveIncremental(SCOPE, "memory", engine, LATER);
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.unchanged).toBe(2);
  });

  it("deletes rows whose record ids are gone", async () => {
    const p = persistence();
    const engine = memoryEngineWith(3);
    await p.saveIncremental(SCOPE, "memory", engine, NOW);
    // Remove one memory by building a fresh engine with fewer records.
    let pruned = createProductionMemoryEngine();
    for (const memory of engine.listMemories()) {
      if (memory.id !== "mem-1") {
        pruned = pruned.remember(memory).engine;
      }
    }
    const result = await p.saveIncremental(SCOPE, "memory", pruned, LATER);
    expect(result.removed).toBe(1);
    expect(result.inserted).toBe(0);
    const stored = await p.driver.readAll(SCOPE, "memory");
    expect(stored.map((e) => e.recordId)).toEqual(["mem-0", "mem-2"]);
  });
});

describe("restore / restart recovery", () => {
  it("rebuilds a fresh engine over stored records", async () => {
    const p = persistence();
    const engine = memoryEngineWith(2);
    await p.saveIncremental(SCOPE, "memory", engine, NOW);

    const restored = await p.restoreCollection<MemoryEngine, never>(SCOPE, "memory");
    expect(restored.listMemories()).toHaveLength(2);
    expect(restored.listMemories()[0].id).toBe("mem-0");
    // Restored engine is independent of the original (successor pattern).
    const grown = restored.remember({
      id: "mem-new",
      title: "t",
      content: "c",
      createdAt: LATER,
    }).engine;
    expect(grown.listMemories()).toHaveLength(3);
    expect(engine.listMemories()).toHaveLength(2);
  });

  it("restores empty engines for missing collections", async () => {
    const p = persistence();
    const restored = await p.restoreCollection<MemoryEngine, never>(SCOPE, "memory");
    expect(restored.listMemories()).toHaveLength(0);
  });

  it("restoreAll returns a full engine set with no errors", async () => {
    const p = persistence();
    const engines = {
      memory: memoryEngineWith(1),
      conversation: createProductionConversationEngine(),
      jobs: createProductionJobEngine(),
      digest: createProductionDigestEngine(),
      actions: createProductionActionEngine(),
      workflows: createProductionWorkflowEngine(),
    };
    await p.saveAll(SCOPE, engines, NOW);
    const { engines: restored, errors } = await p.restoreAll(SCOPE);
    expect(errors).toHaveLength(0);
    expect(restored.memory.listMemories()).toHaveLength(1);
    expect(restored.conversation.listConversations()).toHaveLength(0);
    expect(restored.jobs.manager.list()).toBeDefined();
  });

  it("isolates per-collection failures during restoreAll", async () => {
    const p = persistence();
    // Corrupt the memory collection by storing a non-record row.
    await p.driver.upsertAll(SCOPE, "memory", [
      {
        id: "broken",
        scope: SCOPE,
        collection: "memory",
        recordId: "broken",
        revision: 1,
        version: 1,
        archived: false,
        archivedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        data: { notA: "memory" },
      } as never,
    ]);
    const { engines, errors } = await p.restoreAll(SCOPE);
    expect(errors.length).toBeGreaterThan(0);
    expect(engines.memory.listMemories()).toHaveLength(0); // isolated to empty
  });
});

describe("upgrade / schema versioning", () => {
  it("migrates records to a new version with a pure migration", async () => {
    const p = persistence();
    const engine = memoryEngineWith(2);
    await p.saveIncremental(SCOPE, "memory", engine, NOW);

    const migratedCount = await p.upgrade(
      SCOPE,
      "memory",
      1,
      2,
      (records) =>
        records.map((record) => ({
          ...record,
          extra: { migratedAt: LATER },
        })) as never,
      LATER,
    );
    expect(migratedCount).toBe(2);
    expect(await p.storedVersion(SCOPE, "memory")).toBe(2);
  });

  it("rejects upgrades that do not match the stored version", async () => {
    const p = persistence();
    const engine = memoryEngineWith(1);
    await p.saveIncremental(SCOPE, "memory", engine, NOW);
    await expect(
      p.upgrade(SCOPE, "memory", 5, 6, (records) => records, LATER),
    ).rejects.toThrow("does not match");
  });

  it("storedVersion is 0 for empty collections", async () => {
    const p = persistence();
    expect(await p.storedVersion(SCOPE, "memory")).toBe(0);
  });

  it("metadata read creates and updates the schema anchor", async () => {
    const p = persistence();
    const first = await p.metadata(SCOPE, NOW);
    expect(first.schemaVersion).toBe(1);
    await p.writeMetadata(SCOPE, 3, LATER);
    const second = await p.metadata(SCOPE, LATER);
    expect(second.schemaVersion).toBe(3);
  });

  it("exposes the supported version descriptor", () => {
    const p = persistence();
    const version = p.supportedVersion("memory");
    expect(version.version).toBe(1);
    expect(version.id.startsWith("version-")).toBe(true);
  });
});

describe("clear / clearAll", () => {
  it("clears one collection and all collections", async () => {
    const p = persistence();
    const engines = {
      memory: memoryEngineWith(1),
      conversation: createProductionConversationEngine() as ConversationEngine,
      jobs: createProductionJobEngine(),
      digest: createProductionDigestEngine(),
      actions: createProductionActionEngine(),
      workflows: createProductionWorkflowEngine(),
    };
    await p.saveAll(SCOPE, engines, NOW);
    await p.clear(SCOPE, "memory");
    expect(await p.hasData(SCOPE)).toBe(true);
    await p.clearAll(SCOPE);
    expect(await p.hasData(SCOPE)).toBe(false);
  });
});

describe("duplicate adapter rejection", () => {
  it("rejects duplicate adapters at construction", () => {
    const driver = new MemoryDatabaseDriver();
    expect(() => new DatabasePersistence({ driver })).not.toThrow();
    // Duplicate registration via custom adapters is rejected.
    expect(() => {
      const adapter = {
        kind: "memory" as const,
        codec: { kind: "memory" as const, version: 1, serialize: () => "[]", deserialize: () => [] },
        snapshot: () => [],
        restore: () => createProductionMemoryEngine(),
      };
      new DatabasePersistence({
        driver,
        adapters: [adapter, adapter],
      });
    }).toThrow(/already contains adapter/);
  });
});
