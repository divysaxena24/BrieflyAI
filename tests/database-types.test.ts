import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  cloneDatabaseRecord,
  createDatabaseCleanup,
  createDatabaseCollection,
  createDatabaseCursor,
  createDatabaseIndex,
  createDatabaseMetadata,
  createDatabaseRecord,
  createDatabaseRetention,
  createDatabaseSnapshot,
  createDatabaseStatistics,
  createDatabaseTransaction,
  createDatabaseVersion,
  DATABASE_COLLECTION_KINDS,
  databaseRecordIdFor,
  estimateDatabaseSize,
  freezeDatabaseRecord,
  hashDatabaseRecord,
  timestampMillis,
  DAY_MS,
  type DatabaseRecord,
} from "@/lib/database/types";
import { hashString } from "@/lib/hash";

const NOW = "2026-08-11T09:00:00.000Z";

function record(overrides: Partial<Parameters<typeof createDatabaseRecord>[0]> = {}): DatabaseRecord<{ name: string; nested: { n: number } }> {
  return createDatabaseRecord<{ name: string; nested: { n: number } }>({
    scope: "user-1",
    collection: "memory",
    recordId: "mem-1",
    createdAt: NOW,
    data: { name: "alpha", nested: { n: 1 } },
    ...overrides,
  });
}

describe("createDatabaseRecord", () => {
  it("builds an immutable record with deterministic id", () => {
    const a = record();
    const b = record();
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(`record-${hashString("user-1:memory:mem-1")}`);
    expect(a.id.startsWith("record-")).toBe(true);
    expect(a.scope).toBe("user-1");
    expect(a.collection).toBe("memory");
    expect(a.recordId).toBe("mem-1");
  });

  it("derives distinct ids for distinct scope/collection/recordId", () => {
    const ids = [
      record().id,
      record({ scope: "user-2" }).id,
      record({ collection: "digest" }).id,
      record({ recordId: "mem-2" }).id,
    ];
    expect(new Set(ids).size).toBe(4);
  });

  it("applies defaults: revision 1, version 1, active, not archived", () => {
    const r = record();
    expect(r.revision).toBe(1);
    expect(r.version).toBe(1);
    expect(r.archived).toBe(false);
    expect(r.archivedAt).toBeNull();
    expect(r.deletedAt).toBeNull();
    expect(r.updatedAt).toBe(r.createdAt);
  });

  it("honors explicit overrides", () => {
    const r = record({
      id: "custom-id",
      revision: 5,
      version: 3,
      archived: true,
      archivedAt: "2026-08-10T00:00:00.000Z",
      deletedAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-11T08:00:00.000Z",
    });
    expect(r.id).toBe("custom-id");
    expect(r.revision).toBe(5);
    expect(r.version).toBe(3);
    expect(r.archived).toBe(true);
    expect(r.archivedAt).toBe("2026-08-10T00:00:00.000Z");
    expect(r.deletedAt).toBe("2026-08-09T00:00:00.000Z");
    expect(r.updatedAt).toBe("2026-08-11T08:00:00.000Z");
  });

  it("supports every collection kind", () => {
    for (const collection of DATABASE_COLLECTION_KINDS) {
      const r = createDatabaseRecord({
        scope: "s",
        collection,
        recordId: "r",
        createdAt: NOW,
        data: {},
      });
      expect(r.collection).toBe(collection);
    }
  });
});

describe("databaseRecordIdFor", () => {
  it("is deterministic and prefixed", () => {
    expect(databaseRecordIdFor("a", "memory", "m1")).toBe(databaseRecordIdFor("a", "memory", "m1"));
    expect(databaseRecordIdFor("a", "memory", "m1")).not.toBe(databaseRecordIdFor("a", "memory", "m2"));
    expect(databaseRecordIdFor("a", "memory", "m1")).not.toBe(databaseRecordIdFor("b", "memory", "m1"));
    expect(databaseRecordIdFor("a", "memory", "m1")).not.toBe(databaseRecordIdFor("a", "job", "m1"));
    expect(databaseRecordIdFor("a", "memory", "m1").startsWith("record-")).toBe(true);
  });
});

describe("createDatabaseCollection", () => {
  it("builds frozen descriptors with deterministic ids", () => {
    const a = createDatabaseCollection({ kind: "memory", name: "memories", createdAt: NOW });
    const b = createDatabaseCollection({ kind: "memory", name: "memories", createdAt: NOW });
    expect(a.id).toBe(b.id);
    expect(a.id.startsWith("collection-")).toBe(true);
    expect(a.kind).toBe("memory");
    expect(a.name).toBe("memories");
    expect(Object.isFrozen(a)).toBe(true);
    expect(
      createDatabaseCollection({ kind: "memory", name: "memories", createdAt: NOW }).id,
    ).not.toBe(createDatabaseCollection({ kind: "job", name: "memories", createdAt: NOW }).id);
  });
});

describe("cloneDatabaseRecord", () => {
  it("deep-clones nested data", () => {
    const r = record();
    const clone = cloneDatabaseRecord(r);
    expect(clone).toEqual(r);
    expect(clone.data).not.toBe(r.data);
    expect(clone.data.nested).not.toBe(r.data.nested);
  });

  it("detaches: mutating the clone does not affect the original", () => {
    const r = record();
    const clone = cloneDatabaseRecord(r);
    (clone.data as { name: string }).name = "changed";
    (clone.data.nested as { n: number }).n = 99;
    expect(r.data.name).toBe("alpha");
    expect(r.data.nested.n).toBe(1);
  });

  it("detaches: mutating the original does not affect the clone", () => {
    const r = record();
    const clone = cloneDatabaseRecord(r);
    (r.data as { name: string }).name = "changed";
    expect(clone.data.name).toBe("alpha");
  });

  it("returns an unfrozen detached copy", () => {
    const r = record();
    const clone = cloneDatabaseRecord(r);
    expect(Object.isFrozen(clone)).toBe(false);
    expect(Object.isFrozen(clone.data)).toBe(false);
  });

  it("clones arrays inside data", () => {
    const r = createDatabaseRecord({
      scope: "s",
      collection: "action",
      recordId: "a1",
      createdAt: NOW,
      data: { tags: ["x", "y"] },
    });
    const clone = cloneDatabaseRecord(r);
    expect(clone.data.tags).not.toBe(r.data.tags);
    (clone.data.tags as string[]).push("z");
    expect((r.data.tags as string[]).length).toBe(2);
  });
});

describe("freezeDatabaseRecord", () => {
  it("deep-freezes the envelope and nested data", () => {
    const r = record();
    const frozen = freezeDatabaseRecord(r);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.data)).toBe(true);
    expect(Object.isFrozen(frozen.data.nested)).toBe(true);
    expect(() => {
      (frozen.data as { name: string }).name = "nope";
    }).toThrow();
    expect(() => {
      (frozen.data.nested as { n: number }).n = 2;
    }).toThrow();
  });

  it("freezes arrays inside data", () => {
    const r = createDatabaseRecord({
      scope: "s",
      collection: "workflow",
      recordId: "w1",
      createdAt: NOW,
      data: { steps: [1, 2] },
    });
    const frozen = freezeDatabaseRecord(r);
    expect(Object.isFrozen(frozen.data.steps)).toBe(true);
  });

  it("is idempotent", () => {
    const frozen = freezeDatabaseRecord(record());
    expect(freezeDatabaseRecord(frozen)).toEqual(frozen);
  });
});

describe("hashDatabaseRecord / canonicalJson", () => {
  it("is stable across calls", () => {
    const r = record();
    expect(hashDatabaseRecord(r)).toBe(hashDatabaseRecord(r));
  });

  it("differs when identity or payload changes", () => {
    const base = record();
    expect(hashDatabaseRecord(base)).not.toBe(hashDatabaseRecord(record({ recordId: "mem-2" })));
    expect(hashDatabaseRecord(base)).not.toBe(hashDatabaseRecord(record({ revision: 2 })));
    expect(hashDatabaseRecord(base)).not.toBe(
      hashDatabaseRecord(record({ data: { name: "beta", nested: { n: 1 } } })),
    );
    expect(hashDatabaseRecord(base)).not.toBe(hashDatabaseRecord(record({ deletedAt: NOW })));
  });

  it("is key-order independent thanks to canonical serialization", () => {
    const a = canonicalJson({ b: 1, a: { y: 2, x: 1 } });
    const b = canonicalJson({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"x":1,"y":2},"b":1}');
  });

  it("is stable for identical payloads built with different key orders", () => {
    const r1 = createDatabaseRecord({
      scope: "s",
      collection: "memory",
      recordId: "m",
      createdAt: NOW,
      data: { a: 1, b: 2 },
    });
    const r2 = createDatabaseRecord({
      scope: "s",
      collection: "memory",
      recordId: "m",
      createdAt: NOW,
      data: { b: 2, a: 1 },
    });
    expect(hashDatabaseRecord(r1)).toBe(hashDatabaseRecord(r2));
  });
});

describe("estimateDatabaseSize", () => {
  it("is deterministic and positive", () => {
    const r = record();
    expect(estimateDatabaseSize(r)).toBe(estimateDatabaseSize(r));
    expect(estimateDatabaseSize(r)).toBeGreaterThan(0);
  });

  it("grows with larger payloads", () => {
    const small = record({ data: { name: "a", nested: { n: 1 } } });
    const large = record({ data: { name: "a-very-long-name-indeed", nested: { n: 1 } } });
    expect(estimateDatabaseSize(large)).toBeGreaterThan(estimateDatabaseSize(small));
  });

  it("sizes the record envelope, not just data", () => {
    expect(estimateDatabaseSize(record())).toBeGreaterThan(canonicalJson(record().data).length * 2);
  });
});

describe("createDatabaseSnapshot", () => {
  it("builds a deterministic snapshot with checksum", () => {
    const r = record();
    const s1 = createDatabaseSnapshot({
      scope: "user-1",
      collection: "memory",
      takenAt: NOW,
      records: [r],
    });
    const s2 = createDatabaseSnapshot({
      scope: "user-1",
      collection: "memory",
      takenAt: NOW,
      records: [r],
    });
    expect(s1.id).toBe(s2.id);
    expect(s1.id.startsWith("snapshot-")).toBe(true);
    expect(s1.checksum).toBe(s2.checksum);
    expect(s1.recordCount).toBe(1);
    expect(s1.sizeBytes).toBe(estimateDatabaseSize(r));
    expect(s1.scope).toBe("user-1");
    expect(s1.collection).toBe("memory");
    expect(s1.takenAt).toBe(NOW);
  });

  it("detaches and freezes records", () => {
    const r = record();
    const s = createDatabaseSnapshot({ scope: "s", collection: "memory", takenAt: NOW, records: [r] });
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.records)).toBe(true);
    expect(Object.isFrozen(s.records[0])).toBe(true);
    expect(Object.isFrozen(s.records[0].data)).toBe(true);
    (r.data as { name: string }).name = "changed";
    expect((s.records[0].data as { name: string }).name).toBe("alpha");
  });

  it("checksum changes when records change", () => {
    const r = record();
    const changed = record({ revision: 2 });
    const s1 = createDatabaseSnapshot({ scope: "s", collection: "memory", takenAt: NOW, records: [r] });
    const s2 = createDatabaseSnapshot({ scope: "s", collection: "memory", takenAt: NOW, records: [changed] });
    expect(s1.checksum).not.toBe(s2.checksum);
  });

  it("distinct takenAt produces distinct snapshot ids", () => {
    const s1 = createDatabaseSnapshot({ scope: "s", collection: "memory", takenAt: NOW, records: [] });
    const s2 = createDatabaseSnapshot({ scope: "s", collection: "memory", takenAt: "2026-08-12T00:00:00.000Z", records: [] });
    expect(s1.id).not.toBe(s2.id);
  });
});

describe("createDatabaseTransaction", () => {
  it("builds a deterministic transaction descriptor", () => {
    const t1 = createDatabaseTransaction({ scope: "s", collection: "memory", startedAt: NOW });
    const t2 = createDatabaseTransaction({ scope: "s", collection: "memory", startedAt: NOW });
    expect(t1.id).toBe(t2.id);
    expect(t1.id.startsWith("tx-")).toBe(true);
    expect(t1.status).toBe("pending");
    expect(t1.depth).toBe(0);
    expect(t1.operations).toBe(0);
    expect(t1.attempt).toBe(1);
    expect(t1.settledAt).toBeUndefined();
    expect(Object.isFrozen(t1)).toBe(true);
  });

  it("honors overrides and only includes settledAt when given", () => {
    const t = createDatabaseTransaction({
      scope: "s",
      collection: "memory",
      startedAt: NOW,
      status: "committed",
      depth: 2,
      operations: 4,
      attempt: 3,
      settledAt: "2026-08-11T09:01:00.000Z",
    });
    expect(t.status).toBe("committed");
    expect(t.depth).toBe(2);
    expect(t.operations).toBe(4);
    expect(t.attempt).toBe(3);
    expect(t.settledAt).toBe("2026-08-11T09:01:00.000Z");
  });

  it("ids differ across depth/attempt/startedAt", () => {
    const ids = [
      createDatabaseTransaction({ scope: "s", collection: "memory", startedAt: NOW }).id,
      createDatabaseTransaction({ scope: "s", collection: "memory", startedAt: NOW, depth: 1 }).id,
      createDatabaseTransaction({ scope: "s", collection: "memory", startedAt: NOW, attempt: 2 }).id,
      createDatabaseTransaction({ scope: "s", collection: "job", startedAt: NOW }).id,
      createDatabaseTransaction({ scope: "s", collection: "memory", startedAt: "2026-08-12T00:00:00.000Z" }).id,
    ];
    expect(new Set(ids).size).toBe(5);
  });
});

describe("createDatabaseVersion", () => {
  it("builds deterministic version records", () => {
    const v1 = createDatabaseVersion("memory", 2);
    const v2 = createDatabaseVersion("memory", 2);
    expect(v1.id).toBe(v2.id);
    expect(v1.id.startsWith("version-")).toBe(true);
    expect(v1.collection).toBe("memory");
    expect(v1.version).toBe(2);
    expect(createDatabaseVersion("memory", 2).id).not.toBe(createDatabaseVersion("memory", 3).id);
    expect(Object.isFrozen(v1)).toBe(true);
  });
});

describe("createDatabaseIndex", () => {
  it("copies fields defensively and defaults unique to false", () => {
    const fields = ["scope", "recordId"];
    const idx = createDatabaseIndex({ name: "ix_scope_record", collection: "memory", fields });
    fields.push("hacked");
    expect(idx.fields).toEqual(["scope", "recordId"]);
    expect(idx.unique).toBe(false);
    expect(Object.isFrozen(idx.fields)).toBe(true);
    expect(Object.isFrozen(idx)).toBe(true);
  });

  it("is deterministic; id identifies collection+name, not uniqueness", () => {
    expect(createDatabaseIndex({ name: "n", collection: "memory", fields: ["a"] }).id).toBe(
      createDatabaseIndex({ name: "n", collection: "memory", fields: ["a"] }).id,
    );
    // A unique variant is the same logical index — its id stays stable.
    expect(
      createDatabaseIndex({ name: "n", collection: "memory", fields: ["a"], unique: true }).id,
    ).toBe(createDatabaseIndex({ name: "n", collection: "memory", fields: ["a"] }).id);
    // Different name or collection changes the id.
    expect(
      createDatabaseIndex({ name: "other", collection: "memory", fields: ["a"] }).id,
    ).not.toBe(createDatabaseIndex({ name: "n", collection: "memory", fields: ["a"] }).id);
    expect(
      createDatabaseIndex({ name: "n", collection: "job", fields: ["a"] }).id,
    ).not.toBe(createDatabaseIndex({ name: "n", collection: "memory", fields: ["a"] }).id);
  });
});

describe("createDatabaseCursor", () => {
  it("builds opaque deterministic cursors", () => {
    const c1 = createDatabaseCursor({ scope: "s", collection: "memory", after: "mem-9" });
    const c2 = createDatabaseCursor({ scope: "s", collection: "memory", after: "mem-9" });
    expect(c1.id).toBe(c2.id);
    expect(c1.id.startsWith("cursor-")).toBe(true);
    expect(c1.after).toBe("mem-9");
    expect(Object.isFrozen(c1)).toBe(true);
  });

  it("omits the after key when absent and differs per after", () => {
    const first = createDatabaseCursor({ scope: "s", collection: "memory" });
    expect(first.after).toBeUndefined();
    expect(first.id).not.toBe(
      createDatabaseCursor({ scope: "s", collection: "memory", after: "mem-1" }).id,
    );
  });
});

describe("createDatabaseStatistics", () => {
  it("counts total/active/archived/deleted", () => {
    const active = record();
    const archived = record({ archived: true, archivedAt: NOW });
    const deleted = record({ deletedAt: NOW });
    const stats = createDatabaseStatistics({
      scope: "user-1",
      collection: "memory",
      records: [active, archived, deleted],
    });
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(1);
    expect(stats.archived).toBe(1);
    expect(stats.deleted).toBe(1);
    expect(stats.scope).toBe("user-1");
    expect(stats.collection).toBe("memory");
    expect(Object.isFrozen(stats)).toBe(true);
  });

  it("counts sizeBytes and versionCount", () => {
    const stats = createDatabaseStatistics({
      scope: "s",
      collection: "memory",
      records: [record(), record({ revision: 2, version: 2 })],
    });
    expect(stats.sizeBytes).toBe(estimateDatabaseSize(record()) + estimateDatabaseSize(record({ revision: 2, version: 2 })));
    expect(stats.versionCount).toBe(2);
  });

  it("is deterministic per scope+collection", () => {
    const records = [record(), record({ recordId: "mem-2" })];
    expect(
      createDatabaseStatistics({ scope: "s", collection: "memory", records }).id,
    ).toBe(createDatabaseStatistics({ scope: "s", collection: "memory", records }).id);
  });
});

describe("createDatabaseMetadata", () => {
  it("builds deterministic scope metadata", () => {
    const m1 = createDatabaseMetadata({ scope: "user-1", schemaVersion: 2, createdAt: NOW });
    const m2 = createDatabaseMetadata({ scope: "user-1", schemaVersion: 2, createdAt: NOW });
    expect(m1.id).toBe(m2.id);
    expect(m1.id.startsWith("metadata-")).toBe(true);
    expect(m1.schemaVersion).toBe(2);
    expect(m1.updatedAt).toBe(NOW);
    expect(
      createDatabaseMetadata({ scope: "user-1", schemaVersion: 2, createdAt: NOW, updatedAt: "2026-08-12T00:00:00.000Z" })
        .updatedAt,
    ).toBe("2026-08-12T00:00:00.000Z");
    expect(
      createDatabaseMetadata({ scope: "user-1", schemaVersion: 2, createdAt: NOW }).id,
    ).not.toBe(createDatabaseMetadata({ scope: "user-2", schemaVersion: 2, createdAt: NOW }).id);
  });
});

describe("createDatabaseRetention", () => {
  it("builds deterministic policies from params", () => {
    const p1 = createDatabaseRetention({
      collection: "event",
      action: "soft_delete",
      olderThanDays: 30,
      keepCount: 100,
      createdAt: NOW,
    });
    const p2 = createDatabaseRetention({
      collection: "event",
      action: "soft_delete",
      olderThanDays: 30,
      keepCount: 100,
      createdAt: NOW,
    });
    expect(p1.id).toBe(p2.id);
    expect(p1.id.startsWith("retention-")).toBe(true);
    expect(p1.collection).toBe("event");
    expect(p1.action).toBe("soft_delete");
    expect(p1.olderThanDays).toBe(30);
    expect(p1.keepCount).toBe(100);
    expect(Object.isFrozen(p1)).toBe(true);
  });

  it("params change the id; omitting a param drops the key", () => {
    expect(
      createDatabaseRetention({ collection: "event", action: "delete", createdAt: NOW }).id,
    ).not.toBe(
      createDatabaseRetention({ collection: "event", action: "soft_delete", createdAt: NOW }).id,
    );
    const p = createDatabaseRetention({ collection: "event", action: "delete", createdAt: NOW });
    expect(p.olderThanDays).toBeUndefined();
    expect(p.keepCount).toBeUndefined();
    expect(p.expiredOnly).toBeUndefined();
    expect(p.orphanOnly).toBeUndefined();
  });
});

describe("createDatabaseCleanup", () => {
  it("builds deterministic cleanup results", () => {
    const c1 = createDatabaseCleanup({
      scope: "s",
      at: NOW,
      preview: false,
      applied: [
        { collection: "event", action: "soft_delete", recordIds: ["ev-1", "ev-2"] },
        { collection: "memory", action: "archive", recordIds: ["mem-1"] },
      ],
    });
    const c2 = createDatabaseCleanup({
      scope: "s",
      at: NOW,
      preview: false,
      applied: [
        { collection: "event", action: "soft_delete", recordIds: ["ev-1", "ev-2"] },
        { collection: "memory", action: "archive", recordIds: ["mem-1"] },
      ],
    });
    expect(c1.id).toBe(c2.id);
    expect(c1.id.startsWith("cleanup-")).toBe(true);
    expect(c1.preview).toBe(false);
    expect(c1.recordCount).toBe(3);
    expect(Object.isFrozen(c1)).toBe(true);
    expect(Object.isFrozen(c1.applied[0].recordIds)).toBe(true);
  });

  it("preview mode changes the id and is preserved", () => {
    const applied = [{ collection: "memory", action: "archive", recordIds: ["mem-1"] }];
    const exec = createDatabaseCleanup({ scope: "s", at: NOW, preview: false, applied });
    const prev = createDatabaseCleanup({ scope: "s", at: NOW, preview: true, applied });
    expect(exec.id).not.toBe(prev.id);
    expect(prev.preview).toBe(true);
  });

  it("defends against caller array mutation", () => {
    const applied = [{ collection: "memory", action: "archive", recordIds: ["mem-1"] }];
    const cleanup = createDatabaseCleanup({ scope: "s", at: NOW, preview: true, applied });
    applied[0].recordIds.push("mem-2");
    expect(cleanup.recordCount).toBe(1);
    expect(cleanup.applied[0].recordIds).toEqual(["mem-1"]);
  });
});

describe("time helpers", () => {
  it("converts valid ISO timestamps to epoch ms", () => {
    expect(timestampMillis("2026-08-11T09:00:00.000Z")).toBe(Date.parse("2026-08-11T09:00:00.000Z"));
    expect(timestampMillis("1970-01-01T00:00:00.000Z")).toBe(0);
  });

  it("returns -Infinity for unparseable timestamps", () => {
    expect(timestampMillis("not-a-date")).toBe(Number.NEGATIVE_INFINITY);
    expect(timestampMillis("")).toBe(Number.NEGATIVE_INFINITY);
  });

  it("exposes a deterministic day length", () => {
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe("DATABASE_COLLECTION_KINDS", () => {
  it("is frozen with every collection in canonical order", () => {
    expect(Object.isFrozen(DATABASE_COLLECTION_KINDS)).toBe(true);
    expect(DATABASE_COLLECTION_KINDS).toEqual([
      "memory",
      "conversation",
      "job",
      "digest",
      "action",
      "workflow",
      "event",
      "metadata",
      "notification",
      "notification_delivery",
      "notification_attempt",
      "notification_history",
      "notification_failure",
      "notification_deadletter",
      "notification_batch",
      "notification_queue",
      "notification_retry",
      "notification_template",
      "notification_preference",
      "notification_subscription",
      "notification_rule",
      "notification_metric",
    ]);
  });
});
