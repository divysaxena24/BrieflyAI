/**
 * Daily AI Digest — immutable in-memory digest repository.
 *
 * `DigestRepository` is the storage facade of the digest layer: a private,
 * immutable collection of `Digest` objects held in insertion order. Every
 * mutation returns a NEW repository — the original is never changed.
 *
 * Guarantees:
 * - **Constructor snapshot**: the initial digests are copied on entry; later
 *   caller mutation of those objects never affects the repository.
 * - **Detached clones**: every stored digest is deep-frozen internally, and
 *   every read returns a fresh detached clone.
 * - **Insertion order**: `list()` returns digests in creation order;
 *   `update`/`replace` keep a digest's position; `remove` removes it.
 * - **Filter queries**: `findByKind`, `findByStatus`, `findByPriority`,
 *   `findByRecipient` (digests delivered to an address), and `findByDate`
 *   (digests whose window contains a date).
 * - **No caching, no singleton, no storage, no database**.
 *
 * All operations are deterministic: identical operation sequences produce
 * deep-equal repository states.
 */

import { AppError } from "@/lib/errors";
import {
  cloneDigest,
  freezeDigest,
  touchDigest,
  type Digest,
  type DigestKind,
  type DigestPatch,
  type DigestPriority,
  type DigestStatus,
} from "./types";

/** Raised when an operation targets a digest id that is not stored. */
export class DigestNotFoundError extends AppError {
  constructor(digestId: string) {
    super(`Digest not found: ${digestId}`, 404, "digest_not_found");
  }
}

/** Raised when a digest is added with an id that is already stored. */
export class DigestDuplicateError extends AppError {
  constructor(digestId: string) {
    super(`Digest already exists: ${digestId}`, 409, "digest_duplicate_id");
  }
}

/**
 * Immutable in-memory collection of digests.
 *
 * All methods are pure with respect to the repository: reads never mutate,
 * and mutations return the successor repository without touching `this`.
 */
export class DigestRepository {
  /** The stored digests, oldest first, deep-frozen. */
  private readonly digests: readonly Digest[];

  /**
   * Build a repository from an initial set of digests.
   *
   * Every digest is copied (detached from the caller) and deep-frozen; the
   * internal array itself is frozen. Insertion order of the input is
   * preserved.
   */
  constructor(initialDigests: readonly Digest[] = []) {
    this.digests = Object.freeze(initialDigests.map((digest) => freezeDigest(cloneDigest(digest))));
  }

  /**
   * Store a new digest (appended at the end). Throws
   * `DigestDuplicateError` for an already-stored id. Returns the stored
   * digest plus the successor repository.
   */
  add(digest: Digest): { digest: Digest; repository: DigestRepository } {
    if (this.has(digest.id)) {
      throw new DigestDuplicateError(digest.id);
    }
    const stored = freezeDigest(cloneDigest(digest));
    return { digest: stored, repository: new DigestRepository([...this.digests, stored]) };
  }

  /**
   * Apply a partial patch to the stored digest with the given id.
   *
   * Missing patch keys are preserved; `tags`/`sections` are copied; a `null`
   * value clears an optional field. Throws `DigestNotFoundError` for unknown
   * ids. Returns the patched digest (a new object) plus the successor
   * repository (position preserved).
   */
  update(id: string, patch: DigestPatch): { digest: Digest; repository: DigestRepository } {
    const current = this.require(id);
    const updated = touchDigest(current, patch);
    return {
      digest: cloneDigest(updated),
      repository: new DigestRepository(
        this.digests.map((stored) =>
          stored.id === id ? freezeDigest(cloneDigest(updated)) : stored,
        ),
      ),
    };
  }

  /**
   * Replace the stored digest with the same id by a detached copy of
   * `digest`. The digest keeps its insertion position. Throws
   * `DigestNotFoundError` for unknown ids.
   */
  replace(digest: Digest): DigestRepository {
    this.require(digest.id);
    return new DigestRepository(
      this.digests.map((stored) =>
        stored.id === digest.id ? freezeDigest(cloneDigest(digest)) : stored,
      ),
    );
  }

  /** Remove the digest with the given id. Throws for unknown ids. */
  remove(id: string): DigestRepository {
    this.require(id);
    return new DigestRepository(this.digests.filter((digest) => digest.id !== id));
  }

  /** Return a new, empty repository. The receiver is never modified. */
  clear(): DigestRepository {
    return new DigestRepository();
  }

  /** Return a detached clone of the stored digest, or `undefined`. */
  find(id: string): Digest | undefined {
    const stored = this.digests.find((digest) => digest.id === id);
    return stored === undefined ? undefined : cloneDigest(stored);
  }

  /** Alias of {@link find} — explicit id lookup. */
  findById(id: string): Digest | undefined {
    return this.find(id);
  }

  /** Return detached clones of every digest of the given kind, in order. */
  findByKind(kind: DigestKind): Digest[] {
    return this.list().filter((digest) => digest.metadata.kind === kind);
  }

  /** Return detached clones of every digest with the given status, in order. */
  findByStatus(status: DigestStatus): Digest[] {
    return this.list().filter((digest) => digest.metadata.status === status);
  }

  /** Return detached clones of every digest with the given priority, in order. */
  findByPriority(priority: DigestPriority): Digest[] {
    return this.list().filter((digest) => digest.metadata.priority === priority);
  }

  /**
   * Return detached clones of every digest delivered to `address` (matching
   * any recipient of the digest's most recent delivery), in order.
   */
  findByRecipient(address: string): Digest[] {
    return this.list().filter((digest) =>
      (digest.metadata.delivery?.recipients ?? []).some(
        (recipient) => recipient.address === address,
      ),
    );
  }

  /**
   * Return detached clones of every digest whose window contains `date`
   * (inclusive), in order.
   */
  findByDate(date: string): Digest[] {
    const dateMs = Date.parse(date);
    return this.list().filter((digest) => {
      const from = Date.parse(digest.metadata.window.from);
      const to = Date.parse(digest.metadata.window.to);
      return dateMs >= from && dateMs <= to;
    });
  }

  /** Return detached clones of every stored digest, in insertion order. */
  list(): Digest[] {
    return this.digests.map(cloneDigest);
  }

  /** Whether a digest with the given id is stored. */
  has(id: string): boolean {
    return this.digests.some((digest) => digest.id === id);
  }

  /** Number of stored digests. */
  count(): number {
    return this.digests.length;
  }

  /** Throw `DigestNotFoundError` unless the id is stored. */
  private require(id: string): Digest {
    const stored = this.digests.find((digest) => digest.id === id);
    if (stored === undefined) {
      throw new DigestNotFoundError(id);
    }
    return stored;
  }
}
