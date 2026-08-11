/**
 * Persistence layer — shared types (Phase 5J STEP 2/3).
 *
 * The persistence layer is the application's durable-storage seam over the
 * in-memory engine repositories. It stays engine-agnostic: a
 * `PersistenceStore` persists *collections* of serialized engine records,
 * keyed by a caller-supplied `scope` (e.g. a user id or "app") and a
 * `CollectionKind`. The per-engine adapters (see `./adapters`) bridge a
 * concrete engine to its collection via pure snapshot/restore functions.
 *
 * Everything is immutable and dependency-injected; the store never touches
 * engine logic, managers, or repositories.
 */

import { AppError } from "@/lib/errors";
import { hashString } from "@/lib/hash";

/** The six engine record collections the persistence layer can persist. */
export type CollectionKind =
  | "memory"
  | "conversation"
  | "job"
  | "digest"
  | "action"
  | "workflow";

/** Every persistable collection kind, in a stable canonical order. */
export const COLLECTION_KINDS: readonly CollectionKind[] = Object.freeze([
  "memory",
  "conversation",
  "job",
  "digest",
  "action",
  "workflow",
]);

/** Default schema version written by new codecs. */
export const DEFAULT_SCHEMA_VERSION = 1;

/**
 * A serialized engine collection: the plain JSON-serializable records plus
 * the codec version that produced them (schema versioning / migration-safe
 * storage — a reader must support the writer's version).
 */
export interface StoredCollection {
  /** Caller-supplied namespace (e.g. a user id or "app"). */
  readonly scope: string;
  /** Which engine collection this is. */
  readonly kind: CollectionKind;
  /** Codec schema version (forward-compatibility gate). */
  readonly version: number;
  /** The serialized records (JSON string; see `./serialization`). */
  readonly payload: string;
  /** Stable id derived deterministically from scope + kind. */
  readonly id: string;
}

/** Options accepted by {@link createStoredCollection}. */
export interface CreateStoredCollectionInput {
  readonly scope: string;
  readonly kind: CollectionKind;
  readonly version: number;
  readonly payload: string;
}

/**
 * Build an immutable `StoredCollection`. The id is a deterministic hash of
 * scope + kind — no randomness, no wall clock.
 */
export function createStoredCollection(
  input: CreateStoredCollectionInput,
): StoredCollection {
  return Object.freeze({
    scope: input.scope,
    kind: input.kind,
    version: input.version,
    payload: input.payload,
    id: `collection-${hashString(`${input.scope}:${input.kind}`)}`,
  });
}

/**
 * The durable-storage contract. Implementations are repositories of
 * `StoredCollection`s; every read returns a detached clone and every write
 * replaces the stored collection wholesale (full-snapshot semantics — the
 * engines persist entire collections, never partial deltas).
 */
export interface PersistenceStore {
  /** Read the stored collection for `(scope, kind)`, or `undefined`. */
  read(scope: string, kind: CollectionKind): Promise<StoredCollection | undefined>;
  /** Replace (or insert) the stored collection for `(scope, kind)`. */
  write(scope: string, kind: CollectionKind, collection: StoredCollection): Promise<void>;
  /** Remove the stored collection for `(scope, kind)`. Never throws. */
  clear(scope: string, kind: CollectionKind): Promise<void>;
}

/** Raised when a collection is loaded but was never stored. */
export class PersistenceNotFoundError extends AppError {
  constructor(scope: string, kind: CollectionKind) {
    super(`No persisted collection for ${scope}/${kind}`, 404, "persistence_not_found");
  }
}

/** Raised when stored data was written by a newer codec version. */
export class PersistenceVersionError extends AppError {
  constructor(scope: string, kind: CollectionKind, stored: number, supported: number) {
    super(
      `Persisted ${scope}/${kind} uses schema version ${stored} but this build supports ${supported}`,
      409,
      "persistence_version_mismatch",
    );
  }
}

/** Raised when a stored payload is not valid for its collection. */
export class PersistenceCorruptError extends AppError {
  constructor(scope: string, kind: CollectionKind, detail: string) {
    super(
      `Persisted ${scope}/${kind} payload is invalid: ${detail}`,
      500,
      "persistence_corrupt",
    );
  }
}
