/**
 * Production Database Layer — persistence integration (Phase 6A STEP 7).
 *
 * `DatabasePersistence` extends the Phase 5J persistence engine with
 * row-level, incremental storage over a `DatabaseDriver`. It reuses — never
 * duplicates — the existing engine adapters and codecs:
 *
 * - `snapshot(scope, kind, engine)` reads the engine's records via the 5J
 *   adapter and wraps each into a `DatabaseRecord` envelope (the engine
 *   record is `data`; lifecycle columns come from the database layer).
 * - `saveIncremental` writes only *changed* records: hashes of the stored
 *   envelopes are compared with what the driver holds, and only new/changed
 *   rows are upserted while removed rows are deleted (delta tracking).
 * - `save` is the full-snapshot alias (identical write semantics, every
 *   record re-verified); `restoreCollection`/`restoreAll` rebuild fresh
 *   engines over the stored envelopes via the 5J adapters (restart recovery
 *   with per-collection failure isolation).
 * - `upgrade` is the schema-version migration entry point: it validates the
 *   stored version against the supported version, applies a caller-supplied
 *   pure migration over the records, and rewrites them with the new version.
 * - `metadata` read/write keeps per-scope schema-version bookkeeping in the
 *   driver (`database_metadata`).
 *
 * The codecs' structural validation (non-array payloads, missing string ids,
 * newer versions) is enforced through the existing 5J `deserializeCollection`
 * path — no duplicated serialization or validation.
 */

import { ALL_ADAPTERS, type PersistenceAdapter } from "@/lib/persistence/adapters";
import type { CollectionKind } from "@/lib/persistence/types";
import { canonicalJson } from "@/lib/database/types";
import { hashString } from "@/lib/hash";
import {
  createDatabaseMetadata,
  createDatabaseRecord,
  createDatabaseVersion,
  databaseRecordIdFor,
  type DatabaseCollectionKind,
  type DatabaseRecord,
} from "@/lib/database/types";
import { PersistenceVersionError } from "@/lib/persistence/types";
import type { DatabaseDriver } from "@/lib/database/driver";
import type { MemoryEngine } from "@/lib/memory/production";
import type { ConversationEngine } from "@/lib/conversation/production";
import type { JobEngine } from "@/lib/jobs/production";
import type { DigestEngine } from "@/lib/digest/production";
import type { ActionEngine } from "@/lib/actions/production";
import type { WorkflowEngine } from "@/lib/workflows/production";

/** The six application engines as a single restorable set. */
export interface DatabaseEngineSet {
  readonly memory: MemoryEngine;
  readonly conversation: ConversationEngine;
  readonly jobs: JobEngine;
  readonly digest: DigestEngine;
  readonly actions: ActionEngine;
  readonly workflows: WorkflowEngine;
}

/** Options accepted by the {@link DatabasePersistence} constructor. */
export interface DatabasePersistenceOptions {
  /** The underlying storage driver (dependency injection). */
  readonly driver: DatabaseDriver;
  /** The engine adapters (dependency injection); all six by default. */
  readonly adapters?: readonly PersistenceAdapter<unknown, unknown>[];
}

/** The delta report of one incremental save. */
export interface IncrementalSaveResult {
  readonly scope: string;
  readonly kind: CollectionKind;
  /** Records that were not present before. */
  readonly inserted: number;
  /** Records whose envelope hash changed. */
  readonly updated: number;
  /** Records present before but absent now. */
  readonly removed: number;
  /** Records unchanged (skipped by the delta comparison). */
  readonly unchanged: number;
}

/** A per-collection failure (failure-isolated batches). */
export interface DatabasePersistenceError {
  readonly kind: CollectionKind;
  readonly message: string;
}

/**
 * Row-level persistence over the Phase 5J adapters/codecs and a Phase 6A
 * driver. Pure with respect to engines — engines are only read (snapshot)
 * or rebuilt (restore), never mutated.
 */
export class DatabasePersistence {
  /** The underlying driver. */
  readonly driver: DatabaseDriver;

  private readonly adapters: ReadonlyMap<CollectionKind, PersistenceAdapter<unknown, unknown>>;

  constructor(options: DatabasePersistenceOptions) {
    this.driver = options.driver;
    const map = new Map<CollectionKind, PersistenceAdapter<unknown, unknown>>();
    for (const adapter of options.adapters ?? ALL_ADAPTERS) {
      if (map.has(adapter.kind)) {
        throw new Error(`Database persistence already contains adapter "${adapter.kind}"`);
      }
      map.set(adapter.kind, adapter);
    }
    this.adapters = map;
  }

  /** The registered collection kinds, in canonical order. */
  kinds(): readonly CollectionKind[] {
    return [...this.adapters.keys()];
  }

  // ─────────────────────────────────────────────────────────────
  // Snapshots
  // ─────────────────────────────────────────────────────────────

  /**
   * Wrap an engine's current records into `DatabaseRecord` envelopes
   * (detached, versioned, deterministic ids). Timestamps are caller-supplied.
   * Never mutates the engine.
   */
  snapshot<TEngine, TRecord>(
    scope: string,
    kind: CollectionKind,
    engine: TEngine,
    now: string,
  ): readonly DatabaseRecord<TRecord>[] {
    const adapter = this.requireAdapter<TEngine, TRecord>(kind);
    return adapter.snapshot(engine).map((record) =>
      createDatabaseRecord<TRecord>({
        scope,
        collection: kind as DatabaseCollectionKind,
        recordId: (record as { id: string }).id,
        version: adapter.codec.version,
        createdAt: now,
        updatedAt: now,
        data: record,
        // Envelope ids derive from the engine's own stable record ids — the
        // engine owns id identity, the database layer owns the row envelope.
        id: databaseRecordIdFor(scope, kind as DatabaseCollectionKind, (record as { id: string }).id),
      }),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Saves
  // ─────────────────────────────────────────────────────────────

  /**
   * Full-snapshot save: verify every record against storage and write the
   * entire collection (idempotent — unchanged records are simply skipped by
   * the same hash comparison used by {@link saveIncremental}).
   */
  async save<TEngine>(
    scope: string,
    kind: CollectionKind,
    engine: TEngine,
    now: string,
  ): Promise<IncrementalSaveResult> {
    return this.saveIncremental(scope, kind, engine, now);
  }

  /**
   * Incremental save: compare envelope hashes against the stored rows and
   * write only the delta (new + changed records), deleting rows whose
   * record ids are gone. Timestamps are caller-supplied. Returns the delta
   * report.
   */
  async saveIncremental<TEngine>(
    scope: string,
    kind: CollectionKind,
    engine: TEngine,
    now: string,
  ): Promise<IncrementalSaveResult> {
    const envelopes = this.snapshot<TEngine, unknown>(scope, kind, engine, now);

    const stored = await this.driver.readAll(scope, kind as DatabaseCollectionKind);
    const storedByRecordId = new Map(stored.map((record) => [record.recordId, record]));

    const desiredIds = new Set(envelopes.map((record) => record.recordId));
    // Delta detection compares the *data payload* (canonical) — envelope
    // timestamps are ignored so idempotent saves report everything unchanged.
    const toWrite = envelopes.filter((record) => {
      const previous = storedByRecordId.get(record.recordId);
      return (
        previous === undefined ||
        hashString(canonicalJson(record.data)) !== hashString(canonicalJson(previous.data))
      );
    });
    const removedIds = stored
      .filter((record) => !desiredIds.has(record.recordId))
      .map((record) => record.recordId);

    await this.driver.upsertAll(scope, kind as DatabaseCollectionKind, toWrite);
    if (removedIds.length > 0) {
      await this.driver.deleteMany(scope, kind as DatabaseCollectionKind, removedIds);
    }

    const inserted = toWrite.filter(
      (record) => !storedByRecordId.has(record.recordId),
    ).length;
    const updated = toWrite.length - inserted;
    const unchanged = envelopes.length - toWrite.length;

    return {
      scope,
      kind,
      inserted,
      updated,
      removed: removedIds.length,
      unchanged,
    };
  }

  /** Persist every engine in `engines` under `scope` (incremental, isolated). */
  async saveAll(
    scope: string,
    engines: DatabaseEngineSet,
    now: string,
  ): Promise<{ results: readonly IncrementalSaveResult[]; errors: readonly DatabasePersistenceError[] }> {
    const results: IncrementalSaveResult[] = [];
    const errors: DatabasePersistenceError[] = [];
    const operations: ReadonlyArray<{ kind: CollectionKind; run: () => Promise<IncrementalSaveResult> }> = [
      { kind: "memory", run: () => this.saveIncremental(scope, "memory", engines.memory, now) },
      { kind: "conversation", run: () => this.saveIncremental(scope, "conversation", engines.conversation, now) },
      { kind: "job", run: () => this.saveIncremental(scope, "job", engines.jobs, now) },
      { kind: "digest", run: () => this.saveIncremental(scope, "digest", engines.digest, now) },
      { kind: "action", run: () => this.saveIncremental(scope, "action", engines.actions, now) },
      { kind: "workflow", run: () => this.saveIncremental(scope, "workflow", engines.workflows, now) },
    ];
    for (const operation of operations) {
      try {
        results.push(await operation.run());
      } catch (error) {
        errors.push({
          kind: operation.kind,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results, errors };
  }

  // ─────────────────────────────────────────────────────────────
  // Restores
  // ─────────────────────────────────────────────────────────────

  /**
   * Load the stored envelopes for `(scope, kind)` and rebuild a fresh engine
   * over them (restart recovery). Throws when the stored version is newer
   * than the codec supports or the payload is structurally invalid (the 5J
   * codec validation path).
   */
  async restoreCollection<TEngine, TRecord>(
    scope: string,
    kind: CollectionKind,
  ): Promise<TEngine> {
    const adapter = this.requireAdapter<TEngine, TRecord>(kind);
    const stored = await this.driver.readAll(scope, kind as DatabaseCollectionKind);
    // Reuse the 5J codec's version gate: reject data written by a newer codec.
    const storedVersion = stored.length === 0 ? 0 : Math.max(...stored.map((e) => e.version));
    if (storedVersion > adapter.codec.version) {
      throw new PersistenceVersionError(scope, kind, storedVersion, adapter.codec.version);
    }
    const records = stored.map((envelope) => envelope.data as TRecord);
    if (records.length > 0) {
      // Structural validation through the codec (string ids, array shape).
      adapter.codec.deserialize(adapter.codec.serialize(records));
    }
    return adapter.restore(records);
  }

  /**
   * Rebuild a fresh `DatabaseEngineSet` from storage (restart recovery).
   * Missing collections restore as empty engines; per-collection failures
   * are isolated and reported.
   */
  async restoreAll(
    scope: string,
  ): Promise<{ engines: DatabaseEngineSet; errors: readonly DatabasePersistenceError[] }> {
    const errors: DatabasePersistenceError[] = [];
    const restore = async <TEngine, TRecord>(
      kind: CollectionKind,
    ): Promise<TEngine> => {
      try {
        return await this.restoreCollection<TEngine, TRecord>(scope, kind);
      } catch (error) {
        errors.push({
          kind,
          message: error instanceof Error ? error.message : String(error),
        });
        const adapter = this.requireAdapter<TEngine, TRecord>(kind);
        return adapter.restore([]);
      }
    };
    const engines: DatabaseEngineSet = {
      memory: await restore<MemoryEngine, never>("memory"),
      conversation: await restore<ConversationEngine, never>("conversation"),
      jobs: await restore<JobEngine, never>("job"),
      digest: await restore<DigestEngine, never>("digest"),
      actions: await restore<ActionEngine, never>("action"),
      workflows: await restore<WorkflowEngine, never>("workflow"),
    };
    return { engines, errors };
  }

  /** Remove every stored row for `(scope, kind)`. Never throws. */
  async clear(scope: string, kind: CollectionKind): Promise<void> {
    await this.driver.clearCollection(scope, kind as DatabaseCollectionKind);
  }

  /** Remove every stored row under `scope`. */
  async clearAll(scope: string): Promise<void> {
    for (const kind of this.kinds()) {
      await this.driver.clearCollection(scope, kind as DatabaseCollectionKind);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Schema versioning / migration
  // ─────────────────────────────────────────────────────────────

  /**
   * The schema version a collection's stored records carry, or 0 when the
   * collection is empty (restart recovery: no data, no version).
   */
  async storedVersion(scope: string, kind: CollectionKind): Promise<number> {
    const stored = await this.driver.readAll(scope, kind as DatabaseCollectionKind);
    if (stored.length === 0) return 0;
    return Math.max(...stored.map((envelope) => envelope.version));
  }

  /**
   * Upgrade a collection's records to `toVersion`. Validates that the stored
   * version equals `fromVersion` (no divergent migrations), applies a pure
   * `migrate` over the record data, and rewrites every envelope with the new
   * version. Returns the number of migrated records.
   */
  async upgrade<TRecord>(
    scope: string,
    kind: CollectionKind,
    fromVersion: number,
    toVersion: number,
    migrate: (records: readonly TRecord[]) => readonly TRecord[],
    now: string,
  ): Promise<number> {
    const stored = await this.driver.readAll(scope, kind as DatabaseCollectionKind);
    const current = await this.storedVersion(scope, kind);
    if (current !== fromVersion) {
      throw new Error(
        `Cannot upgrade ${scope}/${kind}: stored version ${current} does not match ${fromVersion}`,
      );
    }
    const records = stored.map((envelope) => envelope.data as TRecord);
    const migrated = migrate(records);
    // Migrations change only the schema `version` (and the migrated payload) —
    // envelope provenance (createdAt) and the last-write timestamp (updatedAt)
    // are preserved from the stored envelopes.
    const envelopes = migrated.map((record, index) => {
      const previous = stored[index];
      return createDatabaseRecord<TRecord>({
        scope,
        collection: kind as DatabaseCollectionKind,
        recordId: (record as { id: string }).id,
        version: toVersion,
        createdAt: previous?.createdAt ?? now,
        updatedAt: previous?.updatedAt ?? now,
        data: record,
        id: databaseRecordIdFor(scope, kind as DatabaseCollectionKind, (record as { id: string }).id),
      });
    });
    await this.driver.upsertAll(scope, kind as DatabaseCollectionKind, envelopes);
    return envelopes.length;
  }

  /** Whether a scope has any stored records at all. */
  async hasData(scope: string): Promise<boolean> {
    for (const kind of this.kinds()) {
      const stored = await this.driver.readAll(scope, kind as DatabaseCollectionKind);
      if (stored.length > 0) return true;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────────

  /**
   * Read (or create) the per-scope schema-version metadata row. The metadata
   * is stored as an envelope whose `data` is the `DatabaseMetadata` object.
   * Deterministic id; timestamps are caller-supplied (`now`).
   */
  async metadata(scope: string, now: string): Promise<{ schemaVersion: number }> {
    const stored = await this.driver.readAll(scope, "metadata");
    const row = stored[0];
    if (row === undefined) {
      await this.writeMetadata(scope, 1, now);
      return { schemaVersion: 1 };
    }
    return {
      schemaVersion: (row.data as { schemaVersion: number }).schemaVersion,
    };
  }

  /**
   * Record the version the scope's data was written with (schema anchor).
   */
  async writeMetadata(scope: string, schemaVersion: number, now: string): Promise<void> {
    const meta = createDatabaseMetadata({ scope, schemaVersion, createdAt: now, updatedAt: now });
    const envelope = createDatabaseRecord({
      scope,
      collection: "metadata",
      recordId: meta.id,
      createdAt: now,
      updatedAt: now,
      data: meta,
    });
    await this.driver.upsertAll(scope, "metadata", [envelope]);
  }

  /** Convenience: a `DatabaseVersion` descriptor for the supported schema. */
  supportedVersion(kind: CollectionKind): { readonly version: number; readonly id: string } {
    const adapter = this.requireAdapter(kind);
    return createDatabaseVersion(kind as DatabaseCollectionKind, adapter.codec.version);
  }

  // ─────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────

  /** The adapter for a kind, or throw (unknown collection). */
  private requireAdapter<TEngine, TRecord>(
    kind: CollectionKind,
  ): PersistenceAdapter<TEngine, TRecord> {
    const adapter = this.adapters.get(kind);
    if (adapter === undefined) {
      throw new Error(`No database persistence adapter for collection "${kind}"`);
    }
    return adapter as PersistenceAdapter<TEngine, TRecord>;
  }
}

