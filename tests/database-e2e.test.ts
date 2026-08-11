import { describe, it, expect } from "vitest";
import { DatabaseEngine, createProductionDatabase } from "@/lib/database/production";
import { MemoryDatabaseDriver } from "@/lib/database/memoryDriver";
import { DatabaseRepository } from "@/lib/database/repository";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import { createProductionActionEngine } from "@/lib/actions/production";
import { createProductionWorkflowEngine } from "@/lib/workflows/production";
import type { CreateMemoryInput } from "@/lib/memory/types";
import { createDatabaseRecord, type DatabaseCollectionKind, type DatabaseRecord } from "@/lib/database/types";
import { retentionExpired } from "@/lib/database/retention";
import { OptimisticLockError, DatabaseRecordDuplicateError } from "@/lib/database/driver";

const NOW = "2026-08-11T09:00:00.000Z";
const SCOPE = "e2e";

interface E2ePayload {
  id: string;
  index: number;
  tag: string;
  expiresAt?: string;
}

function payloadRecord(collection: DatabaseCollectionKind, index: number): DatabaseRecord<E2ePayload> {
  return createDatabaseRecord<E2ePayload>({
    scope: SCOPE,
    collection,
    recordId: `${collection}-${index}`,
    createdAt: NOW,
    updatedAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    data: {
      id: `${collection}-${index}`,
      index,
      tag: `tag-${index % 10}`,
    },
  });
}

async function seedCollection(
  repo: DatabaseRepository,
  collection: DatabaseCollectionKind,
  count: number,
): Promise<void> {
  const batchSize = 500;
  for (let start = 0; start < count; start += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, count - start) }, (_, offset) =>
      payloadRecord(collection, start + offset),
    );
    await repo.insertMany(batch);
  }
}

describe("end-to-end: 1000 objects", () => {
  it("inserts, paginates, searches, mutates and counts 1000 records", async () => {
    const engine = createProductionDatabase();
    const repo = engine.scoped(SCOPE, "memory");
    await seedCollection(repo, "memory", 1000);

    expect(await repo.count()).toBe(1000);
    expect(await repo.exists("memory-999")).toBe(true);

    // Offset pagination walks the full set without loss or duplication.
    const seen: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await repo.paginate(page, 100);
      expect(result.page).toBe(page);
      seen.push(...result.items.map((item) => item.recordId));
    }
    expect(seen).toHaveLength(1000);
    expect(new Set(seen).size).toBe(1000);

    // Cursor pagination reaches the end deterministically.
    const cursored: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const result = await repo.cursorPagination(cursor, 50);
      cursored.push(...result.items.map((item) => item.recordId));
      cursor = result.nextCursor;
      guard += 1;
    } while (cursor !== undefined && guard < 30);
    expect(cursored).toHaveLength(1000);
    expect(new Set(cursored).size).toBe(1000);

    // Search matches by data text.
    const search = await repo.search("tag-3");
    expect(search.total).toBe(100);

    // Optimistic lock round-trip.
    const updated = await repo.update("memory-1", { now: NOW, data: { ...payloadRecord("memory", 1).data, tag: "updated" } }, 1);
    expect(updated.revision).toBe(2);
    await expect(
      repo.update("memory-1", { now: NOW, data: payloadRecord("memory", 1).data }, 1),
    ).rejects.toBeInstanceOf(OptimisticLockError);

    // Soft delete + restore.
    await repo.softDelete("memory-2", NOW);
    expect((await repo.list()).total).toBe(999);
    await repo.restore("memory-2", NOW);
    expect(await repo.count()).toBe(1000);
  });

  it("persists 1000-engine records and restores them (restart recovery)", async () => {
    const engine = createProductionDatabase();
    let memory = createProductionMemoryEngine();
    const inputs: CreateMemoryInput[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `mem-${index}`,
      title: `Memory ${index}`,
      content: `content-${index}`,
      createdAt: NOW,
    }));
    for (const input of inputs) {
      memory = memory.remember(input).engine;
    }
    expect(memory.count()).toBe(1000);

    const { results, errors } = await engine.saveAll(
      SCOPE,
      {
        memory,
        conversation: createProductionConversationEngine(),
        jobs: createProductionJobEngine(),
        digest: createProductionDigestEngine(),
        actions: createProductionActionEngine(),
        workflows: createProductionWorkflowEngine(),
      },
      NOW,
    );
    expect(errors).toHaveLength(0);
    expect(results.find((r) => r.kind === "memory")?.inserted).toBe(1000);

    // Simulated restart over the same driver.
    const restarted = createProductionDatabase({ driver: engine.driver });
    const { engines, errors: restoreErrors } = await restarted.restoreAll(SCOPE);
    expect(restoreErrors).toHaveLength(0);
    expect(engines.memory.count()).toBe(1000);
    expect(engines.memory.getMemory("mem-500")?.metadata.title).toBe("Memory 500");
  });
});

describe("end-to-end: 5000 objects", () => {
  it("handles 5000 records across pagination, transactions and retention", async () => {
    const driver = new MemoryDatabaseDriver();
    const repo = new DatabaseRepository({ driver, scope: SCOPE, collection: "job" });
    await seedCollection(repo, "job", 5000);
    expect(await repo.count()).toBe(5000);

    // Transactional bulk update.
    await repo.transaction(async (tx) => {
      const first = await tx.cursorPagination(undefined, 100);
      for (const item of first.items) {
        await tx.update(item.recordId, { now: NOW, data: { ...(item.data as E2ePayload), tag: "tx" } });
      }
    });
    const changed = await repo.search("tx");
    expect(changed.total).toBe(100);

    // Retention over the dataset.
    const engine = new DatabaseEngine({
      driver,
      policies: [retentionExpired("job", "delete", NOW)],
    });
    // Mark 50 records as expired via data.
    const first = await repo.cursorPagination(undefined, 50);
    for (const item of first.items) {
      await repo.update(item.recordId, {
        now: NOW,
        data: { ...(item.data as E2ePayload), expiresAt: "2026-01-01T00:00:00.000Z" },
      });
    }
    const cleanup = await engine.retention.runCleanup({ scope: SCOPE, now: NOW });
    expect(cleanup.recordCount).toBe(50);
    expect(await repo.count()).toBe(4950);
  });
});

describe("end-to-end: 10000 objects", () => {
  it("handles 10000 records with deterministic ordering and immutability", async () => {
    const driver = new MemoryDatabaseDriver();
    const repo = new DatabaseRepository({ driver, scope: SCOPE, collection: "digest" });
    await seedCollection(repo, "digest", 10000);
    expect(await repo.count()).toBe(10000);

    // Reads never alias stored data.
    const read = await repo.find("digest-0");
    (read!.data as E2ePayload).tag = "MUTATED";
    const stored = await repo.find("digest-0");
    expect((stored!.data as E2ePayload).tag).toBe("tag-0");

    // Storage is deep-frozen.
    expect(Object.isFrozen(driver.recordsOf(SCOPE, "digest")[0])).toBe(true);

    // Ordering is deterministic: two identical queries produce identical pages.
    const a = await repo.cursorPagination(undefined, 250);
    const b = await repo.cursorPagination(undefined, 250);
    expect(a.items.map((item) => item.recordId)).toEqual(b.items.map((item) => item.recordId));

    // Duplicate insert rejected atomically at scale.
    await expect(repo.insert(payloadRecord("digest", 0))).rejects.toBeInstanceOf(
      DatabaseRecordDuplicateError,
    );

    // Statistics over the full set.
    const stats = await engineStats(createProductionDatabase({ driver }));
    const digest = stats.find((s) => s.collection === "digest");
    expect(digest?.total).toBe(10000);
  });
});

async function engineStats(engine: DatabaseEngine) {
  return engine.retention.statistics(SCOPE);
}

describe("determinism & immutability", () => {
  it("produces identical results across runs and detaches reads", async () => {
    const a = new MemoryDatabaseDriver();
    const b = new MemoryDatabaseDriver();
    const ra = new DatabaseRepository({ driver: a, scope: SCOPE, collection: "memory" });
    const rb = new DatabaseRepository({ driver: b, scope: SCOPE, collection: "memory" });
    await seedCollection(ra, "memory", 1000);
    await seedCollection(rb, "memory", 1000);

    const pa = await ra.cursorPagination(undefined, 500);
    const pb = await rb.cursorPagination(undefined, 500);
    expect(pa.items.map((i) => i.recordId)).toEqual(pb.items.map((i) => i.recordId));
    expect(pa.nextCursor).toBe(pb.nextCursor);
    expect(pa.items[0]).not.toBe(pb.items[0]);
  });

  it("concurrent isolated transactions do not interleave state", async () => {
    const engine = createProductionDatabase();
    const repo = engine.scoped(SCOPE, "memory");
    await seedCollection(repo, "memory", 100);

    await Promise.all([
      repo.transaction(async (tx) => {
        for (const item of (await tx.list({ limit: 100 })).items) {
          if ((item.data as E2ePayload).index % 2 === 0) {
            await tx.archive(item.recordId, NOW);
          }
        }
      }),
      repo.transaction(async (tx) => {
        for (const item of (await tx.list({ limit: 100 })).items) {
          if ((item.data as E2ePayload).index % 2 === 1) {
            await tx.softDelete(item.recordId, NOW);
          }
        }
      }),
    ]);

    const archived = (await repo.list({ includeArchived: true })).total;
    const softDeleted = (await repo.list({ includeDeleted: true })).total;
    expect(archived).toBe(50);
    expect(softDeleted).toBe(50);
  });
});
