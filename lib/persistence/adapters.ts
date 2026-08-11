/**
 * Persistence layer — engine adapters (Phase 5J STEP 2).
 *
 * A `PersistenceAdapter<TEngine, TRecord>` is the pure bridge between one
 * engine and its persistable collection:
 *
 * - `snapshot(engine)` reads the engine's current records (detached clones,
 *   in insertion order) — the engine is never mutated.
 * - `restore(records)` builds a *fresh* engine over a repository seeded with
 *   the records — restart recovery without touching engine logic, manager
 *   logic, or repository logic.
 *
 * The six adapters are pure wiring over the existing engines' read surfaces
 * (`list*` / `manager.list`) and the existing production factories
 * (`createProduction*Engine(initialRepository)`). Nothing is reimplemented.
 */

import type { Memory } from "@/lib/memory/types";
import type { MemoryEngine } from "@/lib/memory/production";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { MemoryRepository } from "@/lib/memory/repository";
import type { Conversation } from "@/lib/conversation/types";
import type { ConversationEngine } from "@/lib/conversation/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { ConversationRepository } from "@/lib/conversation/repository";
import type { Job } from "@/lib/jobs/types";
import type { JobEngine } from "@/lib/jobs/production";
import { createProductionJobEngine } from "@/lib/jobs/production";
import { JobManager } from "@/lib/jobs/manager";
import { JobRepository } from "@/lib/jobs/repository";
import type { Digest } from "@/lib/digest/types";
import type { DigestEngine } from "@/lib/digest/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import { DigestManager } from "@/lib/digest/manager";
import { DigestRepository } from "@/lib/digest/repository";
import type { Action } from "@/lib/actions/types";
import type { ActionEngine } from "@/lib/actions/production";
import { createProductionActionEngine } from "@/lib/actions/production";
import { ActionManager } from "@/lib/actions/manager";
import { ActionRepository } from "@/lib/actions/repository";
import type { Workflow } from "@/lib/workflows/types";
import type { WorkflowEngine } from "@/lib/workflows/production";
import { createProductionWorkflowEngine } from "@/lib/workflows/production";
import { WorkflowManager } from "@/lib/workflows/manager";
import { WorkflowRepository } from "@/lib/workflows/repository";
import type { CollectionKind } from "./types";
import type { CollectionCodec } from "./serialization";
import { createCollectionCodec } from "./serialization";

/**
 * The pure snapshot/restore bridge for one engine collection.
 */
export interface PersistenceAdapter<TEngine, TRecord> {
  /** Which collection this adapter persists. */
  readonly kind: CollectionKind;
  /** The versioned codec used to serialize/deserialize records. */
  readonly codec: CollectionCodec<TRecord>;
  /** Read the engine's current records (detached; the engine is untouched). */
  snapshot(engine: TEngine): readonly TRecord[];
  /** Build a fresh engine over `records` (restart recovery). */
  restore(records: readonly TRecord[]): TEngine;
}

/** Adapter for the Memory Engine. */
export type MemoryAdapter = PersistenceAdapter<MemoryEngine, Memory>;

/** Adapter for the Conversation Engine. */
export type ConversationAdapter = PersistenceAdapter<ConversationEngine, Conversation>;

/** Adapter for the Job Engine. */
export type JobAdapter = PersistenceAdapter<JobEngine, Job>;

/** Adapter for the Digest Engine. */
export type DigestAdapter = PersistenceAdapter<DigestEngine, Digest>;

/** Adapter for the Action Engine. */
export type ActionAdapter = PersistenceAdapter<ActionEngine, Action>;

/** Adapter for the Workflow Engine. */
export type WorkflowAdapter = PersistenceAdapter<WorkflowEngine, Workflow>;

/** The Memory Engine adapter (kind "memory"). */
export const memoryAdapter: MemoryAdapter = {
  kind: "memory",
  codec: createCollectionCodec<Memory>("memory"),
  snapshot: (engine) => engine.listMemories(),
  restore: (records) => createProductionMemoryEngine(new MemoryRepository(records)),
};

/** The Conversation Engine adapter (kind "conversation"). */
export const conversationAdapter: ConversationAdapter = {
  kind: "conversation",
  codec: createCollectionCodec<Conversation>("conversation"),
  snapshot: (engine) => engine.listConversations(),
  restore: (records) => createProductionConversationEngine(new ConversationRepository(records)),
};

/**
 * The Job Engine adapter (kind "job").
 *
 * Restore builds the engine over a manager seeded with the persisted jobs.
 * `createProductionJobEngine` re-registers its digest handler; the digest
 * *job* is only re-seeded when the persisted collection already contains it
 * (the constructor's `seedDigestJob` default is true and is idempotent —
 * it skips when the id is already stored).
 */
export const jobAdapter: JobAdapter = {
  kind: "job",
  codec: createCollectionCodec<Job>("job"),
  snapshot: (engine) => engine.manager.list(),
  restore: (records) =>
    createProductionJobEngine({
      manager: new JobManager(new JobRepository(records)),
    }),
};

/** The Digest Engine adapter (kind "digest"). */
export const digestAdapter: DigestAdapter = {
  kind: "digest",
  codec: createCollectionCodec<Digest>("digest"),
  snapshot: (engine) => engine.manager.list(),
  restore: (records) =>
    createProductionDigestEngine({
      manager: new DigestManager(new DigestRepository(records)),
    }),
};

/**
 * The Action Engine adapter (kind "action").
 *
 * Restore seeds the action engine's manager with the persisted actions; the
 * engine's internal memory/conversation engines default to fresh instances
 * (their persisted state is restored through their own adapters).
 */
export const actionAdapter: ActionAdapter = {
  kind: "action",
  codec: createCollectionCodec<Action>("action"),
  snapshot: (engine) => engine.manager.list(),
  restore: (records) =>
    createProductionActionEngine({
      manager: new ActionManager(new ActionRepository(records)),
    }),
};

/** The Workflow Engine adapter (kind "workflow"). */
export const workflowAdapter: WorkflowAdapter = {
  kind: "workflow",
  codec: createCollectionCodec<Workflow>("workflow"),
  snapshot: (engine) => engine.manager.list(),
  restore: (records) =>
    createProductionWorkflowEngine({
      manager: new WorkflowManager(new WorkflowRepository(records)),
    }),
};

/** Every adapter in the canonical `COLLECTION_KINDS` order. */
export const ALL_ADAPTERS: readonly PersistenceAdapter<unknown, unknown>[] = Object.freeze([
  memoryAdapter,
  conversationAdapter,
  jobAdapter,
  digestAdapter,
  actionAdapter,
  workflowAdapter,
]);

/** Look up the adapter for a collection kind. */
export function adapterFor<TEngine, TRecord>(
  kind: CollectionKind,
): PersistenceAdapter<TEngine, TRecord> {
  for (const adapter of ALL_ADAPTERS) {
    if (adapter.kind === kind) return adapter as PersistenceAdapter<TEngine, TRecord>;
  }
  throw new Error(`No persistence adapter for collection "${kind}"`);
}
