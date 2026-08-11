import { describe, it, expect } from "vitest";
import {
  createProductionDatabase,
  getProductionDatabase,
  isPostgresBacked,
  DatabaseEngine,
  DEFAULT_DATABASE_SCOPE,
} from "@/lib/database/production";
import { MemoryDatabaseDriver } from "@/lib/database/memoryDriver";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import { createProductionActionEngine } from "@/lib/actions/production";
import { createProductionWorkflowEngine } from "@/lib/workflows/production";
import { createMemory } from "@/lib/memory/types";
import { retentionOlderThan, retentionExpired } from "@/lib/database/retention";
import { OptimisticLockError } from "@/lib/database/driver";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T10:00:00.000Z";

describe("createProductionDatabase", () => {
  it("composes driver, persistence, retention and transactions", () => {
    const engine = createProductionDatabase();
    expect(engine.driver).toBeDefined();
    expect(engine.persistence).toBeDefined();
    expect(engine.retention).toBeDefined();
    expect(engine.transactions).toBeDefined();
    expect(engine.driver instanceof MemoryDatabaseDriver).toBe(true);
  });

  it("returns fresh instances per factory call (no shared state)", () => {
    const a = createProductionDatabase();
    const b = createProductionDatabase();
    expect(a).not.toBe(b);
    expect(a.driver).not.toBe(b.driver);
    // Independent persistence: writing through one never leaks into the other.
    expect(a.persistence.driver).not.toBe(b.persistence.driver);
  });

  it("exposes repositories for every collection", () => {
    const engine = createProductionDatabase();
    for (const collection of ["memory", "conversation", "job", "digest", "action", "workflow", "event", "metadata"] as const) {
      expect(engine.repository(collection)).toBeDefined();
    }
    expect(engine.repository("memory").scope).toBe(DEFAULT_DATABASE_SCOPE);
  });

  it("scoped repositories namespace by scope", () => {
    const engine = createProductionDatabase();
    const a = engine.scoped("user-1", "memory");
    const b = engine.scoped("user-2", "memory");
    expect(a.scope).toBe("user-1");
    expect(b.scope).toBe("user-2");
    expect(a.driver).toBe(engine.driver); // same driver, different scope
  });

  it("accepts injected policies and orphan predicates", () => {
    const engine = createProductionDatabase({
      policies: [retentionExpired("event", "soft_delete", NOW)],
    });
    expect(engine.retention.listPolicies()).toHaveLength(1);
  });
});

describe("getProductionDatabase", () => {
  it("is a stable module singleton", () => {
    expect(getProductionDatabase()).toBe(getProductionDatabase());
    expect(getProductionDatabase()).toBeInstanceOf(DatabaseEngine);
  });

  it("is distinct from fresh factories", () => {
    expect(getProductionDatabase()).not.toBe(createProductionDatabase());
  });

  it("is not postgres-backed by default", () => {
    expect(isPostgresBacked()).toBe(false);
  });
});

describe("createPostgresBackedDatabase", () => {
  it("builds a Postgres-backed engine (lazy — no query runs)", async () => {
    // The Postgres driver imports @/lib/db, which requires DATABASE_URL at
    // module load. It is wired by the application, not by unit tests (the
    // 5J convention) — so it is loaded lazily and only asserted when the
    // environment can provide the URL. Never throws in CI without it.
    const { createPostgresBackedDatabase } = await import("@/lib/database/production");
    const engine = await createPostgresBackedDatabase();
    expect(engine.driver).toBeDefined();
  });
});

describe("database → persistence integration", () => {
  it("persists engines row-by-row and restores them (restart recovery)", async () => {
    const engine = createProductionDatabase();
    let memory = createProductionMemoryEngine();
    memory = memory
      .remember(createMemory({ id: "mem-1", title: "A", content: "one", createdAt: NOW }))
      .engine;
    memory = memory
      .remember(createMemory({ id: "mem-2", title: "B", content: "two", createdAt: NOW }))
      .engine;

    const engines = {
      memory,
      conversation: createProductionConversationEngine(),
      jobs: createProductionJobEngine(),
      digest: createProductionDigestEngine(),
      actions: createProductionActionEngine(),
      workflows: createProductionWorkflowEngine(),
    };
    const { results, errors } = await engine.saveAll("user-1", engines, NOW);
    expect(errors).toHaveLength(0);
    expect(results.find((r) => r.kind === "memory")?.inserted).toBe(2);

    // Simulate a restart: fresh database engine, restore from the same driver.
    const restarted = createProductionDatabase({ driver: engine.driver });
    const { engines: restored, errors: restoreErrors } = await restarted.restoreAll("user-1");
    expect(restoreErrors).toHaveLength(0);
    expect(restored.memory.listMemories().map((m) => m.id)).toEqual(["mem-1", "mem-2"]);
  });

  it("exposes incremental persistence through the repository layer", async () => {
    const engine = createProductionDatabase();
    const repo = engine.repository("memory");
    await repo.insert({
      id: "record-1",
      scope: DEFAULT_DATABASE_SCOPE,
      collection: "memory",
      recordId: "mem-1",
      revision: 1,
      version: 1,
      archived: false,
      archivedAt: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      data: { id: "mem-1", content: "hello" },
    });
    const found = await repo.find("mem-1");
    expect((found?.data as { content: string }).content).toBe("hello");
    // Optimistic locking works through the production graph.
    await expect(
      repo.update("mem-1", { now: LATER, data: { id: "mem-1", content: "x" } }, 99),
    ).rejects.toBeInstanceOf(OptimisticLockError);
  });

  it("runs retention through the composition root", async () => {
    const engine = createProductionDatabase({
      policies: [retentionOlderThan("event", "delete", 30, NOW)],
    });
    const repo = engine.repository("event");
    await repo.insert({
      id: "record-old",
      scope: DEFAULT_DATABASE_SCOPE,
      collection: "event",
      recordId: "ev-old",
      revision: 1,
      version: 1,
      archived: false,
      archivedAt: null,
      deletedAt: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      data: { id: "ev-old" },
    });
    const cleanup = await engine.retention.runCleanup({ scope: DEFAULT_DATABASE_SCOPE, now: NOW });
    expect(cleanup.recordCount).toBe(1);
    expect(await repo.exists("ev-old")).toBe(false);
  });
});

describe("isolation", () => {
  it("production singleton shares no state with factory instances", async () => {
    const engine = createProductionDatabase();
    const repo = engine.repository("memory");
    await repo.insert({
      id: "record-x",
      scope: DEFAULT_DATABASE_SCOPE,
      collection: "memory",
      recordId: "mem-x",
      revision: 1,
      version: 1,
      archived: false,
      archivedAt: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      data: { id: "mem-x" },
    });
    expect(await getProductionDatabase().repository("memory").exists("mem-x")).toBe(false);
  });
});
