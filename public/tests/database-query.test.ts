import { describe, it, expect } from "vitest";
import {
  buildDatabaseQuery,
  withDatabaseQuery,
  executeDatabaseQuery,
  matchesOperator,
  matchesQuery,
  compareBySort,
  DEFAULT_DATABASE_SORT,
  sortBy,
  filterEquals,
  filterIn,
  type DatabaseQuery,
  type QueryResult,
} from "@/lib/database/query";
import {
  createDatabaseRecord,
  type DatabaseCollectionKind,
  type DatabaseRecord,
} from "@/lib/database/types";

const NOW = "2026-08-11T09:00:00.000Z";

interface Payload {
  title: string;
  tags: string[];
  score: number;
}

function rec(
  recordId: string,
  partial: {
    collection?: DatabaseCollectionKind;
    scope?: string;
    createdAt?: string;
    updatedAt?: string;
    archived?: boolean;
    deletedAt?: string | null;
    revision?: number;
    version?: number;
    data?: Partial<Payload>;
  } = {},
): DatabaseRecord<Payload> {
  return createDatabaseRecord<Payload>({
    scope: partial.scope ?? "user-1",
    collection: partial.collection ?? "memory",
    recordId,
    createdAt: partial.createdAt ?? NOW,
    updatedAt: partial.updatedAt ?? NOW,
    archived: partial.archived ?? false,
    deletedAt: partial.deletedAt ?? null,
    revision: partial.revision ?? 1,
    version: partial.version ?? 1,
    data: {
      title: `title-${recordId}`,
      tags: ["a", "b"],
      score: 1,
      ...partial.data,
    },
  });
}

function dataset(): DatabaseRecord<Payload>[] {
  return [
    rec("m-1", { updatedAt: "2026-08-01T00:00:00.000Z", data: { title: "Alpha", score: 5 } }),
    rec("m-2", { updatedAt: "2026-08-02T00:00:00.000Z", data: { title: "beta", score: 3 } }),
    rec("m-3", { updatedAt: "2026-08-03T00:00:00.000Z", archived: true }),
    rec("m-4", { updatedAt: "2026-08-04T00:00:00.000Z", deletedAt: "2026-08-10T00:00:00.000Z" }),
    rec("m-5", { updatedAt: "2026-08-05T00:00:00.000Z", scope: "user-2" }),
    rec("m-6", { updatedAt: "2026-08-06T00:00:00.000Z", revision: 4 }),
  ];
}

describe("buildDatabaseQuery", () => {
  it("applies defaults: sort newest-first, limit 100, active-only", () => {
    const q = buildDatabaseQuery({});
    expect(q.sort).toEqual(DEFAULT_DATABASE_SORT);
    expect(q.limit).toBe(100);
    expect(q.offset).toBe(0);
    expect(q.includeArchived).toBe(false);
    expect(q.includeDeleted).toBe(false);
    expect(q.collection).toBeUndefined();
    expect(q.scope).toBeUndefined();
    expect(Object.isFrozen(q)).toBe(true);
    expect(Object.isFrozen(q.filters)).toBe(true);
    expect(Object.isFrozen(q.sort)).toBe(true);
  });

  it("honors every option and copies arrays", () => {
    const filters = [filterEquals("collection", "memory")];
    const sorts = [sortBy("recordId")];
    const q = buildDatabaseQuery({
      collection: "memory",
      scope: "user-1",
      filters,
      sort: sorts,
      limit: 10,
      offset: 20,
      after: "m-3",
      includeArchived: true,
      includeDeleted: true,
      search: "alpha",
      updatedSince: "2026-08-01T00:00:00.000Z",
      updatedUntil: "2026-08-09T00:00:00.000Z",
      fields: ["id", "recordId"],
    });
    expect(q.collection).toBe("memory");
    expect(q.scope).toBe("user-1");
    expect(q.limit).toBe(10);
    expect(q.offset).toBe(20);
    expect(q.after).toBe("m-3");
    expect(q.includeArchived).toBe(true);
    expect(q.includeDeleted).toBe(true);
    expect(q.search).toBe("alpha");
    expect(q.updatedSince).toBe("2026-08-01T00:00:00.000Z");
    expect(q.updatedUntil).toBe("2026-08-09T00:00:00.000Z");
    expect(q.fields).toEqual(["id", "recordId"]);
    expect(q.filters).toEqual(filters);
    expect(q.sort).toEqual(sorts);
    expect(q.filters).not.toBe(filters);
    expect(q.sort).not.toBe(sorts);
    filters.push(filterEquals("scope", "s"));
    expect(q.filters).toHaveLength(1);
  });

  it("is immutable: modifying the result is impossible and derived queries are successors", () => {
    const q = buildDatabaseQuery({});
    expect(Object.isFrozen(q)).toBe(true);
    const next = withDatabaseQuery(q, { limit: 5, scope: "user-2" });
    expect(next.limit).toBe(5);
    expect(next.scope).toBe("user-2");
    expect(q.limit).toBe(100);
    expect(q.scope).toBeUndefined();
    // Patch merges instead of resetting unspecified fields.
    const merged = withDatabaseQuery(q, { limit: 5 });
    expect(merged.sort).toEqual(DEFAULT_DATABASE_SORT);
  });
});

describe("matchesOperator", () => {
  it("supports comparison operators", () => {
    expect(matchesOperator(5, "eq", 5)).toBe(true);
    expect(matchesOperator(5, "eq", 6)).toBe(false);
    expect(matchesOperator(5, "neq", 6)).toBe(true);
    expect(matchesOperator(5, "lt", 6)).toBe(true);
    expect(matchesOperator(5, "lte", 5)).toBe(true);
    expect(matchesOperator(5, "gt", 4)).toBe(true);
    expect(matchesOperator(5, "gte", 5)).toBe(true);
    expect(matchesOperator(5, "gt", 5)).toBe(false);
  });

  it("supports string and membership operators", () => {
    expect(matchesOperator("hello world", "contains", "world")).toBe(true);
    expect(matchesOperator("hello", "startsWith", "he")).toBe(true);
    expect(matchesOperator("hello", "endsWith", "lo")).toBe(true);
    expect(matchesOperator("hello", "contains", "xyz")).toBe(false);
    expect(matchesOperator("x", "in", ["a", "x"])).toBe(true);
    expect(matchesOperator("x", "in", ["a", "b"])).toBe(false);
    expect(matchesOperator("x", "notIn", ["a", "b"])).toBe(true);
    expect(matchesOperator("x", "notIn", ["a", "x"])).toBe(false);
  });

  it("supports null operators", () => {
    expect(matchesOperator(null, "isNull", undefined)).toBe(true);
    expect(matchesOperator(undefined, "isNull", undefined)).toBe(true);
    expect(matchesOperator("x", "isNull", undefined)).toBe(false);
    expect(matchesOperator("x", "isNotNull", undefined)).toBe(true);
    expect(matchesOperator(null, "isNotNull", undefined)).toBe(false);
  });
});

describe("matchesQuery", () => {
  it("filters lifecycle markers by default", () => {
    const records = dataset();
    const active = records.filter((r) => matchesQuery(r, buildDatabaseQuery({})));
    expect(active.map((r) => r.recordId)).toEqual(["m-1", "m-2", "m-5", "m-6"]);
  });

  it("includes archived/deleted when requested", () => {
    const q = buildDatabaseQuery({ includeArchived: true, includeDeleted: true });
    expect(recordsMatching(dataset(), q).map((r) => r.recordId).sort()).toEqual(
      ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6"],
    );
  });

  it("applies collection and scope filters", () => {
    const q = buildDatabaseQuery({ scope: "user-2" });
    expect(recordsMatching(dataset(), q).map((r) => r.recordId)).toEqual(["m-5"]);
    const q2 = buildDatabaseQuery({ collection: "digest" });
    expect(recordsMatching(dataset(), q2)).toHaveLength(0);
  });

  it("applies explicit filter clauses", () => {
    const q = buildDatabaseQuery({ filters: [filterEquals("revision", 4)] });
    expect(recordsMatching(dataset(), q).map((r) => r.recordId)).toEqual(["m-6"]);
    const q2 = buildDatabaseQuery({
      filters: [filterIn("recordId", ["m-1", "m-3"])],
      includeArchived: true,
    });
    expect(recordsMatching(dataset(), q2).map((r) => r.recordId).sort()).toEqual(["m-1", "m-3"]);
  });

  it("applies data-level filters", () => {
    const q = buildDatabaseQuery({
      filters: [{ field: "data", operator: "eq", value: { title: "Alpha", tags: ["a", "b"], score: 5 } }],
    });
    expect(recordsMatching(dataset(), q).map((r) => r.recordId)).toEqual(["m-1"]);
  });

  it("applies date ranges", () => {
    const q = buildDatabaseQuery({
      updatedSince: "2026-08-03T00:00:00.000Z",
      updatedUntil: "2026-08-04T23:59:59.999Z",
      includeArchived: true,
      includeDeleted: true,
    });
    const ids = recordsMatching(dataset(), q).map((r) => r.recordId).sort();
    expect(ids).toEqual(["m-3", "m-4"]);
  });

  it("applies free-text search across recordId, scope and data JSON", () => {
    expect(recordsMatching(dataset(), buildDatabaseQuery({ search: "alpha" })).map((r) => r.recordId)).toEqual(["m-1"]);
    expect(recordsMatching(dataset(), buildDatabaseQuery({ search: "BETA" })).map((r) => r.recordId)).toEqual(["m-2"]);
    expect(recordsMatching(dataset(), buildDatabaseQuery({ search: "user-2" })).map((r) => r.recordId)).toEqual(["m-5"]);
    expect(recordsMatching(dataset(), buildDatabaseQuery({ search: "title-m-6" })).map((r) => r.recordId)).toEqual(["m-6"]);
  });
});

function recordsMatching<T>(records: readonly DatabaseRecord<T>[], q: DatabaseQuery): DatabaseRecord<T>[] {
  return records.filter((r) => matchesQuery(r, q));
}

describe("compareBySort", () => {
  it("sorts by updatedAt desc with stable tie-break", () => {
    const a = rec("a", { updatedAt: "2026-08-01T00:00:00.000Z" });
    const b = rec("b", { updatedAt: "2026-08-02T00:00:00.000Z" });
    expect(compareBySort(a, b, DEFAULT_DATABASE_SORT)).toBeGreaterThan(0);
    expect(compareBySort(b, a, DEFAULT_DATABASE_SORT)).toBeLessThan(0);
    expect(compareBySort(a, a, DEFAULT_DATABASE_SORT)).toBe(0);
  });

  it("ties break on recordId ascending for total order", () => {
    const a = rec("a", { updatedAt: NOW });
    const b = rec("b", { updatedAt: NOW });
    expect(compareBySort(a, b, DEFAULT_DATABASE_SORT)).toBeLessThan(0);
  });

  it("supports custom sort fields, nested data paths and directions", () => {
    const a = rec("a", { data: { score: 1 } });
    const b = rec("b", { data: { score: 9 } });
    expect(compareBySort(a, b, [sortBy("data", "desc", "score")])).toBeGreaterThan(0);
    expect(compareBySort(a, b, [sortBy("data", "asc", "score")])).toBeLessThan(0);
    expect(compareBySort(a, b, [sortBy("recordId", "desc")])).toBeGreaterThan(0);
  });

  it("missing nested data paths sort as null-first", () => {
    const withScore = rec("a", { data: { score: 5 } });
    const without = rec("b", { data: {} });
    expect(compareBySort(without, withScore, [sortBy("data", "asc", "score")])).toBeLessThan(0);
  });
});

describe("executeDatabaseQuery", () => {
  it("returns detached immutable results in sort order", () => {
    const result = executeDatabaseQuery(dataset(), buildDatabaseQuery({}));
    expect(result.items.map((r) => r.recordId)).toEqual(["m-6", "m-5", "m-2", "m-1"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.total).toBe(4);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(100);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it("never aliases caller data", () => {
    const source = dataset();
    const result = executeDatabaseQuery(source, buildDatabaseQuery({}));
    expect(result.items[0]).not.toBe(source.find((r) => r.recordId === result.items[0].recordId));
    (result.items[0].data as Payload).title = "MUTATED";
    expect(source.find((r) => r.recordId === result.items[0].recordId)?.data.title).not.toBe("MUTATED");
  });

  it("paginates by offset/limit and reports hasMore", () => {
    const page1 = executeDatabaseQuery(dataset(), buildDatabaseQuery({ limit: 2 }));
    expect(page1.items.map((r) => r.recordId)).toEqual(["m-6", "m-5"]);
    expect(page1.hasMore).toBe(true);
    const page2 = executeDatabaseQuery(dataset(), buildDatabaseQuery({ limit: 2, offset: 2 }));
    expect(page2.items.map((r) => r.recordId)).toEqual(["m-2", "m-1"]);
    expect(page2.hasMore).toBe(false);
  });

  it("paginates by cursor (resume-after semantics)", () => {
    const page1 = executeDatabaseQuery(dataset(), buildDatabaseQuery({ limit: 2 }));
    expect(page1.nextCursor).toBe("m-5");
    const page2 = executeDatabaseQuery(dataset(), buildDatabaseQuery({ limit: 2, after: page1.nextCursor }));
    expect(page2.items.map((r) => r.recordId)).toEqual(["m-2", "m-1"]);
    expect(page2.hasMore).toBe(false);
  });

  it("cursor on an unknown recordId yields an empty page (never throws)", () => {
    const result = executeDatabaseQuery(dataset(), buildDatabaseQuery({ after: "does-not-exist" }));
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(4);
  });

  it("respects limit 0 and empty datasets", () => {
    const none = executeDatabaseQuery([], buildDatabaseQuery({}));
    expect(none.items).toHaveLength(0);
    expect(none.total).toBe(0);
    expect(none.hasMore).toBe(false);
    const zero = executeDatabaseQuery(dataset(), buildDatabaseQuery({ limit: 0 }));
    expect(zero.items).toHaveLength(0);
    expect(zero.total).toBe(4);
  });

  it("returns consistent pagination across pages", () => {
    const all: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page: QueryResult<Payload> = executeDatabaseQuery(
        dataset(),
        buildDatabaseQuery({ limit: 2, after: cursor }),
      );
      all.push(...page.items.map((r) => r.recordId));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== undefined && guard < 10);
    expect(all).toEqual(["m-6", "m-5", "m-2", "m-1"]);
  });

  it("is deterministic across executions", () => {
    const a = executeDatabaseQuery(dataset(), buildDatabaseQuery({ limit: 3 }));
    const b = executeDatabaseQuery(dataset(), buildDatabaseQuery({ limit: 3 }));
    expect(a.items.map((r) => r.recordId)).toEqual(b.items.map((r) => r.recordId));
  });
});
