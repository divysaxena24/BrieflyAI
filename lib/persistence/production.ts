/**
 * Persistence layer — production composition (Phase 5J STEP 3).
 *
 * `PersistenceEngine` is the composition root of the persistence layer: it
 * binds the `PersistenceStore` (dependency-injected) to the six engine
 * adapters and exposes the full `save / load / replace / clear / snapshot`
 * contract over every engine collection.
 *
 * - **save(scope, kind, engine)** snapshots the engine's current records and
 *   writes the serialized collection to the store.
 * - **load(scope, kind)** reads the store and returns the *records*;
 *   `loadEngine` rebuilds a fresh engine over them (restart recovery).
 * - **replace** is the full-replace alias of save (collections are always
 *   stored as whole snapshots).
 * - **clear(scope, kind)** removes the persisted collection.
 * - **saveAll / restoreAll / clearAll** operate over the six engines with
 *   per-collection failure isolation.
 *
 * The store is injected: `MemoryPersistenceStore` by default (deterministic,
 * no database required); applications with a database wire
 * `createPostgresPersistenceStore()` from `./dbStore`. The engines never
 * know which store backs them.
 */

import { getProductionActionEngine } from "@/lib/actions/production";
import { getProductionConversationEngine } from "@/lib/conversation/production";
import { getProductionDigestEngine } from "@/lib/digest/production";
import { getProductionJobEngine } from "@/lib/jobs/production";
import { getProductionMemoryEngine } from "@/lib/memory/production";
import { getProductionWorkflowEngine } from "@/lib/workflows/production";
import { MemoryPersistenceStore } from "./store";
import {
  ALL_ADAPTERS,
  actionAdapter,
  conversationAdapter,
  digestAdapter,
  jobAdapter,
  memoryAdapter,
  workflowAdapter,
  type PersistenceAdapter,
} from "./adapters";
import { deserializeCollection, serializeCollection } from "./serialization";
import {
  createStoredCollection,
  PersistenceNotFoundError,
  type CollectionKind,
  type PersistenceStore,
  type StoredCollection,
} from "./types";
import type { Memory } from "@/lib/memory/types";
import type { MemoryEngine } from "@/lib/memory/production";
import type { Conversation } from "@/lib/conversation/types";
import type { ConversationEngine } from "@/lib/conversation/production";
import type { Job } from "@/lib/jobs/types";
import type { JobEngine } from "@/lib/jobs/production";
import type { Digest } from "@/lib/digest/types";
import type { DigestEngine } from "@/lib/digest/production";
import type { Action } from "@/lib/actions/types";
import type { ActionEngine } from "@/lib/actions/production";
import type { Workflow } from "@/lib/workflows/types";
import type { WorkflowEngine } from "@/lib/workflows/production";

/** The six application engines, as a single restorable set. */
export interface EngineSet {
  readonly memory: MemoryEngine;
  readonly conversation: ConversationEngine;
  readonly jobs: JobEngine;
  readonly digest: DigestEngine;
  readonly actions: ActionEngine;
  readonly workflows: WorkflowEngine;
}

/** Options accepted by the {@link PersistenceEngine} constructor. */
export interface PersistenceEngineOptions {
  /** The durable store (dependency injection); in-memory by default. */
  readonly store?: PersistenceStore;
  /** The adapters (dependency injection); all six by default. */
  readonly adapters?: readonly PersistenceAdapter<unknown, unknown>[];
}

/** A per-collection persistence failure (failure-isolated batches). */
export interface PersistenceError {
  readonly scope: string;
  readonly kind: CollectionKind;
  readonly message: string;
}

/** The persistence composition root over the engine adapters. */
export class PersistenceEngine {
  /** The injected durable store. */
  readonly store: PersistenceStore;

  private readonly adapters: ReadonlyMap<CollectionKind, PersistenceAdapter<unknown, unknown>>;

  constructor(options: PersistenceEngineOptions = {}) {
    this.store = options.store ?? new MemoryPersistenceStore();
    const adapters = options.adapters ?? ALL_ADAPTERS;
    const map = new Map<CollectionKind, PersistenceAdapter<unknown, unknown>>();
    for (const adapter of adapters) {
      if (map.has(adapter.kind)) {
        throw new Error(`Persistence engine already contains adapter "${adapter.kind}"`);
      }
      map.set(adapter.kind, adapter);
    }
    this.adapters = map;
  }

  /** The adapter for a collection kind, or `undefined` when not registered. */
  adapter<TEngine, TRecord>(kind: CollectionKind): PersistenceAdapter<TEngine, TRecord> | undefined {
    return this.adapters.get(kind) as PersistenceAdapter<TEngine, TRecord> | undefined;
  }

  /** Whether an adapter for `kind` is registered. */
  hasAdapter(kind: CollectionKind): boolean {
    return this.adapters.has(kind);
  }

  /** The registered adapter kinds in registration order. */
  kinds(): readonly CollectionKind[] {
    return [...this.adapters.keys()];
  }

  /**
   * Serialize an engine's records into a `StoredCollection` without writing
   * to the store (pure snapshot).
   */
  snapshot<TEngine, TRecord>(
    scope: string,
    kind: CollectionKind,
    engine: TEngine,
  ): StoredCollection {
    const adapter = this.requireAdapter<TEngine, TRecord>(kind);
    return createStoredCollection({
      scope,
      kind,
      version: adapter.codec.version,
      payload: serializeCollection(adapter.snapshot(engine), adapter.codec),
    });
  }

  /**
   * Persist an engine's full collection under `(scope, kind)` (write-through
   * snapshot). Returns the stored collection.
   */
  async save<TEngine, TRecord>(
    scope: string,
    kind: CollectionKind,
    engine: TEngine,
  ): Promise<StoredCollection> {
    const collection = this.snapshot(scope, kind, engine);
    await this.store.write(scope, kind, collection);
    return collection;
  }

  /**
   * Full-replace semantics: identical to {@link save} — collections are
   * always persisted as whole snapshots, so replacing is the same write.
   */
  async replace<TEngine, TRecord>(
    scope: string,
    kind: CollectionKind,
    engine: TEngine,
  ): Promise<StoredCollection> {
    return this.save(scope, kind, engine);
  }

  /**
   * Load the records persisted under `(scope, kind)`. Throws
   * `PersistenceNotFoundError` when nothing is stored and
   * `PersistenceVersionError`/`PersistenceCorruptError` for unreadable data.
   */
  async load<TEngine, TRecord>(scope: string, kind: CollectionKind): Promise<readonly TRecord[]> {
    const adapter = this.requireAdapter<TEngine, TRecord>(kind);
    const collection = await this.store.read(scope, kind);
    if (collection === undefined) {
      throw new PersistenceNotFoundError(scope, kind);
    }
    return deserializeCollection(collection, adapter.codec) as readonly TRecord[];
  }

  /** Like {@link load}, but returns `[]` when nothing is stored. */
  async loadOrEmpty<TEngine, TRecord>(scope: string, kind: CollectionKind): Promise<readonly TRecord[]> {
    const collection = await this.store.read(scope, kind);
    if (collection === undefined) return [];
    const adapter = this.requireAdapter<TEngine, TRecord>(kind);
    return deserializeCollection(collection, adapter.codec) as readonly TRecord[];
  }

  /**
   * Load persisted records and rebuild a fresh engine over them (restart
   * recovery). Throws `PersistenceNotFoundError` when nothing is stored.
   */
  async loadEngine<TEngine, TRecord>(scope: string, kind: CollectionKind): Promise<TEngine> {
    const adapter = this.requireAdapter<TEngine, TRecord>(kind);
    return adapter.restore(await this.load(scope, kind));
  }

  /** Remove the persisted collection under `(scope, kind)`. Never throws. */
  async clear(scope: string, kind: CollectionKind): Promise<void> {
    await this.store.clear(scope, kind);
  }

  // ─────────────────────────────────────────────────────────────
  // Typed conveniences — one pair per engine collection.
  // ─────────────────────────────────────────────────────────────

  /** Persist the Memory Engine's collection. */
  saveMemory(scope: string, engine: MemoryEngine): Promise<StoredCollection> {
    return this.save(scope, "memory", engine);
  }

  /** Rebuild a fresh Memory Engine from the persisted collection. */
  loadMemory(scope: string): Promise<MemoryEngine> {
    return this.loadEngine<MemoryEngine, Memory>(scope, "memory");
  }

  /** Persist the Conversation Engine's collection. */
  saveConversation(scope: string, engine: ConversationEngine): Promise<StoredCollection> {
    return this.save(scope, "conversation", engine);
  }

  /** Rebuild a fresh Conversation Engine from the persisted collection. */
  loadConversation(scope: string): Promise<ConversationEngine> {
    return this.loadEngine<ConversationEngine, Conversation>(scope, "conversation");
  }

  /** Persist the Job Engine's collection. */
  saveJobs(scope: string, engine: JobEngine): Promise<StoredCollection> {
    return this.save(scope, "job", engine);
  }

  /** Rebuild a fresh Job Engine from the persisted collection. */
  loadJobs(scope: string): Promise<JobEngine> {
    return this.loadEngine<JobEngine, Job>(scope, "job");
  }

  /** Persist the Digest Engine's collection. */
  saveDigests(scope: string, engine: DigestEngine): Promise<StoredCollection> {
    return this.save(scope, "digest", engine);
  }

  /** Rebuild a fresh Digest Engine from the persisted collection. */
  loadDigests(scope: string): Promise<DigestEngine> {
    return this.loadEngine<DigestEngine, Digest>(scope, "digest");
  }

  /** Persist the Action Engine's collection. */
  saveActions(scope: string, engine: ActionEngine): Promise<StoredCollection> {
    return this.save(scope, "action", engine);
  }

  /** Rebuild a fresh Action Engine from the persisted collection. */
  loadActions(scope: string): Promise<ActionEngine> {
    return this.loadEngine<ActionEngine, Action>(scope, "action");
  }

  /** Persist the Workflow Engine's collection. */
  saveWorkflows(scope: string, engine: WorkflowEngine): Promise<StoredCollection> {
    return this.save(scope, "workflow", engine);
  }

  /** Rebuild a fresh Workflow Engine from the persisted collection. */
  loadWorkflows(scope: string): Promise<WorkflowEngine> {
    return this.loadEngine<WorkflowEngine, Workflow>(scope, "workflow");
  }

  // ─────────────────────────────────────────────────────────────
  // Batch operations over the six engines (failure-isolated).
  // ─────────────────────────────────────────────────────────────

  /**
   * Persist every engine in `engines` under `scope`. Per-collection failures
   * are isolated: the remaining collections are still saved, and every
   * failure is reported in the result. Deterministic order (canonical
   * collection order).
   */
  async saveAll(scope: string, engines: EngineSet): Promise<{ saved: readonly StoredCollection[]; errors: readonly PersistenceError[] }> {
    const saved: StoredCollection[] = [];
    const errors: PersistenceError[] = [];
    const operations: ReadonlyArray<{ kind: CollectionKind; run: () => Promise<StoredCollection> }> = [
      { kind: "memory", run: () => this.saveMemory(scope, engines.memory) },
      { kind: "conversation", run: () => this.saveConversation(scope, engines.conversation) },
      { kind: "job", run: () => this.saveJobs(scope, engines.jobs) },
      { kind: "digest", run: () => this.saveDigests(scope, engines.digest) },
      { kind: "action", run: () => this.saveActions(scope, engines.actions) },
      { kind: "workflow", run: () => this.saveWorkflows(scope, engines.workflows) },
    ];
    for (const operation of operations) {
      try {
        saved.push(await operation.run());
      } catch (err) {
        errors.push({
          scope,
          kind: operation.kind,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { saved, errors };
  }

  /**
   * Rebuild a fresh `EngineSet` from the persisted collections (restart
   * recovery). Missing collections restore as empty engines; per-collection
   * load failures are isolated (the failed engine restores empty) and
   * reported.
   */
  async restoreAll(scope: string): Promise<{ engines: EngineSet; errors: readonly PersistenceError[] }> {
    const errors: PersistenceError[] = [];
    const load = async <TEngine, TRecord>(
      kind: CollectionKind,
      restore: (records: readonly TRecord[]) => TEngine,
    ): Promise<TEngine> => {
      try {
        const records = await this.loadOrEmpty<TEngine, TRecord>(scope, kind);
        return restore(records);
      } catch (err) {
        errors.push({
          scope,
          kind,
          message: err instanceof Error ? err.message : String(err),
        });
        return restore([]);
      }
    };

    const engines: EngineSet = {
      memory: await load("memory", memoryAdapter.restore),
      conversation: await load("conversation", conversationAdapter.restore),
      jobs: await load("job", jobAdapter.restore),
      digest: await load("digest", digestAdapter.restore),
      actions: await load("action", actionAdapter.restore),
      workflows: await load("workflow", workflowAdapter.restore),
    };
    return { engines, errors };
  }

  /** Clear every persisted collection under `scope`. Never throws. */
  async clearAll(scope: string): Promise<void> {
    for (const kind of this.kinds()) {
      await this.store.clear(scope, kind);
    }
  }

  /** The adapter for a kind, or throw (unknown collection). */
  private requireAdapter<TEngine, TRecord>(
    kind: CollectionKind,
  ): PersistenceAdapter<TEngine, TRecord> {
    const adapter = this.adapters.get(kind);
    if (adapter === undefined) {
      throw new Error(`No persistence adapter registered for collection "${kind}"`);
    }
    return adapter as PersistenceAdapter<TEngine, TRecord>;
  }
}

/**
 * Build a fresh production persistence engine.
 *
 * Optional `store`/`adapters` seed the graph (dependency injection). The
 * default store is in-memory — applications with a database wire
 * `createPostgresPersistenceStore()` from `./dbStore`. Pure — construction
 * only; nothing is read or written.
 */
export function createProductionPersistence(options: PersistenceEngineOptions = {}): PersistenceEngine {
  return new PersistenceEngine(options);
}

/**
 * The application's single production persistence engine instance.
 * In-memory store by default (deterministic, no database required).
 */
const productionPersistence = createProductionPersistence();

/** Return the application's single production persistence engine instance. */
export function getProductionPersistence(): PersistenceEngine {
  return productionPersistence;
}

/**
 * Persist the six production singleton engines under `scope` (the
 * application's background save entry point).
 */
export function saveProductionState(scope = "app"): Promise<{
  saved: readonly StoredCollection[];
  errors: readonly PersistenceError[];
}> {
  const persistence = getProductionPersistence();
  return persistence.saveAll(scope, {
    memory: getProductionMemoryEngine(),
    conversation: getProductionConversationEngine(),
    jobs: getProductionJobEngine(),
    digest: getProductionDigestEngine(),
    actions: getProductionActionEngine(),
    workflows: getProductionWorkflowEngine(),
  });
}

/** Rebuild a fresh engine set from the persisted collections (restart recovery). */
export function restoreProductionState(scope = "app"): Promise<{
  engines: EngineSet;
  errors: readonly PersistenceError[];
}> {
  return getProductionPersistence().restoreAll(scope);
}

/** Snapshot the six production singleton engines without writing. */
export function snapshotProductionState(scope = "app"): readonly StoredCollection[] {
  const persistence = getProductionPersistence();
  return [
    persistence.snapshot(scope, "memory", getProductionMemoryEngine()),
    persistence.snapshot(scope, "conversation", getProductionConversationEngine()),
    persistence.snapshot(scope, "job", getProductionJobEngine()),
    persistence.snapshot(scope, "digest", getProductionDigestEngine()),
    persistence.snapshot(scope, "action", getProductionActionEngine()),
    persistence.snapshot(scope, "workflow", getProductionWorkflowEngine()),
  ];
}

