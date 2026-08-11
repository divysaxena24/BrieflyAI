import { describe, it, expect } from "vitest";
import {
  RetentionEngine,
  retentionExpired,
  retentionOlderThan,
  retentionOrphans,
  createRetentionEngine,
  type DatabaseOrphanPredicate,
} from "@/lib/database/retention";
import { MemoryDatabaseDriver } from "@/lib/database/memoryDriver";
import { createDatabaseRecord, type DatabaseRecord } from "@/lib/database/types";
import { createDatabaseRetention } from "@/lib/database/types";

const NOW = "2026-08-11T09:00:00.000Z";
const SCOPE = "user-1";

interface Payload {
  id: string;
  title: string;
  expiresAt?: string;
  ref?: string;
}

function record(
  collection: "memory" | "event" | "job",
  recordId: string,
  opts: { updatedAt?: string; expiresAt?: string; ref?: string; deletedAt?: string | null } = {},
): DatabaseRecord<Payload> {
  return createDatabaseRecord<Payload>({
    scope: SCOPE,
    collection,
    recordId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: opts.updatedAt ?? "2026-08-01T00:00:00.000Z",
    deletedAt: opts.deletedAt ?? null,
    data: {
      id: recordId,
      title: `title-${recordId}`,
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
    },
  });
}

async function seed(driver: MemoryDatabaseDriver): Promise<void> {
  await driver.upsertAll(SCOPE, "memory", [
    record("memory", "m-new", { updatedAt: "2026-08-10T00:00:00.000Z" }),
    record("memory", "m-old", { updatedAt: "2026-01-15T00:00:00.000Z" }),
    record("memory", "m-ancient", { updatedAt: "2025-06-01T00:00:00.000Z" }),
  ]);
  await driver.upsertAll(SCOPE, "event", [
    record("event", "e-expired", {
      expiresAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    record("event", "e-future", {
      expiresAt: "2027-01-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }),
    record("event", "e-none"),
  ]);
  await driver.upsertAll(SCOPE, "job", [
    record("job", "j-orphan", { ref: "ghost-1" }),
    record("job", "j-kept", { ref: "real-1" }),
  ]);
}

const orphanPredicate: DatabaseOrphanPredicate = (r) => {
  const ref = (r.data as Payload).ref;
  return ref !== undefined && ref.startsWith("ghost-");
};

describe("RetentionEngine.previewCleanup", () => {
  it("previews age-based policies without writing anything", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [
        retentionOlderThan("memory", "archive", 90, NOW),
        retentionOlderThan("event", "soft_delete", 30, NOW),
      ],
    });
    const preview = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    expect(preview.preview).toBe(true);
    const memoryEntry = preview.applied.find((a) => a.collection === "memory");
    const eventEntry = preview.applied.find((a) => a.collection === "event");
    // m-old (Jan 15) and m-ancient (Jun 2025) are older than 90 days.
    expect(memoryEntry?.action).toBe("archive");
    expect([...memoryEntry!.recordIds].sort()).toEqual(["m-ancient", "m-old"]);
    // e-expired is older than 30 days (Jan 1); e-future (2027) is not.
    expect(eventEntry?.recordIds).toEqual(["e-expired"]);
    // Nothing was written (3 memories + 3 events + 2 jobs = 8).
    expect(driver.count()).toBe(8);
  });

  it("honors keepCount by protecting the newest records", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionOlderThan("memory", "archive", 90, NOW, 1)],
    });
    const preview = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    const memoryEntry = preview.applied.find((a) => a.collection === "memory");
    // Newest (m-new) is protected; m-ancient is the oldest of the actionable.
    expect(memoryEntry?.recordIds).toEqual(["m-ancient"]);
  });

  it("previews expired-only policies", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionExpired("event", "soft_delete", NOW)],
    });
    const preview = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    const entry = preview.applied.find((a) => a.collection === "event");
    expect(entry?.recordIds).toEqual(["e-expired"]);
  });

  it("matches nested expiry fields via dataPath (engine record shapes)", async () => {
    const driver = new MemoryDatabaseDriver();
    await driver.upsertAll(SCOPE, "memory", [
      createDatabaseRecord({
        scope: SCOPE,
        collection: "memory",
        recordId: "m-expired-meta",
        createdAt: NOW,
        data: {
          id: "m-expired-meta",
          metadata: { expiresAt: "2026-01-01T00:00:00.000Z" },
        },
      }),
      createDatabaseRecord({
        scope: SCOPE,
        collection: "memory",
        recordId: "m-live-meta",
        createdAt: NOW,
        data: {
          id: "m-live-meta",
          metadata: { expiresAt: "2027-01-01T00:00:00.000Z" },
        },
      }),
    ]);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionExpired("memory", "archive", NOW, "metadata.expiresAt")],
    });
    const preview = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    const entry = preview.applied.find((a) => a.collection === "memory");
    expect(entry?.recordIds).toEqual(["m-expired-meta"]);
  });

  it("skips already-archived records for archive policies", async () => {
    const driver = new MemoryDatabaseDriver();
    await driver.upsertAll(SCOPE, "memory", [
      createDatabaseRecord({
        scope: SCOPE,
        collection: "memory",
        recordId: "m-archived",
        createdAt: NOW,
        updatedAt: "2025-01-01T00:00:00.000Z",
        archived: true,
        archivedAt: "2026-01-01T00:00:00.000Z",
        data: { id: "m-archived" },
      }),
    ]);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionOlderThan("memory", "archive", 30, NOW)],
    });
    const preview = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    expect(preview.applied).toHaveLength(0);
  });

  it("previews orphan-only policies with an injected predicate", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionOrphans("job", "delete", NOW)],
      isOrphan: orphanPredicate,
    });
    const preview = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    const entry = preview.applied.find((a) => a.collection === "job");
    expect(entry?.action).toBe("delete");
    expect(entry?.recordIds).toEqual(["j-orphan"]);
  });

  it("skips policies with no targets (empty applied)", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionOlderThan("digest", "delete", 1, NOW)],
    });
    const preview = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    expect(preview.applied).toHaveLength(0);
    expect(preview.recordCount).toBe(0);
  });

  it("never targets already soft-deleted records", async () => {
    const driver = new MemoryDatabaseDriver();
    await driver.upsertAll(SCOPE, "memory", [
      record("memory", "m-deleted", { updatedAt: "2025-01-01T00:00:00.000Z", deletedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionOlderThan("memory", "archive", 30, NOW)],
    });
    const preview = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    expect(preview.applied).toHaveLength(0);
  });

  it("is deterministic across calls", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionOlderThan("memory", "archive", 90, NOW, 1)],
    });
    const a = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    const b = await engine.previewCleanup({ scope: SCOPE, now: NOW });
    expect(a.id).toBe(b.id);
    expect(a.applied).toEqual(b.applied);
  });
});

describe("RetentionEngine.runCleanup", () => {
  it("applies archive and soft-delete actions", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionOlderThan("memory", "archive", 90, NOW)],
    });
    const cleanup = await engine.runCleanup({ scope: SCOPE, now: NOW });
    expect(cleanup.preview).toBe(false);
    const stored = await driver.readAll(SCOPE, "memory");
    const archived = stored.filter((r) => r.archived).map((r) => r.recordId);
    expect(archived.sort()).toEqual(["m-ancient", "m-old"]);
    expect(cleanup.recordCount).toBe(2);
  });

  it("applies soft_delete by setting deletedAt", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionExpired("event", "soft_delete", NOW)],
    });
    await engine.runCleanup({ scope: SCOPE, now: NOW });
    const stored = await driver.readAll(SCOPE, "event");
    const eExpired = stored.find((r) => r.recordId === "e-expired");
    expect(eExpired?.deletedAt).toBe(NOW);
    const eFuture = stored.find((r) => r.recordId === "e-future");
    expect(eFuture?.deletedAt).toBeNull();
  });

  it("applies hard delete by removing rows", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionOrphans("job", "delete", NOW)],
      isOrphan: orphanPredicate,
    });
    await engine.runCleanup({ scope: SCOPE, now: NOW });
    const stored = await driver.readAll(SCOPE, "job");
    expect(stored.map((r) => r.recordId)).toEqual(["j-kept"]);
  });

  it("runs a policy subset when provided", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const policy = retentionOlderThan("memory", "archive", 90, NOW);
    const engine = new RetentionEngine({
      driver,
      policies: [
        policy,
        retentionOlderThan("event", "soft_delete", 30, NOW),
      ],
    });
    await engine.runCleanup({ scope: SCOPE, now: NOW, policies: [policy] });
    // Only the memory policy ran.
    const events = await driver.readAll(SCOPE, "event");
    expect(events.every((r) => r.deletedAt === null)).toBe(true);
    const memories = await driver.readAll(SCOPE, "memory");
    expect(memories.some((r) => r.archived)).toBe(true);
  });

  it("bumps the revision of acted-on records", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = new RetentionEngine({
      driver,
      policies: [retentionOlderThan("memory", "archive", 90, NOW)],
    });
    await engine.runCleanup({ scope: SCOPE, now: NOW });
    const stored = await driver.readAll(SCOPE, "memory");
    const archived = stored.find((r) => r.recordId === "m-old");
    expect(archived?.revision).toBe(2);
    const untouched = stored.find((r) => r.recordId === "m-new");
    expect(untouched?.revision).toBe(1);
  });
});

describe("RetentionEngine.statistics", () => {
  it("aggregates deterministic statistics over every collection", async () => {
    const driver = new MemoryDatabaseDriver();
    await seed(driver);
    const engine = createRetentionEngine({ driver });
    const stats = await engine.statistics(SCOPE);
    expect(stats).toHaveLength(7);
    const memory = stats.find((s) => s.collection === "memory");
    expect(memory?.total).toBe(3);
    expect(memory?.active).toBe(3);
    expect(memory?.scope).toBe(SCOPE);
    const event = stats.find((s) => s.collection === "event");
    expect(event?.total).toBe(3);
    const job = stats.find((s) => s.collection === "job");
    expect(job?.total).toBe(2);
  });
});

describe("policy helpers", () => {
  it("build deterministic convenience policies", () => {
    expect(retentionOlderThan("memory", "archive", 30, NOW).id).toBe(
      retentionOlderThan("memory", "archive", 30, NOW).id,
    );
    expect(retentionExpired("event", "delete", NOW).expiredOnly).toBe(true);
    expect(retentionOrphans("job", "delete", NOW).orphanOnly).toBe(true);
    const created = createDatabaseRetention({
      collection: "event",
      action: "soft_delete",
      createdAt: NOW,
    });
    expect(created.id.startsWith("retention-")).toBe(true);
    expect(Object.isFrozen(created)).toBe(true);
  });
});
