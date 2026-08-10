/**
 * Daily AI Digest — digest manager (pure orchestration).
 *
 * The operation-facing facade over `DigestRepository`. Every mutation is an
 * immutable step: the receiver is never changed, and each operation returns
 * the successor manager (with the successor repository) plus any artifact it
 * produced (created/patched digest).
 *
 * Uses only `DigestRepository` — no services, no sending channels, no
 * persistence, no database, no AI.
 *
 * Lifecycle: `createDigest` → `publishDigest` / `markRead` /
 * `markDelivered`; `archiveDigest` / `restoreDigest` toggle archival;
 * `deleteDigest` is a soft delete; `bulkCreate` / `bulkDelete` are the
 * atomic batch operations. Timestamps are always caller-supplied.
 */

import { DigestNotFoundError, DigestRepository } from "./repository";
import {
  createDigest,
  createDigestDelivery,
  touchDigest,
  type CreateDigestInput,
  type Digest,
  type DigestDelivery,
  type DigestPatch,
} from "./types";

/**
 * Pure in-memory orchestration over a `DigestRepository`.
 *
 * The backing repository is exposed as a public readonly field so downstream
 * composition (delivery, production wiring) can read the exact state this
 * manager operates on.
 */
export class DigestManager {
  /** The backing immutable repository (never replaced in place). */
  readonly repository: DigestRepository;

  /**
   * Build a manager over a repository. When omitted, an empty repository is
   * used.
   */
  constructor(repository: DigestRepository = new DigestRepository()) {
    this.repository = repository;
  }

  /** Return a detached clone of the stored digest, or `undefined`. */
  find(id: string): Digest | undefined {
    return this.repository.find(id);
  }

  /** Return detached clones of every stored digest, in insertion order. */
  list(): Digest[] {
    return this.repository.list();
  }

  /** Whether a digest with the given id is stored. */
  has(id: string): boolean {
    return this.repository.has(id);
  }

  /** Number of stored digests. */
  count(): number {
    return this.repository.count();
  }

  /**
   * Build and store a new digest (via `createDigest` with defaults) and
   * return it plus the successor manager. Throws `DigestDuplicateError` for
   * an already-stored id.
   */
  createDigest(input: CreateDigestInput): { manager: DigestManager; digest: Digest } {
    const digest = createDigest(input);
    const { digest: stored, repository } = this.repository.add(digest);
    return { manager: new DigestManager(repository), digest: stored };
  }

  /**
   * Archive a digest: status `"archived"`, `updatedAt` set to `at`. Throws
   * `DigestNotFoundError` for unknown ids.
   */
  archiveDigest(
    digestId: string,
    at: string,
  ): { manager: DigestManager; digest: Digest } {
    return this.withPatch(digestId, { status: "archived", updatedAt: at });
  }

  /**
   * Restore an archived digest: status `"draft"`, `updatedAt` set to `at`.
   * Throws `DigestNotFoundError` for unknown ids.
   */
  restoreDigest(
    digestId: string,
    at: string,
  ): { manager: DigestManager; digest: Digest } {
    return this.withPatch(digestId, { status: "draft", updatedAt: at });
  }

  /**
   * Soft-delete a digest: status `"deleted"`, `updatedAt` set to `at`. The
   * digest stays stored (recoverable via `restoreDigest`). Throws
   * `DigestNotFoundError` for unknown ids.
   */
  deleteDigest(digestId: string, at: string): { manager: DigestManager; digest: Digest } {
    return this.withPatch(digestId, { status: "deleted", updatedAt: at });
  }

  /**
   * Publish a digest: status `"published"`, `updatedAt` set to `at`. Throws
   * `DigestNotFoundError` for unknown ids.
   */
  publishDigest(digestId: string, at: string): { manager: DigestManager; digest: Digest } {
    return this.withPatch(digestId, { status: "published", updatedAt: at });
  }

  /**
   * Mark a digest read: `read` true, `updatedAt` set to `at`. Throws
   * `DigestNotFoundError` for unknown ids.
   */
  markRead(digestId: string, at: string): { manager: DigestManager; digest: Digest } {
    return this.withPatch(digestId, { read: true, updatedAt: at });
  }

  /**
   * Mark a digest unread: `read` false, `updatedAt` set to `at`. Throws
   * `DigestNotFoundError` for unknown ids.
   */
  markUnread(digestId: string, at: string): { manager: DigestManager; digest: Digest } {
    return this.withPatch(digestId, { read: false, updatedAt: at });
  }

  /**
   * Record a delivery on a digest: `metadata.delivery` set to `delivery`
   * (with `deliveredAt` defaulted to `at`), `updatedAt` set to `at`. Throws
   * `DigestNotFoundError` for unknown ids.
   */
  markDelivered(
    digestId: string,
    delivery: DigestDelivery,
    at: string,
  ): { manager: DigestManager; digest: Digest } {
    const recorded = createDigestDelivery({
      format: delivery.format,
      recipients: delivery.recipients,
      deliveredAt: delivery.deliveredAt ?? at,
    });
    return this.withPatch(digestId, { delivery: recorded, updatedAt: at });
  }

  /**
   * Create many digests atomically. Returns the successor manager plus every
   * stored digest. Throws `DigestDuplicateError` on the first duplicate id
   * (the receiver is unchanged either way).
   */
  bulkCreate(inputs: readonly CreateDigestInput[]): {
    manager: DigestManager;
    digests: Digest[];
  } {
    let repository = this.repository;
    const digests: Digest[] = [];
    for (const input of inputs) {
      const digest = createDigest(input);
      const result = repository.add(digest);
      repository = result.repository;
      digests.push(result.digest);
    }
    return { manager: new DigestManager(repository), digests };
  }

  /**
   * Soft-delete many digests atomically. Throws `DigestNotFoundError` on the
   * first unknown id (the receiver is unchanged either way).
   */
  bulkDelete(digestIds: readonly string[], at: string): DigestManager {
    let repository = this.repository;
    for (const digestId of digestIds) {
      const current = repository.find(digestId);
      if (current === undefined) {
        throw new DigestNotFoundError(digestId);
      }
      const updated = touchDigest(current, { status: "deleted", updatedAt: at });
      repository = repository.replace(updated);
    }
    return new DigestManager(repository);
  }

  /** Apply a patch and return the patched digest plus the successor manager. */
  private withPatch(
    digestId: string,
    patch: DigestPatch,
  ): { manager: DigestManager; digest: Digest } {
    const { digest, repository } = this.repository.update(digestId, patch);
    return { manager: new DigestManager(repository), digest };
  }
}
