/**
 * Production Database Layer — retention & cleanup (Phase 6A STEP 8).
 *
 * `RetentionEngine` applies immutable retention policies (`DatabaseRetention`)
 * over one `(scope, collection)`'s records. It composes the driver and the
 * pure policy models from `./types`:
 *
 * - **Preview** (`previewCleanup`) reports exactly which records a policy
 *   would act on, in deterministic order, without writing anything.
 * - **Execution** (`runCleanup`) applies the action (archive / soft_delete /
 *   delete) and returns an immutable `DatabaseCleanup` report.
 * - **Policies** support age (`olderThanDays`), `keepCount` (protect the
 *   newest N), `expiredOnly` (records whose data carries an `expiresAt` at
 *   or before now), and `orphanOnly` (records `isOrphan` rejects).
 * - **Statistics** (`statistics`) aggregate totals per collection.
 *
 * Everything is deterministic and immutable: ordering is the canonical query
 * order (newest first), timestamps are caller-supplied, and mutations go
 * through the driver atomically.
 */

import {
  createDatabaseCleanup,
  createDatabaseStatistics,
  timestampMillis,
  DAY_MS,
  type DatabaseCleanup,
  type DatabaseCleanupApplied,
  type DatabaseCollectionKind,
  type DatabaseRecord,
  type DatabaseRetention,
  type DatabaseRetentionAction,
  type DatabaseStatistics,
} from "@/lib/database/types";
import type { DatabaseDriver } from "@/lib/database/driver";
import { buildDatabaseQuery, compareBySort, nestedDataValue } from "@/lib/database/query";

/** The collections with retention policies in the canonical order. */
export const RETENTION_COLLECTIONS: readonly DatabaseCollectionKind[] = Object.freeze([
  "memory",
  "conversation",
  "action",
  "job",
  "digest",
  "workflow",
  "event",
]);

/** An orphan predicate: true when a record references a missing entity. */
export type DatabaseOrphanPredicate = (record: DatabaseRecord<unknown>) => boolean;

/** Options accepted by the {@link RetentionEngine} constructor. */
export interface RetentionEngineOptions {
  /** The storage driver (dependency injection). */
  readonly driver: DatabaseDriver;
  /** Active policies (dependency injection). */
  readonly policies?: readonly DatabaseRetention[];
  /** Orphan predicate (dependency injection; only used by orphan policies). */
  readonly isOrphan?: DatabaseOrphanPredicate;
}

/** Options accepted by `runCleanup` / `previewCleanup`. */
export interface RunCleanupInput {
  readonly scope: string;
  /** ISO-8601 UTC timestamp of the cleanup (caller-supplied). */
  readonly now: string;
  /** Optional subset of policies; all registered policies by default. */
  readonly policies?: readonly DatabaseRetention[];
}

/** The retention composition root over a driver. */
export class RetentionEngine {
  /** The storage driver. */
  readonly driver: DatabaseDriver;

  private readonly policies: readonly DatabaseRetention[];
  private readonly isOrphan: DatabaseOrphanPredicate;

  constructor(options: RetentionEngineOptions) {
    this.driver = options.driver;
    this.policies = options.policies ?? [];
    this.isOrphan = options.isOrphan ?? (() => false);
  }

  /** The registered policies, in registration order (detached). */
  listPolicies(): readonly DatabaseRetention[] {
    return this.policies.map((policy) => ({ ...policy }));
  }

  /**
   * Compute which records each policy would act on, without writing anything.
   * Deterministic: policies run in registration order; each policy's record
   * list is sorted newest-first. Returns the immutable report.
   */
  async previewCleanup(input: RunCleanupInput): Promise<DatabaseCleanup> {
    const applied: DatabaseCleanupApplied[] = [];
    for (const policy of this.policiesFor(input.policies)) {
      const recordIds = await this.policyTargets(policy, input.scope, input.now);
      if (recordIds.length === 0) continue;
      applied.push({
        collection: policy.collection,
        action: policy.action,
        recordIds,
      });
    }
    return createDatabaseCleanup({
      scope: input.scope,
      at: input.now,
      preview: true,
      applied,
    });
  }

  /**
   * Apply every policy and return an immutable `DatabaseCleanup` report.
   * Each action is executed atomically per collection via the driver.
   */
  async runCleanup(input: RunCleanupInput): Promise<DatabaseCleanup> {
    const applied: DatabaseCleanupApplied[] = [];
    for (const policy of this.policiesFor(input.policies)) {
      const recordIds = await this.policyTargets(policy, input.scope, input.now);
      if (recordIds.length === 0) continue;
      await this.applyAction(policy.collection, policy.action, input.scope, recordIds, input.now);
      applied.push({
        collection: policy.collection,
        action: policy.action,
        recordIds,
      });
    }
    return createDatabaseCleanup({
      scope: input.scope,
      at: input.now,
      preview: false,
      applied,
    });
  }

  /** Aggregate statistics over every collection. */
  async statistics(scope: string): Promise<readonly DatabaseStatistics[]> {
    const out: DatabaseStatistics[] = [];
    for (const collection of RETENTION_COLLECTIONS) {
      const records = await this.driver.readAll(scope, collection);
      out.push(
        createDatabaseStatistics({ scope, collection, records }),
      );
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────

  /** The policies to run for a cleanup (subset or all). */
  private policiesFor(subset?: readonly DatabaseRetention[]): readonly DatabaseRetention[] {
    if (subset === undefined) return this.policies;
    const byId = new Map(this.policies.map((policy) => [policy.id, policy]));
    return subset
      .map((policy) => byId.get(policy.id))
      .filter((policy): policy is DatabaseRetention => policy !== undefined);
  }

  /** The record ids a policy acts on, newest-first, deterministic. */
  private async policyTargets(
    policy: DatabaseRetention,
    scope: string,
    now: string,
  ): Promise<readonly string[]> {
    const records = await this.driver.readAll(scope, policy.collection);
    const candidates = records.filter((record) => this.policyMatches(record, policy, now));
    const sorted = [...candidates].sort((a, b) =>
      compareBySort(a, b, buildDatabaseQuery({}).sort),
    );
    const protectedCount = policy.keepCount ?? 0;
    const actionable = sorted.slice(protectedCount);
    return actionable.map((record) => record.recordId);
  }

  /** Whether a single record matches a policy. */
  private policyMatches(record: DatabaseRecord<unknown>, policy: DatabaseRetention, now: string): boolean {
    if (record.deletedAt !== null) return false; // already soft-deleted
    if (policy.action === "archive" && record.archived) return false; // already archived
    if (policy.orphanOnly && !this.isOrphan(record)) return false;
    if (policy.expiredOnly) {
      const expiresAt = this.recordExpiresAt(record, policy.dataPath);
      if (expiresAt === undefined) return false;
      if (timestampMillis(expiresAt) > timestampMillis(now)) return false;
    }
    if (policy.olderThanDays !== undefined) {
      const cutoff = timestampMillis(now) - policy.olderThanDays * DAY_MS;
      if (timestampMillis(record.updatedAt) > cutoff) return false;
    }
    return true;
  }

  /** The `expiresAt` timestamp inside a record's data, if present. */
  private recordExpiresAt(record: DatabaseRecord<unknown>, dataPath?: string): string | undefined {
    const data = record.data;
    if (data === null || typeof data !== "object") return undefined;
    if (dataPath !== undefined) {
      const value = nestedDataValue(data, dataPath);
      return typeof value === "string" ? value : undefined;
    }
    const value = (data as Record<string, unknown>)["expiresAt"];
    return typeof value === "string" ? value : undefined;
  }

  /** Apply one action over a record id set, atomically per collection. */
  private async applyAction(
    collection: DatabaseCollectionKind,
    action: DatabaseRetentionAction,
    scope: string,
    recordIds: readonly string[],
    now: string,
  ): Promise<void> {
    if (action === "delete") {
      await this.driver.deleteMany(scope, collection, recordIds);
      return;
    }
    const records = await this.driver.readAll(scope, collection);
    const updates = records
      .filter((record) => recordIds.includes(record.recordId))
      .map((record) => {
        if (action === "archive") {
          return {
            ...record,
            archived: true,
            archivedAt: now,
            updatedAt: now,
            revision: record.revision + 1,
          };
        }
        // soft_delete
        return {
          ...record,
          deletedAt: now,
          updatedAt: now,
          revision: record.revision + 1,
        };
      });
    await this.driver.upsertAll(scope, collection, updates);
  }
}

/** Build a fresh retention engine over a driver (dependency injection). */
export function createRetentionEngine(options: RetentionEngineOptions): RetentionEngine {
  return new RetentionEngine(options);
}

/** Convenience: a retention policy that acts on records older than N days. */
export function retentionOlderThan(
  collection: DatabaseCollectionKind,
  action: DatabaseRetentionAction,
  olderThanDays: number,
  createdAt: string,
  keepCount = 0,
): DatabaseRetention {
  return Object.freeze({
    id: `retention-older-${collection}-${action}-${olderThanDays}-${keepCount}`,
    collection,
    action,
    olderThanDays,
    keepCount,
    createdAt,
  });
}

/** Convenience: a retention policy that acts on expired records only. */
export function retentionExpired(
  collection: DatabaseCollectionKind,
  action: DatabaseRetentionAction,
  createdAt: string,
  dataPath?: string,
): DatabaseRetention {
  return Object.freeze({
    id: `retention-expired-${collection}-${action}-${dataPath ?? ""}`,
    collection,
    action,
    expiredOnly: true,
    ...(dataPath !== undefined ? { dataPath } : {}),
    createdAt,
  });
}

/** Convenience: a retention policy that acts on orphan records only. */
export function retentionOrphans(
  collection: DatabaseCollectionKind,
  action: DatabaseRetentionAction,
  createdAt: string,
): DatabaseRetention {
  return Object.freeze({
    id: `retention-orphans-${collection}-${action}`,
    collection,
    action,
    orphanOnly: true,
    createdAt,
  });
}
