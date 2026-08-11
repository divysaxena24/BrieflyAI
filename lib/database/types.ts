/**
 * Production Database Layer — database domain models (Phase 6A STEP 2).
 *
 * The immutable vocabulary of the database layer. A `DatabaseRecord<T>` is a
 * durable row envelope: the engine record (`data`) plus lifecycle columns —
 * deterministic `id`, `scope`, `collection`, an optimistic-lock `revision`,
 * the codec `version`, soft-delete (`deletedAt`) and archive (`archived` /
 * `archivedAt`) markers, and caller-supplied timestamps.
 *
 * Everything is immutable and deterministic:
 * - ids derive from `hashString` (the shared FNV-1a, Phase 5J) — never
 *   `Date.now()` or `Math.random()`.
 * - timestamps are supplied by the caller (dependency injection), never
 *   read from the wall clock inside helpers.
 * - `cloneDatabaseRecord` deep-clones `data`; `freezeDatabaseRecord`
 *   deep-freezes it; `hashDatabaseRecord` uses a canonical (key-sorted)
 *   serialization so identical records hash identically regardless of
 *   insertion order.
 *
 * The remaining models describe database structure and operations:
 * `DatabaseSnapshot` (immutable read-state of a collection), `DatabasePage`
 * / `DatabaseCursor` (pagination), `DatabaseTransaction` (audit record of a
 * completed transaction), `DatabaseVersion` / `DatabaseMetadata` (schema
 * versioning), `DatabaseStatistics` (aggregates), `DatabaseIndex` (index
 * metadata), and `DatabaseRetention` / `DatabaseCleanup` (retention policy
 * and cleanup execution models — see `./retention`).
 */

import { hashString } from "@/lib/hash";

/** The persistable database collections (six engines + events + metadata). */
export type DatabaseCollectionKind =
  | "memory"
  | "conversation"
  | "job"
  | "digest"
  | "action"
  | "workflow"
  | "event"
  | "metadata";

/** Every persistable collection, in a stable canonical order. */
export const DATABASE_COLLECTION_KINDS: readonly DatabaseCollectionKind[] = Object.freeze([
  "memory",
  "conversation",
  "job",
  "digest",
  "action",
  "workflow",
  "event",
  "metadata",
]);

/** A database collection descriptor (one per engine collection). */
export interface DatabaseCollection {
  /** The collection kind. */
  readonly kind: DatabaseCollectionKind;
  /** Human-readable collection name. */
  readonly name: string;
  /** ISO-8601 UTC timestamp of collection creation (caller-supplied). */
  readonly createdAt: string;
  /** Deterministic collection id derived from kind + name. */
  readonly id: string;
}

/** Options accepted by {@link createDatabaseCollection}. */
export interface CreateDatabaseCollectionInput {
  readonly kind: DatabaseCollectionKind;
  readonly name: string;
  readonly createdAt: string;
}

/** Build an immutable collection descriptor (deterministic id). */
export function createDatabaseCollection(
  input: CreateDatabaseCollectionInput,
): DatabaseCollection {
  return Object.freeze({
    kind: input.kind,
    name: input.name,
    createdAt: input.createdAt,
    id: `collection-${hashString(`${input.kind}:${input.name}`)}`,
  });
}

/** Default schema version written by `createDatabaseRecord`. */
export const DEFAULT_DATABASE_SCHEMA_VERSION = 1;

/** Default optimistic-lock revision assigned to a fresh record. */
export const DEFAULT_DATABASE_REVISION = 1;

/**
 * A durable row envelope around one engine record.
 *
 * `data` is the engine's record (an opaque, JSON-serializable object). The
 * envelope columns are owned by the database layer: `revision` is the
 * optimistic lock, `version` the schema/codec version, `archived`/`deletedAt`
 * the lifecycle markers.
 */
export interface DatabaseRecord<T = unknown> {
  /** Deterministic row id: `record-<hash(scope:collection:recordId)>`. */
  readonly id: string;
  /** Caller-supplied namespace (e.g. a user id or "app"). */
  readonly scope: string;
  /** Which collection the record belongs to. */
  readonly collection: DatabaseCollectionKind;
  /** The engine record's own id (stable across re-writes). */
  readonly recordId: string;
  /** Optimistic-lock revision; bumped on every write. */
  readonly revision: number;
  /** Schema/codec version of `data`. */
  readonly version: number;
  /** Whether the record is archived (retention/archive lifecycle). */
  readonly archived: boolean;
  /** ISO-8601 UTC timestamp of archival, or null when not archived. */
  readonly archivedAt: string | null;
  /** ISO-8601 UTC timestamp of soft deletion, or null when active. */
  readonly deletedAt: string | null;
  /** ISO-8601 UTC timestamp of creation (caller-supplied). */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the most recent modification. */
  readonly updatedAt: string;
  /** The engine record (opaque JSON). */
  readonly data: T;
}

/** Options accepted by {@link createDatabaseRecord}. */
export interface CreateDatabaseRecordInput<T> {
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  readonly recordId: string;
  /** Optional explicit row id; derived deterministically when omitted. */
  readonly id?: string;
  /** Optional explicit optimistic-lock revision. */
  readonly revision?: number;
  /** Optional schema/codec version. */
  readonly version?: number;
  readonly archived?: boolean;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  /** ISO-8601 UTC timestamp of creation (required — caller-supplied). */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of modification; defaults to `createdAt`. */
  readonly updatedAt?: string;
  readonly data: T;
}

/**
 * Build an immutable `DatabaseRecord`. The row id is a deterministic hash of
 * scope + collection + recordId — no randomness, no wall clock.
 */
export function createDatabaseRecord<T>(input: CreateDatabaseRecordInput<T>): DatabaseRecord<T> {
  return {
    id: input.id ?? databaseRecordIdFor(input.scope, input.collection, input.recordId),
    scope: input.scope,
    collection: input.collection,
    recordId: input.recordId,
    revision: input.revision ?? DEFAULT_DATABASE_REVISION,
    version: input.version ?? DEFAULT_DATABASE_SCHEMA_VERSION,
    archived: input.archived ?? false,
    archivedAt: input.archivedAt ?? null,
    deletedAt: input.deletedAt ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    data: input.data,
  };
}

/** Deterministic row id for `(scope, collection, recordId)`. */
export function databaseRecordIdFor(
  scope: string,
  collection: DatabaseCollectionKind,
  recordId: string,
): string {
  return `record-${hashString(`${scope}:${collection}:${recordId}`)}`;
}

/**
 * Return a deep, detached copy of a record. `data` is cloned recursively, so
 * the caller can never alias stored state. The copy is never frozen.
 */
export function cloneDatabaseRecord<T>(record: DatabaseRecord<T>): DatabaseRecord<T> {
  return {
    ...record,
    data: cloneValue(record.data),
  };
}

/** Deep-clone a JSON value (arrays/records cloned; primitives shared). */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = cloneValue((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

/** Deep-freeze a record in place and return it (idempotent). */
export function freezeDatabaseRecord<T>(record: DatabaseRecord<T>): DatabaseRecord<T> {
  return Object.freeze({ ...record, data: deepFreeze(record.data) }) as DatabaseRecord<T>;
}

/** Deep-freeze a JSON value (arrays/records frozen; primitives untouched). */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value) as unknown as T;
  }
  return value;
}

/**
 * Canonical JSON serialization: keys are sorted recursively so identical
 * values produce byte-identical strings regardless of insertion order.
 * Used by `hashDatabaseRecord` and snapshot checksums.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Recursively rebuild `value` with deterministically sorted keys. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stable hash of a record's full identity + payload. Deterministic: identical
 * records (same scope/collection/recordId/data at the same revision) produce
 * the same hash. Used to detect changed records for incremental saves.
 */
export function hashDatabaseRecord(record: DatabaseRecord<unknown>): string {
  return hashString(
    canonicalJson({
      scope: record.scope,
      collection: record.collection,
      recordId: record.recordId,
      revision: record.revision,
      version: record.version,
      archived: record.archived,
      archivedAt: record.archivedAt,
      deletedAt: record.deletedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      data: record.data,
    }),
  );
}

/**
 * Estimate the durable size of a record in bytes. The canonical JSON length
 * is a stable proxy for storage cost (UTF-16 code units ≈ 2 bytes each).
 * Deterministic and pure.
 */
export function estimateDatabaseSize(record: DatabaseRecord<unknown>): number {
  return canonicalJson(record).length * 2;
}

/** An immutable read-state of one collection at a point in time. */
export interface DatabaseSnapshot {
  /** Deterministic snapshot id derived from scope + collection + takenAt. */
  readonly id: string;
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  /** ISO-8601 UTC timestamp of the snapshot (caller-supplied). */
  readonly takenAt: string;
  /** Detached copies of the records, in insertion order. */
  readonly records: readonly DatabaseRecord<unknown>[];
  readonly recordCount: number;
  /** Deterministic checksum over the records (canonical hash). */
  readonly checksum: string;
  /** Estimated total durable size in bytes. */
  readonly sizeBytes: number;
}

/** Options accepted by {@link createDatabaseSnapshot}. */
export interface CreateDatabaseSnapshotInput {
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  /** ISO-8601 UTC timestamp of the snapshot. */
  readonly takenAt: string;
  readonly records: readonly DatabaseRecord<unknown>[];
}

/** Build an immutable snapshot with a deterministic id + checksum. */
export function createDatabaseSnapshot(input: CreateDatabaseSnapshotInput): DatabaseSnapshot {
  const records = input.records.map(cloneDatabaseRecord);
  const checksum = hashString(records.map(hashDatabaseRecord).join(":"));
  return Object.freeze({
    id: `snapshot-${hashString(`${input.scope}:${input.collection}:${input.takenAt}`)}`,
    scope: input.scope,
    collection: input.collection,
    takenAt: input.takenAt,
    records: Object.freeze(records.map(freezeDatabaseRecord)),
    recordCount: records.length,
    checksum,
    sizeBytes: records.reduce((total, record) => total + estimateDatabaseSize(record), 0),
  });
}

/** Lifecycle states of a database transaction descriptor. */
export type DatabaseTransactionStatus = "pending" | "committed" | "rolled_back";

/** Immutable audit record of a completed database transaction. */
export interface DatabaseTransaction {
  /** Deterministic transaction id derived from scope + collection + startedAt. */
  readonly id: string;
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  readonly status: DatabaseTransactionStatus;
  /** Nesting depth (0 = top level). */
  readonly depth: number;
  /** Number of mutation operations performed. */
  readonly operations: number;
  /** 1-based attempt number of the containing transaction. */
  readonly attempt: number;
  /** ISO-8601 UTC timestamp of the transaction start (caller-supplied). */
  readonly startedAt: string;
  /** ISO-8601 UTC timestamp of completion, when settled. */
  readonly settledAt?: string;
}

/** Options accepted by {@link createDatabaseTransaction}. */
export interface CreateDatabaseTransactionInput {
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  readonly status?: DatabaseTransactionStatus;
  readonly depth?: number;
  readonly operations?: number;
  readonly attempt?: number;
  /** ISO-8601 UTC timestamp of the transaction start. */
  readonly startedAt: string;
  readonly settledAt?: string;
}

/** Build an immutable transaction descriptor (deterministic id). */
export function createDatabaseTransaction(
  input: CreateDatabaseTransactionInput,
): DatabaseTransaction {
  return Object.freeze({
    id: `tx-${hashString(`${input.scope}:${input.collection}:${input.startedAt}:${input.attempt ?? 1}:${input.depth ?? 0}`)}`,
    scope: input.scope,
    collection: input.collection,
    status: input.status ?? "pending",
    depth: input.depth ?? 0,
    operations: input.operations ?? 0,
    attempt: input.attempt ?? 1,
    startedAt: input.startedAt,
    ...(input.settledAt !== undefined ? { settledAt: input.settledAt } : {}),
  });
}

/** Schema version of one collection (migration anchor). */
export interface DatabaseVersion {
  readonly collection: DatabaseCollectionKind;
  /** The schema version the build supports. */
  readonly version: number;
  /** Deterministic id of the version record. */
  readonly id: string;
}

/** Build an immutable schema-version record. */
export function createDatabaseVersion(
  collection: DatabaseCollectionKind,
  version: number,
): DatabaseVersion {
  return Object.freeze({
    collection,
    version,
    id: `version-${hashString(`${collection}:${version}`)}`,
  });
}

/** A declared database index (metadata for the schema registry). */
export interface DatabaseIndex {
  readonly name: string;
  readonly collection: DatabaseCollectionKind;
  /** Indexed column names, in order. */
  readonly fields: readonly string[];
  readonly unique: boolean;
  /** Deterministic id of the index record. */
  readonly id: string;
}

/** Build an immutable index descriptor. */
export function createDatabaseIndex(input: {
  readonly name: string;
  readonly collection: DatabaseCollectionKind;
  readonly fields: readonly string[];
  readonly unique?: boolean;
}): DatabaseIndex {
  return Object.freeze({
    name: input.name,
    collection: input.collection,
    fields: Object.freeze([...input.fields]),
    unique: input.unique ?? false,
    id: `index-${hashString(`${input.collection}:${input.name}`)}`,
  });
}

/** A pagination cursor over one collection. */
export interface DatabaseCursor {
  /** Deterministic cursor id derived from scope + collection + after. */
  readonly id: string;
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  /** The recordId to resume *after*, or undefined for the first page. */
  readonly after?: string;
}

/** Options accepted by {@link createDatabaseCursor}. */
export interface CreateDatabaseCursorInput {
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  readonly after?: string;
}

/** Build an immutable cursor (deterministic id, opaque by design). */
export function createDatabaseCursor(input: CreateDatabaseCursorInput): DatabaseCursor {
  return Object.freeze({
    id: `cursor-${hashString(
      `${input.scope}:${input.collection}:${input.after ?? ""}`,
    )}`,
    scope: input.scope,
    collection: input.collection,
    ...(input.after !== undefined ? { after: input.after } : {}),
  });
}

/** One page of records plus its pagination state. */
export interface DatabasePage<T = unknown> {
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  readonly items: readonly DatabaseRecord<T>[];
  /** Opaque cursor for the next page, or undefined when this is the last. */
  readonly nextCursor?: string;
  /** Whether more records exist after this page. */
  readonly hasMore: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Options accepted by {@link createDatabasePage}. */
export interface CreateDatabasePageInput<T> {
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  readonly items: readonly DatabaseRecord<T>[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Build an immutable, deep-frozen page of detached records. */
export function createDatabasePage<T>(input: CreateDatabasePageInput<T>): DatabasePage<T> {
  return Object.freeze({
    scope: input.scope,
    collection: input.collection,
    items: Object.freeze(input.items.map(freezeDatabaseRecord)),
    ...(input.nextCursor !== undefined ? { nextCursor: input.nextCursor } : {}),
    hasMore: input.hasMore,
    page: input.page,
    pageSize: input.pageSize,
    total: input.total,
  });
}

/** Aggregate statistics of one collection (deterministic). */
export interface DatabaseStatistics {
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  readonly total: number;
  readonly active: number;
  readonly archived: number;
  readonly deleted: number;
  /** Estimated durable size in bytes. */
  readonly sizeBytes: number;
  /** Number of distinct schema versions present. */
  readonly versionCount: number;
  /** Deterministic id of the statistics record. */
  readonly id: string;
}

/** Options accepted by {@link createDatabaseStatistics}. */
export interface CreateDatabaseStatisticsInput {
  readonly scope: string;
  readonly collection: DatabaseCollectionKind;
  readonly records: readonly DatabaseRecord<unknown>[];
}

/** Build deterministic collection statistics from a record set. */
export function createDatabaseStatistics(
  input: CreateDatabaseStatisticsInput,
): DatabaseStatistics {
  const records = input.records;
  const active = records.filter((record) => !record.archived && record.deletedAt === null).length;
  const archived = records.filter((record) => record.archived).length;
  const deleted = records.filter((record) => record.deletedAt !== null).length;
  return Object.freeze({
    scope: input.scope,
    collection: input.collection,
    total: records.length,
    active,
    archived,
    deleted,
    sizeBytes: records.reduce((total, record) => total + estimateDatabaseSize(record), 0),
    versionCount: new Set(records.map((record) => record.version)).size,
    id: `statistics-${hashString(`${input.scope}:${input.collection}`)}`,
  });
}

/** Persistence metadata for one scope (schema-version anchor). */
export interface DatabaseMetadata {
  /** Deterministic metadata id derived from the scope. */
  readonly id: string;
  readonly scope: string;
  /** The schema version the scope's data was written with. */
  readonly schemaVersion: number;
  /** ISO-8601 UTC timestamp of creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the most recent update. */
  readonly updatedAt: string;
}

/** Options accepted by {@link createDatabaseMetadata}. */
export interface CreateDatabaseMetadataInput {
  readonly scope: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

/** Build immutable persistence metadata (deterministic id). */
export function createDatabaseMetadata(input: CreateDatabaseMetadataInput): DatabaseMetadata {
  return Object.freeze({
    id: `metadata-${hashString(input.scope)}`,
    scope: input.scope,
    schemaVersion: input.schemaVersion,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  });
}

/** Retention actions available to a retention policy. */
export type DatabaseRetentionAction = "archive" | "soft_delete" | "delete";

/**
 * An immutable retention policy for one collection.
 *
 * - `olderThanDays`: act on records whose `updatedAt` is older than this.
 * - `keepCount`: keep at least this many newest records untouched.
 * - `expiredOnly`: act only on records whose data carries an `expiresAt`
 *   timestamp at or before `now` (expired-record cleanup).
 * - `orphanOnly` + `isOrphan`: act only on records `isOrphan` returns true
 *   for (orphan cleanup — e.g. referencing a missing entity).
 */
export interface DatabaseRetention {
  /** Deterministic policy id derived from collection + action + params. */
  readonly id: string;
  readonly collection: DatabaseCollectionKind;
  readonly action: DatabaseRetentionAction;
  readonly olderThanDays?: number;
  readonly keepCount?: number;
  readonly expiredOnly?: boolean;
  readonly orphanOnly?: boolean;
  /**
   * Dot path of the expiry/orphan field inside `data` (e.g.
   * "metadata.expiresAt" for engine records). When omitted, the top-level
   * `data.expiresAt` / orphan predicate is used.
   */
  readonly dataPath?: string;
  /** ISO-8601 UTC timestamp of policy creation (caller-supplied). */
  readonly createdAt: string;
}

/** Options accepted by {@link createDatabaseRetention}. */
export interface CreateDatabaseRetentionInput {
  readonly collection: DatabaseCollectionKind;
  readonly action: DatabaseRetentionAction;
  readonly olderThanDays?: number;
  readonly keepCount?: number;
  readonly expiredOnly?: boolean;
  readonly orphanOnly?: boolean;
  readonly dataPath?: string;
  readonly createdAt: string;
}

/** Build an immutable retention policy (deterministic id). */
export function createDatabaseRetention(input: CreateDatabaseRetentionInput): DatabaseRetention {
  return Object.freeze({
    id: retentionIdFor(input),
    collection: input.collection,
    action: input.action,
    ...(input.olderThanDays !== undefined ? { olderThanDays: input.olderThanDays } : {}),
    ...(input.keepCount !== undefined ? { keepCount: input.keepCount } : {}),
    ...(input.expiredOnly !== undefined ? { expiredOnly: input.expiredOnly } : {}),
    ...(input.orphanOnly !== undefined ? { orphanOnly: input.orphanOnly } : {}),
    ...(input.dataPath !== undefined ? { dataPath: input.dataPath } : {}),
    createdAt: input.createdAt,
  });
}

/** Deterministic id of a retention policy. */
function retentionIdFor(input: CreateDatabaseRetentionInput): string {
  return `retention-${hashString(
    canonicalJson({
      collection: input.collection,
      action: input.action,
      olderThanDays: input.olderThanDays,
      keepCount: input.keepCount,
      expiredOnly: input.expiredOnly,
      orphanOnly: input.orphanOnly,
      dataPath: input.dataPath,
    }),
  )}`;
}

/** Per-collection application of a cleanup action on one record. */
export interface DatabaseCleanupApplied {
  readonly collection: DatabaseCollectionKind;
  readonly action: DatabaseRetentionAction;
  /** Record ids the action was applied to, in deterministic order. */
  readonly recordIds: readonly string[];
}

/**
 * An immutable cleanup execution (or preview) result.
 *
 * `preview: true` means nothing was written — the plan only reports which
 * records the policies would act on.
 */
export interface DatabaseCleanup {
  /** Deterministic cleanup id derived from scope + policies + at. */
  readonly id: string;
  readonly scope: string;
  /** ISO-8601 UTC timestamp of the cleanup (caller-supplied). */
  readonly at: string;
  readonly preview: boolean;
  readonly applied: readonly DatabaseCleanupApplied[];
  readonly recordCount: number;
}

/** Options accepted by {@link createDatabaseCleanup}. */
export interface CreateDatabaseCleanupInput {
  readonly scope: string;
  readonly at: string;
  readonly preview: boolean;
  readonly applied: readonly DatabaseCleanupApplied[];
}

/** Build an immutable cleanup result (deterministic id). */
export function createDatabaseCleanup(input: CreateDatabaseCleanupInput): DatabaseCleanup {
  return Object.freeze({
    id: `cleanup-${hashString(
      `${input.scope}:${input.at}:${input.preview}:${input.applied
        .map((entry) => `${entry.collection}:${entry.action}:${entry.recordIds.join(",")}`)
        .join("|")}`,
    )}`,
    scope: input.scope,
    at: input.at,
    preview: input.preview,
    applied: Object.freeze(
      input.applied.map((entry) =>
        Object.freeze({
          collection: entry.collection,
          action: entry.action,
          recordIds: Object.freeze([...entry.recordIds]),
        }),
      ),
    ),
    recordCount: input.applied.reduce(
      (total, entry) => total + entry.recordIds.length,
      0,
    ),
  });
}

/** Days in milliseconds (retention math — deterministic). */
export const DAY_MS = 86_400_000;

/** Milliseconds for an ISO timestamp, or `-Infinity` when unparseable. */
export function timestampMillis(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}
