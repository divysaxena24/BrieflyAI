/**
 * Persistence layer — collection serialization (Phase 5J STEP 2/3).
 *
 * A `CollectionCodec<T>` turns an engine collection (an array of plain,
 * JSON-serializable records) into a stable payload string and back. All six
 * engine collections share one generic implementation — the serialization
 * logic is defined once, never duplicated per engine.
 *
 * - Deterministic: identical records produce byte-identical payloads
 *   (JSON key order is preserved by `JSON.stringify` for the shapes the
 *   engines produce).
 * - Versioned: every payload carries the codec version; loading data
 *   written by a newer codec fails structurally (migration-safe).
 * - Validating: `deserialize` rejects non-array payloads and records
 *   without a string `id` (the minimal structural contract every engine
 *   repository requires).
 */

import { PersistenceCorruptError, PersistenceVersionError } from "./types";
import type { CollectionKind } from "./types";

/**
 * A codec for one engine collection: serializes to / deserializes from a
 * stable string payload, carrying its schema version.
 */
export interface CollectionCodec<T> {
  readonly kind: CollectionKind;
  readonly version: number;
  /** Serialize `records` to a stable payload string. */
  serialize(records: readonly T[]): string;
  /**
   * Deserialize a payload string back into detached records.
   * Throws `PersistenceCorruptError`/`PersistenceVersionError` structurally.
   */
  deserialize(payload: string): readonly T[];
}

/** Validate a parsed payload is an array of records with string ids. */
function assertRecords(
  scope: string,
  kind: CollectionKind,
  parsed: unknown,
): parsed is ReadonlyArray<{ readonly id: unknown }> {
  if (!Array.isArray(parsed)) {
    throw new PersistenceCorruptError(scope, kind, "payload is not an array");
  }
  for (const record of parsed) {
    if (typeof record !== "object" || record === null) {
      throw new PersistenceCorruptError(scope, kind, "record is not an object");
    }
    if (typeof (record as { id?: unknown }).id !== "string") {
      throw new PersistenceCorruptError(scope, kind, "record has no string id");
    }
  }
  return true;
}

/**
 * Build the shared generic codec used by every engine collection.
 *
 * Serialization is plain deterministic JSON; deserialization validates the
 * structural contract (array of records with string ids) before returning.
 * Records are returned detached (fresh parsed objects), so callers can never
 * alias stored state.
 */
export function createCollectionCodec<T>(
  kind: CollectionKind,
  version = 1,
): CollectionCodec<T> {
  return {
    kind,
    version,
    serialize(records: readonly T[]): string {
      return JSON.stringify(records);
    },
    deserialize(payload: string): readonly T[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new PersistenceCorruptError("", kind, "payload is not valid JSON");
      }
      if (!assertRecords("", kind, parsed)) {
        // assertRecords throws; this is unreachable but keeps the type narrow.
        throw new PersistenceCorruptError("", kind, "invalid records");
      }
      return parsed as readonly T[];
    },
  };
}

/**
 * Deserialize `collection.payload` with `codec`, enforcing the schema-version
 * gate (a stored version newer than the codec's is rejected). Returns
 * detached records.
 */
export function deserializeCollection<T>(
  collection: { readonly scope: string; readonly kind: CollectionKind; readonly version: number; readonly payload: string },
  codec: CollectionCodec<T>,
): readonly T[] {
  if (collection.version > codec.version) {
    throw new PersistenceVersionError(
      collection.scope,
      collection.kind,
      collection.version,
      codec.version,
    );
  }
  return codec.deserialize(collection.payload);
}

/**
 * Serialize `records` with `codec` into a payload string. Deterministic for
 * identical record arrays.
 */
export function serializeCollection<T>(
  records: readonly T[],
  codec: CollectionCodec<T>,
): string {
  return codec.serialize(records);
}
