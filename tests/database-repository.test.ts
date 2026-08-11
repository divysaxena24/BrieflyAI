import { describe, it, expect } from "vitest";
import { DatabaseRepository } from "@/lib/database/repository";
import { MemoryDatabaseDriver } from "@/lib/database/memoryDriver";
import {
  DatabaseRecordDuplicateError,
  DatabaseRecordNotFoundError,
  OptimisticLockError,
  type DatabaseRecord,
} from "@/lib/database/driver";
import { createDatabaseRecord } from "@/lib/database/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T10:00:00.000Z";
const SCOPE = "user-1";
const COLLECTION = "memory";

interface Payload {
  title: string;
  score: number;
  tags: string[];
}

function record(recordId: string, revision = 1, data: Partial<Payload> = {}): DatabaseRecord<Payload> {
  return createDatabaseRecord<Payload>({
    scope: SCOPE,
    collection: COLLECTION,
    recordId,
    revision,
    createdAt: NOW,
    updatedAt: NOW,
    data: { title: `title-${recordId}`, score: 1, tags: ["a"], ...data },
  });
}

function repo(driver: MemoryDatabaseDriver = new MemoryDatabaseDriver()): DatabaseRepository {
  return new DatabaseRepository({ driver, scope: SCOPE, collection: COLLECTION });
}

describe("insert / insertMany", () => {
  it("rejects envelopes whose scope/collection do not match the repository", async () => {
    const r = repo();
    const foreign = record("mem-x");
    await expect(
      r.insert({ ...foreign, scope: "user-2" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      r.insert({ ...foreign, collection: "digest" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      r.insertMany([foreign, { ...foreign, collection: "digest" }]),
    ).rejects.toMatchObject({ status: 400 });
    // Nothing was stored.
    expect(await r.count()).toBe(0);
  });

  it("inserts a record; storage is deep-frozen, reads are detached", async () => {
    const driver = new MemoryDatabaseDriver();
    const r = new DatabaseRepository({ driver, scope: SCOPE, collection: COLLECTION });
    await r.insert(record("mem-1"));
    expect(await r.exists("mem-1")).toBe(true);
    // Storage holds deep-frozen records (safe to inspect — immutable).
    expect(Object.isFrozen(driver.recordsOf(SCOPE, COLLECTION)[0]!.data)).toBe(true);
    // Reads are detached clones the caller may mutate without touching storage.
    const read = await r.find("mem-1");
    (read!.data as Payload).title = "mutated";
    expect((driver.recordsOf(SCOPE, COLLECTION)[0]!.data as Payload).title).toBe("title-mem-1");
  });

  it("rejects duplicate inserts with DatabaseRecordDuplicateError", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    await expect(r.insert(record("mem-1"))).rejects.toBeInstanceOf(DatabaseRecordDuplicateError);
  });

  it("inserts many atomically and rejects duplicates", async () => {
    const r = repo();
    await r.insertMany([record("mem-1"), record("mem-2")]);
    expect(await r.count()).toBe(2);
    await expect(r.insertMany([record("mem-3"), record("mem-2")])).rejects.toBeInstanceOf(
      DatabaseRecordDuplicateError,
    );
    expect(await r.exists("mem-3")).toBe(false);
  });

  it("returns detached clones", async () => {
    const r = repo();
    const inserted = await r.insert(record("mem-1", 1, { title: "original" }));
    (inserted.data as Payload).title = "mutated";
    expect((await r.find("mem-1"))!.data.title).toBe("original");
  });
});

describe("update / replace", () => {
  it("updates data, bumps revision, updates updatedAt", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    const updated = await r.update("mem-1", { now: LATER, data: { title: "new", score: 9, tags: [] } });
    expect(updated.revision).toBe(2);
    expect(updated.updatedAt).toBe(LATER);
    expect((updated.data as Payload).title).toBe("new");
    expect(await r.count()).toBe(1);
  });

  it("optimistic lock: stale revision throws, fresh revision succeeds", async () => {
    const r = repo();
    await r.insert(record("mem-1", 1));
    await expect(
      r.update("mem-1", { now: LATER, data: { title: "x", score: 1, tags: [] } }, 5),
    ).rejects.toBeInstanceOf(OptimisticLockError);
    const ok = await r.update("mem-1", { now: LATER, data: { title: "x", score: 1, tags: [] } }, 1);
    expect(ok.revision).toBe(2);
  });

  it("update without expectedRevision always writes", async () => {
    const r = repo();
    await r.insert(record("mem-1", 1));
    const updated = await r.update("mem-1", { now: LATER });
    expect(updated.revision).toBe(2);
  });

  it("update throws DatabaseRecordNotFoundError for missing records", async () => {
    const r = repo();
    await expect(r.update("ghost", { now: LATER })).rejects.toBeInstanceOf(
      DatabaseRecordNotFoundError,
    );
  });

  it("replace upserts: creates when missing, overwrites when present", async () => {
    const r = repo();
    await r.replace(record("mem-1", 1, { title: "first" }));
    expect(await r.exists("mem-1")).toBe(true);
    await r.replace(record("mem-1", 1, { title: "second" }));
    const stored = await r.find("mem-1");
    expect((stored!.data as Payload).title).toBe("second");
    expect(stored!.revision).toBe(2);
  });
});

describe("delete / softDelete / restore / archive / unarchive", () => {
  it("hard-deletes and is idempotent for missing ids", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    await r.delete("mem-1");
    expect(await r.exists("mem-1")).toBe(false);
    await r.delete("ghost"); // never throws
  });

  it("soft-deletes (sets deletedAt) and hides from default list", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    const deleted = await r.softDelete("mem-1", LATER);
    expect(deleted.deletedAt).toBe(LATER);
    const list = await r.list();
    expect(list.items).toHaveLength(0);
    expect(list.total).toBe(0);
    const all = await r.list({ includeDeleted: true });
    expect(all.total).toBe(1);
  });

  it("restores soft-deleted records", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    await r.softDelete("mem-1", LATER);
    const restored = await r.restore("mem-1", LATER);
    expect(restored.deletedAt).toBeNull();
    expect(await r.count()).toBe(1);
  });

  it("archives (hidden by default, visible with includeArchived)", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    const archived = await r.archive("mem-1", LATER);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBe(LATER);
    expect((await r.list()).total).toBe(0);
    expect((await r.list({ includeArchived: true })).total).toBe(1);
  });

  it("unarchives records", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    await r.archive("mem-1", LATER);
    const back = await r.unarchive("mem-1", LATER);
    expect(back.archived).toBe(false);
    expect(back.archivedAt).toBeNull();
    expect(await r.count()).toBe(1);
  });
});

describe("reads / pagination / search", () => {
  /** Seed `count` records with distinct updatedAt (newest = mem-00N). */
  async function seedCount(r: DatabaseRepository, count: number): Promise<void> {
    await r.insertMany(
      Array.from({ length: count }, (_, index) =>
        createDatabaseRecord<Payload>({
          scope: SCOPE,
          collection: COLLECTION,
          recordId: `mem-${String(index + 1).padStart(3, "0")}`,
          createdAt: NOW,
          updatedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
          data: { title: `t-${index}`, score: index, tags: [] },
        }),
      ),
    );
  }

  it("counts and lists with ordering (newest first, stable tie-break)", async () => {
    const r = repo();
    await seedCount(r, 5);
    expect(await r.count()).toBe(5);
    const list = await r.list({ limit: 10 });
    expect(list.total).toBe(5);
    expect(list.items.map((x) => x.recordId)).toEqual([
      "mem-005",
      "mem-004",
      "mem-003",
      "mem-002",
      "mem-001",
    ]);
  });

  it("paginates by offset", async () => {
    const r = repo();
    await seedCount(r, 10);
    const page1 = await r.paginate(1, 3);
    expect(page1.items).toHaveLength(3);
    expect(page1.total).toBe(10);
    expect(page1.hasMore).toBe(true);
    const page4 = await r.paginate(4, 3);
    expect(page4.items).toHaveLength(1);
    expect(page4.hasMore).toBe(false);
  });

  it("paginates by cursor", async () => {
    const r = repo();
    await seedCount(r, 5);
    const page1 = await r.cursorPagination(undefined, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe("mem-004");
    const page2 = await r.cursorPagination(page1.nextCursor, 2);
    expect(page2.items.map((x) => x.recordId)).toEqual(["mem-003", "mem-002"]);
    const page3 = await r.cursorPagination(page2.nextCursor, 2);
    expect(page3.items.map((x) => x.recordId)).toEqual(["mem-001"]);
    expect(page3.hasMore).toBe(false);
  });

  it("searches across data payloads", async () => {
    const r = repo();
    await seedCount(r, 3);
    await r.update("mem-001", { now: LATER, data: { title: "UniqueTitle", score: 0, tags: [] } });
    const results = await r.search("UniqueTitle");
    expect(results.total).toBe(1);
    expect(results.items[0].recordId).toBe("mem-001");
  });

  it("filters by lifecycle via query options", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    await r.insert(record("mem-2"));
    await r.archive("mem-2", LATER);
    expect((await r.list()).total).toBe(1);
    expect((await r.list({ includeArchived: true })).total).toBe(2);
  });
});

describe("transactions", () => {
  it("commits all mutations atomically", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    await r.transaction(async (tx) => {
      await tx.insert(record("mem-2"));
      await tx.update("mem-1", { now: LATER, data: { title: "t", score: 1, tags: [] } });
    });
    expect(await r.count()).toBe(2);
    expect((await r.find("mem-1"))!.data.title).toBe("t");
  });

  it("rolls back all mutations when work throws", async () => {
    const r = repo();
    await r.insert(record("mem-1"));
    await expect(
      r.transaction(async (tx) => {
        await tx.insert(record("mem-2"));
        await tx.delete("mem-1");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await r.count()).toBe(1);
    expect(await r.exists("mem-1")).toBe(true);
    expect(await r.exists("mem-2")).toBe(false);
  });

  it("supports nested repository transactions", async () => {
    const r = repo();
    await r.transaction(async (outer) => {
      await outer.insert(record("mem-1"));
      await outer.transaction(async (inner) => {
        await inner.insert(record("mem-2"));
      });
    });
    expect(await r.count()).toBe(2);
  });
});

describe("isolation", () => {
  it("each repository/driver pair is independent", async () => {
    const a = repo();
    const b = repo();
    await a.insert(record("mem-1"));
    expect(await b.count()).toBe(0);
  });

  it("different scopes on the same driver do not collide", async () => {
    const driver = new MemoryDatabaseDriver();
    const a = new DatabaseRepository({ driver, scope: "user-1", collection: COLLECTION });
    const b = new DatabaseRepository({ driver, scope: "user-2", collection: COLLECTION });
    await a.insert(record("mem-1"));
    expect(await b.count()).toBe(0);
    expect(await a.count()).toBe(1);
  });
});
