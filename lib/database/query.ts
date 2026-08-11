/**
 * Production Database Layer — pure query builders (Phase 6A STEP 6).
 *
 * A small, immutable query vocabulary applied over in-memory record arrays by
 * the repository (and used as the spec for the PostgreSQL driver). Everything
 * here is a pure function of its inputs:
 *
 * - no I/O, no state, no timestamps, no randomness;
 * - every builder returns a NEW immutable descriptor (successor pattern);
 * - results are ordered deterministically (primary: `updatedAt` desc, then
 *   `recordId` asc as a total tie-breaker) unless the caller overrides;
 * - archives / soft-deletes are filtered explicitly, never implicitly.
 *
 * `QueryResult<T>` is the immutable outcome: the matching records (deep
 * clones) plus optional offset and cursor pagination state.
 */

import {
  cloneDatabaseRecord,
  type DatabaseCollectionKind,
  type DatabaseRecord,
} from "@/lib/database/types";

/** Field the result set is ordered by. */
export type DatabaseQuerySortField =
  | "updatedAt"
  | "createdAt"
  | "recordId"
  | "revision"
  | "data";

/** Sort direction. */
export type DatabaseQueryDirection = "asc" | "desc";

/** One sort specification. */
export interface DatabaseQuerySort {
  readonly field: DatabaseQuerySortField;
  readonly direction: DatabaseQueryDirection;
  /** Dot path into `data` when `field` is "data" (e.g. "metadata.importance"). */
  readonly dataPath?: string;
}

/** A comparison against one record field. */
export type DatabaseQueryOperator =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "notIn"
  | "isNull"
  | "isNotNull";

/** One filter condition (AND-composed with sibling filters). */
export interface DatabaseQueryFilter {
  readonly field: "collection" | "scope" | "recordId" | "revision" | "version" | "archived" | "data" | "createdAt" | "updatedAt" | "deletedAt";
  readonly operator: DatabaseQueryOperator;
  readonly value?: unknown;
}

/** Options accepted by {@link buildDatabaseQuery}. */
export interface BuildDatabaseQueryInput {
  readonly collection?: DatabaseCollectionKind;
  readonly scope?: string;
  readonly filters?: readonly DatabaseQueryFilter[];
  readonly sort?: readonly DatabaseQuerySort[];
  readonly limit?: number;
  readonly offset?: number;
  /** Cursor pagination: only records ordered strictly after `afterRecordId` (by the active sort) are returned. */
  readonly after?: string;
  /** Whether archived records are included (default false). */
  readonly includeArchived?: boolean;
  /** Whether soft-deleted records are included (default false). */
  readonly includeDeleted?: boolean;
  /** Free-text search across a subset of fields (substring, case-insensitive). */
  readonly search?: string;
  /** ISO-8601 date range over `updatedAt`. */
  readonly updatedSince?: string;
  readonly updatedUntil?: string;
  /** ISO-8601 date range over `createdAt`. */
  readonly createdSince?: string;
  readonly createdUntil?: string;
  /** Projection: only the listed top-level record envelope fields are returned. */
  readonly fields?: readonly (keyof DatabaseRecord<unknown>)[];
}

/** An immutable, fully-resolved query descriptor. */
export interface DatabaseQuery {
  readonly collection?: DatabaseCollectionKind;
  readonly scope?: string;
  readonly filters: readonly DatabaseQueryFilter[];
  readonly sort: readonly DatabaseQuerySort[];
  readonly limit: number;
  readonly offset: number;
  readonly after?: string;
  readonly includeArchived: boolean;
  readonly includeDeleted: boolean;
  readonly search?: string;
  readonly updatedSince?: string;
  readonly updatedUntil?: string;
  readonly createdSince?: string;
  readonly createdUntil?: string;
  readonly fields?: readonly (keyof DatabaseRecord<unknown>)[];
}

/** Default sort: newest first, stable total order by recordId asc. */
export const DEFAULT_DATABASE_SORT: readonly DatabaseQuerySort[] = Object.freeze([
  { field: "updatedAt", direction: "desc" },
  { field: "recordId", direction: "asc" },
]);

/** Build a new immutable query descriptor (successor pattern). */
export function buildDatabaseQuery(input: BuildDatabaseQueryInput): DatabaseQuery {
  return Object.freeze({
    ...(input.collection !== undefined ? { collection: input.collection } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    filters: Object.freeze([...(input.filters ?? [])]),
    sort: Object.freeze([...(input.sort ?? DEFAULT_DATABASE_SORT)]),
    limit: input.limit ?? 100,
    offset: input.offset ?? 0,
    ...(input.after !== undefined ? { after: input.after } : {}),
    includeArchived: input.includeArchived ?? false,
    includeDeleted: input.includeDeleted ?? false,
    ...(input.search !== undefined ? { search: input.search } : {}),
    ...(input.updatedSince !== undefined ? { updatedSince: input.updatedSince } : {}),
    ...(input.updatedUntil !== undefined ? { updatedUntil: input.updatedUntil } : {}),
    ...(input.createdSince !== undefined ? { createdSince: input.createdSince } : {}),
    ...(input.createdUntil !== undefined ? { createdUntil: input.createdUntil } : {}),
    ...(input.fields !== undefined ? { fields: Object.freeze([...input.fields]) } : {}),
  });
}

/** Derive a new query from an existing one (successor pattern). */
export function withDatabaseQuery(query: DatabaseQuery, patch: Partial<BuildDatabaseQueryInput>): DatabaseQuery {
  return buildDatabaseQuery({
    collection: patch.collection ?? query.collection,
    scope: patch.scope ?? query.scope,
    filters: patch.filters ?? query.filters,
    sort: patch.sort ?? query.sort,
    limit: patch.limit ?? query.limit,
    offset: patch.offset ?? query.offset,
    after: patch.after ?? query.after,
    includeArchived: patch.includeArchived ?? query.includeArchived,
    includeDeleted: patch.includeDeleted ?? query.includeDeleted,
    search: patch.search ?? query.search,
    updatedSince: patch.updatedSince ?? query.updatedSince,
    updatedUntil: patch.updatedUntil ?? query.updatedUntil,
    createdSince: patch.createdSince ?? query.createdSince,
    createdUntil: patch.createdUntil ?? query.createdUntil,
    fields: patch.fields ?? query.fields,
  });
}

/** The immutable outcome of executing a query. */
export interface QueryResult<T = unknown> {
  /** Detached clones of the matching records, in query order. */
  readonly items: readonly DatabaseRecord<T>[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  /** Cursor for the next page (opaque `recordId`), when more exist. */
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

/** Filter clause builder helper. */
export function filterEquals(field: DatabaseQueryFilter["field"], value: unknown): DatabaseQueryFilter {
  return { field, operator: "eq", value };
}

/** Filter clause builder helper. */
export function filterIn(field: DatabaseQueryFilter["field"], values: readonly unknown[]): DatabaseQueryFilter {
  return { field, operator: "in", value: [...values] };
}

/**
 * Sort clause builder helper. Pass a dot path as `dataPath` to sort by a
 * nested `data` field (e.g. `sortBy("data", "desc", "metadata.importance")`).
 */
export function sortBy(
  field: DatabaseQuerySortField,
  direction: DatabaseQueryDirection = "asc",
  dataPath?: string,
): DatabaseQuerySort {
  return Object.freeze({ field, direction, ...(dataPath !== undefined ? { dataPath } : {}) });
}

/** Resolve a dot path (e.g. "metadata.importance") inside a data payload. */
export function nestedDataValue(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Extract a comparable value for a filter/sort field. */
export function recordFieldValue(record: DatabaseRecord<unknown>, field: DatabaseQueryFilter["field"]): unknown {
  switch (field) {
    case "collection":
      return record.collection;
    case "scope":
      return record.scope;
    case "recordId":
      return record.recordId;
    case "revision":
      return record.revision;
    case "version":
      return record.version;
    case "archived":
      return record.archived;
    case "createdAt":
      return record.createdAt;
    case "updatedAt":
      return record.updatedAt;
    case "deletedAt":
      return record.deletedAt;
    case "data":
      return record.data;
  }
}

/** Compare two unknown values for sorting (numbers/strings; fallback to string compare). */
function compareValues(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return -1;
  if (bNull) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

/** Deep equality for JSON values (used by eq/neq on object payloads). */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEquals(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/** Apply one operator to a raw field value. */
export function matchesOperator(fieldValue: unknown, operator: DatabaseQueryOperator, value: unknown): boolean {
  switch (operator) {
    case "eq":
      return deepEquals(fieldValue, value);
    case "neq":
      return !deepEquals(fieldValue, value);
    case "lt":
      return compareValues(fieldValue, value) < 0;
    case "lte":
      return compareValues(fieldValue, value) <= 0;
    case "gt":
      return compareValues(fieldValue, value) > 0;
    case "gte":
      return compareValues(fieldValue, value) >= 0;
    case "contains":
      return typeof fieldValue === "string" && fieldValue.includes(String(value));
    case "startsWith":
      return typeof fieldValue === "string" && fieldValue.startsWith(String(value));
    case "endsWith":
      return typeof fieldValue === "string" && fieldValue.endsWith(String(value));
    case "in":
      return Array.isArray(value) && value.includes(fieldValue);
    case "notIn":
      return Array.isArray(value) && !value.includes(fieldValue);
    case "isNull":
      return fieldValue === null || fieldValue === undefined;
    case "isNotNull":
      return fieldValue !== null && fieldValue !== undefined;
  }
}

/** Match a record against the full query (filters + ranges + search + lifecycle). */
export function matchesQuery(record: DatabaseRecord<unknown>, query: DatabaseQuery): boolean {
  if (query.collection !== undefined && record.collection !== query.collection) return false;
  if (query.scope !== undefined && record.scope !== query.scope) return false;
  if (!query.includeArchived && record.archived) return false;
  if (!query.includeDeleted && record.deletedAt !== null) return false;
  for (const filter of query.filters) {
    if (!matchesOperator(recordFieldValue(record, filter.field), filter.operator, filter.value)) {
      return false;
    }
  }
  if (query.updatedSince !== undefined && compareValues(record.updatedAt, query.updatedSince) < 0) return false;
  if (query.updatedUntil !== undefined && compareValues(record.updatedAt, query.updatedUntil) > 0) return false;
  if (query.createdSince !== undefined && compareValues(record.createdAt, query.createdSince) < 0) return false;
  if (query.createdUntil !== undefined && compareValues(record.createdAt, query.createdUntil) > 0) return false;
  if (query.search !== undefined && !searchMatches(record, query.search)) return false;
  return true;
}

/** Case-insensitive substring search over recordId, scope and JSON data text. */
export function searchMatches(record: DatabaseRecord<unknown>, needle: string): boolean {
  const haystack = [
    record.recordId,
    record.scope,
    JSON.stringify(record.data ?? {}),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

/** Compare two records by the active sort (total order guaranteed). */
export function compareBySort(a: DatabaseRecord<unknown>, b: DatabaseRecord<unknown>, sort: readonly DatabaseQuerySort[]): number {
  for (const clause of sort) {
    const av =
      clause.field === "data" && clause.dataPath !== undefined
        ? nestedDataValue(a.data, clause.dataPath)
        : recordFieldValue(a, clause.field);
    const bv =
      clause.field === "data" && clause.dataPath !== undefined
        ? nestedDataValue(b.data, clause.dataPath)
        : recordFieldValue(b, clause.field);
    const compared = compareValues(av, bv);
    if (compared !== 0) return clause.direction === "desc" ? -compared : compared;
  }
  // Total tie-breaker: recordId asc (guarantees deterministic ordering).
  if (a.recordId < b.recordId) return -1;
  if (a.recordId > b.recordId) return 1;
  return 0;
}

/**
 * Execute a query over an in-memory record array. Pure: `records` is never
 * mutated; results are detached clones. Returns an immutable {@link QueryResult}.
 */
export function executeDatabaseQuery<T = unknown>(
  records: readonly DatabaseRecord<T>[],
  query: DatabaseQuery,
): QueryResult<T> {
  const matched = records
    .filter((record) => matchesQuery(record, query))
    .slice()
    .sort((a, b) => compareBySort(a, b, query.sort));

  const total = matched.length;

  let page = matched;
  if (query.after !== undefined) {
    const afterIndex = page.findIndex((record) => record.recordId === query.after);
    page = afterIndex === -1 ? [] : page.slice(afterIndex + 1);
  }
  if (query.offset > 0) page = page.slice(query.offset);
  const availableAfterOffset = page.length;
  if (query.limit >= 0) page = page.slice(0, query.limit);

  const items = page.map((record) => cloneDatabaseRecord(record)) as DatabaseRecord<T>[];

  // hasMore is true only when items remain beyond this page (after cursor and
  // offset are applied) — not when the total set simply has more records.
  const hasMore = items.length < availableAfterOffset;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last !== undefined ? last.recordId : undefined;

  const result: QueryResult<T> = {
    items: Object.freeze(items),
    total,
    offset: query.offset,
    limit: query.limit,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    hasMore,
  };
  return Object.freeze(result);
}
