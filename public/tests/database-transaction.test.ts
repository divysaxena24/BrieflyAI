import { describe, it, expect } from "vitest";
import {
  DatabaseTransactionManager,
  backoffFor,
  DEFAULT_DATABASE_RETRY_POLICY,
} from "@/lib/database/transaction";
import { MemoryDatabaseDriver } from "@/lib/database/memoryDriver";
import {
  isRetryableDatabaseError,
  OptimisticLockError,
  TransactionConflictError,
  TransactionDeadlockError,
  TransactionRollbackError,
  type DatabaseRecord,
} from "@/lib/database/driver";
import {
  createDatabaseRecord,
  type DatabaseCollectionKind,
} from "@/lib/database/types";

const NOW = "2026-08-11T09:00:00.000Z";
const SCOPE = "user-1";
const COLLECTION = "memory";

function record(recordId: string, revision = 1, data: Record<string, unknown> = {}): DatabaseRecord<unknown> {
  return createDatabaseRecord({
    scope: SCOPE,
    collection: COLLECTION,
    recordId,
    revision,
    createdAt: NOW,
    updatedAt: NOW,
    data,
  });
}

async function seed(driver: MemoryDatabaseDriver, count = 3): Promise<void> {
  const records = Array.from({ length: count }, (_, index) => record(`mem-${index + 1}`));
  await driver.upsertAll(SCOPE, COLLECTION, records);
}

describe("backoffFor", () => {
  it("doubles exponentially and caps at the ceiling", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 80 };
    expect(backoffFor(1, policy)).toBe(10);
    expect(backoffFor(2, policy)).toBe(20);
    expect(backoffFor(3, policy)).toBe(40);
    expect(backoffFor(4, policy)).toBe(80);
    expect(backoffFor(5, policy)).toBe(80);
  });

  it("never goes below the base delay", () => {
    expect(backoffFor(1, DEFAULT_DATABASE_RETRY_POLICY)).toBe(10);
  });
});

describe("DatabaseTransactionManager.run", () => {
  it("commits writes on success", async () => {
    const driver = new MemoryDatabaseDriver();
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });
    await seed(driver);

    await manager.run(async (handle) => {
      await handle.upsertAll(SCOPE, COLLECTION, [record("mem-9")]);
    });

    const all = await driver.readAll(SCOPE, COLLECTION);
    expect(all.map((r) => r.recordId)).toContain("mem-9");
  });

  it("rolls back every write when the work function throws", async () => {
    const driver = new MemoryDatabaseDriver();
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });
    await seed(driver);

    await expect(
      manager.run(async (handle) => {
        await handle.upsertAll(SCOPE, COLLECTION, [record("mem-50"), record("mem-51")]);
        await handle.deleteMany(SCOPE, COLLECTION, ["mem-1"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const all = await driver.readAll(SCOPE, COLLECTION);
    expect(all.map((r) => r.recordId).sort()).toEqual(["mem-1", "mem-2", "mem-3"]);
  });

  it("propagates rollback of a nested transaction only (inner failure does not roll back the outer)", async () => {
    const driver = new MemoryDatabaseDriver();
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });
    await seed(driver);

    await manager.run(async (outer) => {
      await outer.upsertAll(SCOPE, COLLECTION, [record("outer-1")]);
      // Inner transaction fails → only its own writes are rolled back.
      await expect(
        manager.run(async (inner) => {
          await inner.upsertAll(SCOPE, COLLECTION, [record("inner-1")]);
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");
      expect((await outer.readAll(SCOPE, COLLECTION)).map((r) => r.recordId)).not.toContain("inner-1");
      await outer.upsertAll(SCOPE, COLLECTION, [record("outer-2")]);
    });

    const all = await driver.readAll(SCOPE, COLLECTION);
    const ids = all.map((r) => r.recordId);
    expect(ids).toContain("outer-1");
    expect(ids).toContain("outer-2");
    expect(ids).not.toContain("inner-1");
  });

  it("reports nesting depth on the handle", async () => {
    const driver = new MemoryDatabaseDriver();
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });
    const depths: number[] = [];
    await manager.run(async (outer) => {
      depths.push(outer.depth);
      await manager.run(async (inner) => {
        depths.push(inner.depth);
      });
      depths.push(outer.depth);
    });
    expect(depths).toEqual([0, 1, 0]);
  });

  it("retries retryable errors with injected sleep and succeeds on a later attempt", async () => {
    const driver = new MemoryDatabaseDriver();
    const sleeps: number[] = [];
    const manager = new DatabaseTransactionManager({
      driver,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    let attempts = 0;
    const result = await manager.run(async () => {
      attempts += 1;
      if (attempts < 3) throw new TransactionConflictError("contended");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it("gives up after maxAttempts and rethrows the retryable error", async () => {
    const driver = new MemoryDatabaseDriver();
    const manager = new DatabaseTransactionManager({
      driver,
      retry: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10 },
      sleep: async () => undefined,
    });
    let attempts = 0;
    await expect(
      manager.run(async () => {
        attempts += 1;
        throw new TransactionDeadlockError("cycle");
      }),
    ).rejects.toBeInstanceOf(TransactionDeadlockError);
    expect(attempts).toBe(2);
  });

  it("never retries non-retryable errors", async () => {
    const driver = new MemoryDatabaseDriver();
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });
    let attempts = 0;
    await expect(
      manager.run(async () => {
        attempts += 1;
        throw new TransactionRollbackError();
      }),
    ).rejects.toBeInstanceOf(TransactionRollbackError);
    expect(attempts).toBe(1);
  });

  it("supports per-call retry policies", async () => {
    const driver = new MemoryDatabaseDriver();
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });
    let attempts = 0;
    await expect(
      manager.run(
        async () => {
          attempts += 1;
          throw new TransactionConflictError("nope");
        },
        { retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } },
      ),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(attempts).toBe(1);
  });
});

describe("isRetryableDatabaseError", () => {
  it("classifies conflict and deadlock as retryable", () => {
    expect(isRetryableDatabaseError(new TransactionConflictError("x"))).toBe(true);
    expect(isRetryableDatabaseError(new TransactionDeadlockError("x"))).toBe(true);
    expect(isRetryableDatabaseError(new OptimisticLockError(SCOPE, COLLECTION, "m"))).toBe(false);
    expect(isRetryableDatabaseError(new Error("plain"))).toBe(false);
    expect(isRetryableDatabaseError("string")).toBe(false);
  });
});

/**
 * A driver decorator that bumps a record's revision *between* the read and
 * the CAS inside a transaction — simulating a concurrent writer between the
 * two optimistic-lock steps. Deterministic.
 */
class RacingDriver implements DatabaseDriver {
  readonly backing = "memory" as const;
  private readonly inner = new MemoryDatabaseDriver();
  private armed = false;

  /** Arm the race: the next CAS inside a transaction sees a stale revision. */
  arm(): void {
    this.armed = true;
  }

  readAll(scope: string, collection: DatabaseCollectionKind): Promise<readonly DatabaseRecord<unknown>[]> {
    return this.inner.readAll(scope, collection);
  }

  upsertAll(
    scope: string,
    collection: DatabaseCollectionKind,
    records: readonly DatabaseRecord<unknown>[],
  ): Promise<void> {
    return this.inner.upsertAll(scope, collection, records);
  }

  deleteMany(
    scope: string,
    collection: DatabaseCollectionKind,
    recordIds: readonly string[],
  ): Promise<void> {
    return this.inner.deleteMany(scope, collection, recordIds);
  }

  clearCollection(scope: string, collection: DatabaseCollectionKind): Promise<void> {
    return this.inner.clearCollection(scope, collection);
  }

  compareAndSwap(
    scope: string,
    collection: DatabaseCollectionKind,
    record: DatabaseRecord<unknown>,
    expectedRevision: number,
  ): Promise<void> {
    return this.inner.compareAndSwap(scope, collection, record, expectedRevision);
  }

  async transaction<T>(work: (handle: DatabaseTransactionHandle) => Promise<T>): Promise<T> {
    return this.inner.transaction(async (handle) => {
      const racing: DatabaseTransactionHandle = {
        depth: handle.depth,
        readAll: (scope, collection) => handle.readAll(scope, collection),
        upsertAll: (scope, collection, records) => handle.upsertAll(scope, collection, records),
        deleteMany: (scope, collection, recordIds) => handle.deleteMany(scope, collection, recordIds),
        clearCollection: (scope, collection) => handle.clearCollection(scope, collection),
        compareAndSwap: async (scope, collection, record, expectedRevision) => {
          if (this.armed) {
            this.armed = false;
            const current = await handle.readAll(scope, collection);
            const found = current.find((r) => r.recordId === record.recordId);
            if (found !== undefined) {
              await handle.upsertAll(scope, collection, [
                createDatabaseRecord({
                  ...found,
                  revision: found.revision + 1,
                  updatedAt: "2026-08-11T10:05:00.000Z",
                }),
              ]);
            }
          }
          return handle.compareAndSwap(scope, collection, record, expectedRevision);
        },
      };
      return work(racing);
    });
  }
}

describe("DatabaseTransactionManager.withOptimisticLock", () => {
  it("reads, mutates, bumps revision and writes", async () => {
    const driver = new MemoryDatabaseDriver();
    await driver.upsertAll(SCOPE, COLLECTION, [record("mem-1", 1, { value: 1 })]);
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });

    const updated = await manager.run(async (handle) =>
      manager.withOptimisticLock<{ value: number }>(handle, SCOPE, COLLECTION, "mem-1", {
        now: "2026-08-11T10:00:00.000Z",
        mutateData: (data) => ({ ...data, value: data.value + 1 }),
      }),
    );

    expect(updated.revision).toBe(2);
    expect((updated.data as { value: number }).value).toBe(2);
    const stored = await driver.readAll(SCOPE, COLLECTION);
    expect(stored[0].revision).toBe(2);
  });

  it("throws OptimisticLockError when a concurrent writer bumps the revision between read and CAS", async () => {
    const driver = new RacingDriver();
    await driver.upsertAll(SCOPE, COLLECTION, [record("mem-1", 1)]);
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });
    driver.arm();

    await expect(
      manager.run(async (handle) =>
        manager.withOptimisticLock(handle, SCOPE, COLLECTION, "mem-1", {
          now: NOW,
          mutateData: (data) => ({ ...data }),
        }),
      ),
    ).rejects.toBeInstanceOf(OptimisticLockError);

    // The conflicting write and our write both happened inside the rolled-back
    // transaction — the record is untouched (revision 1, original data).
    const stored = await driver.readAll(SCOPE, COLLECTION);
    expect(stored[0].revision).toBe(1);
    expect(stored[0].data).toEqual({});
  });

  it("throws DatabaseRecordNotFoundError for missing records", async () => {
    const driver = new MemoryDatabaseDriver();
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });
    await expect(
      manager.run(async (handle) =>
        manager.withOptimisticLock(handle, SCOPE, COLLECTION, "ghost", { now: NOW }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("leaves data unchanged when no mutation is supplied", async () => {
    const driver = new MemoryDatabaseDriver();
    await driver.upsertAll(SCOPE, COLLECTION, [record("mem-1", 1, { value: 7 })]);
    const manager = new DatabaseTransactionManager({ driver, sleep: async () => undefined });
    const updated = await manager.run(async (handle) =>
      manager.withOptimisticLock(handle, SCOPE, COLLECTION, "mem-1", { now: NOW }),
    );
    expect((updated.data as { value: number }).value).toBe(7);
    expect(updated.revision).toBe(2);
  });
});
