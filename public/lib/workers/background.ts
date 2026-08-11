/**
 * Background Worker Infrastructure — background integration (Phase 6B STEP 11).
 *
 * The application seam that connects the worker engine to the rest of the
 * architecture:
 *
 * - **Event Bus**: application events are mapped to worker tasks through an
 *   injectable `mapEventToTask` (dependency injection — the default maps
 *   nothing). Listener failures are isolated by the bus itself.
 * - **Persistence**: the worker manager snapshot is persisted through the
 *   existing `DatabaseEngine` repository seam (`metadata` collection) —
 *   never a duplicated store.
 * - **Restart recovery**: `recover()` rebuilds a fresh `WorkerManager` from
 *   the persisted snapshot (queues reconstructed deterministically from task
 *   statuses) and returns a successor engine.
 * - **Graceful shutdown / restart**: delegated to the engine.
 * - **Automatic retries**: the manager's retry queue + `advance` already
 *   implement the retry loop — the integration simply runs passes.
 *
 * No orchestration is reimplemented; everything delegates to the existing
 * engines.
 */

import { EventBus } from "@/lib/events/bus";
import type { AppEvent } from "@/lib/events/types";
import type { DatabaseEngine } from "@/lib/database/production";
import { createDatabaseRecord } from "@/lib/database/types";
import type { DatabaseRecord } from "@/lib/database/types";
import { WorkerEngine } from "./production";
import { WorkerManager } from "./manager";
import { WorkerRegistry } from "./registry";
import { createQueueItem, createWorkerQueue } from "./queue";
import type {
  CreateWorkerTaskInput,
  WorkerConfiguration,
  WorkerLease,
  WorkerSnapshot,
} from "./types";
import { createWorkerSnapshot } from "./types";

/** The default record id the worker snapshot is persisted under. */
export const WORKER_SNAPSHOT_RECORD_ID = "workers";

/** Options accepted by the {@link WorkerIntegration} constructor. */
export interface WorkerIntegrationOptions {
  /** The worker engine this integration drives (required). */
  readonly engine: WorkerEngine;
  /** The application event bus (optional; wired when provided). */
  readonly bus?: EventBus;
  /** The database engine used for persistence (optional). */
  readonly database?: DatabaseEngine;
  /** The persistence scope (default "app"). */
  readonly scope?: string;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
  /**
   * Map an application event to a worker task to enqueue (dependency
   * injection). Default: no event maps to a task.
   */
  readonly mapEventToTask?: (event: AppEvent, now: string) => CreateWorkerTaskInput | undefined;
}

/** The outcome of one integration run pass. */
export interface WorkerIntegrationRunResult {
  readonly summary: Awaited<ReturnType<WorkerEngine["runOnce"]>>;
  readonly persisted: boolean;
  readonly errors: readonly string[];
}

/**
 * Rebuild a `WorkerManager` from a persisted snapshot (restart recovery).
 * Queue items are reconstructed deterministically from task statuses.
 */
export function managerFromSnapshot(
  snapshot: WorkerSnapshot,
  configuration?: WorkerConfiguration,
): WorkerManager {
  const tasks = snapshot.tasks.map((task) => ({ ...task }));
  const createdAt = tasks[0]?.createdAt ?? "1970-01-01T00:00:00.000Z";
  let pendingQueue = createWorkerQueue("priority", { createdAt });
  let delayedQueue = createWorkerQueue("delayed", { createdAt });
  let retryQueue = createWorkerQueue("retry", { createdAt });
  for (const task of tasks) {
    const item = createQueueItem({
      id: `qitem-${task.id}`,
      taskId: task.id,
      kind:
        task.status === "retrying" ? "retry" : task.status === "scheduled" ? "delayed" : "priority",
      priority: task.priority,
      status:
        task.status === "retrying"
          ? "retrying"
          : task.status === "scheduled" || task.status === "delayed"
            ? "delayed"
            : "pending",
      enqueuedAt: task.createdAt,
      ...(task.scheduledAt !== undefined ? { dequeueAt: task.scheduledAt } : {}),
      attempt: task.attempts,
    });
    if (task.status === "retrying") {
      retryQueue = retryQueue.enqueue(item).queue;
    } else if (task.status === "scheduled" || task.status === "delayed") {
      delayedQueue = delayedQueue.enqueue(item).queue;
    } else if (task.status === "pending" || task.status === "leased" || task.status === "running") {
      pendingQueue = pendingQueue.enqueue(item).queue;
    }
  }
  return new WorkerManager({
    configuration,
    registry: new WorkerRegistry(snapshot.workers),
    pending: pendingQueue,
    delayed: delayedQueue,
    retry: retryQueue,
    tasks,
    leases: snapshot.leases.map((lease) => ({ ...lease })),
  });
}

/**
 * The application integration over a worker engine.
 */
export class WorkerIntegration {
  private engineRef: WorkerEngine;
  private busRef: EventBus | undefined;
  private readonly database: DatabaseEngine | undefined;
  private readonly scope: string;
  private readonly now: () => string;
  private readonly mapEventToTask: (
    event: AppEvent,
    now: string,
  ) => CreateWorkerTaskInput | undefined;
  private listenerId: string | undefined;
  private connected: boolean;

  constructor(options: WorkerIntegrationOptions) {
    this.engineRef = options.engine;
    this.busRef = options.bus;
    this.database = options.database;
    this.scope = options.scope ?? "app";
    this.now = options.now ?? (() => new Date().toISOString());
    this.mapEventToTask =
      options.mapEventToTask ?? (() => undefined);
    this.connected = false;
    if (this.busRef !== undefined) {
      this.connect();
    }
  }

  /** The current engine (replaced by {@link recover}). */
  engine(): WorkerEngine {
    return this.engineRef;
  }

  /** Whether the event bridge is connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** The current (successor) bus reference. */
  currentBus(): EventBus | undefined {
    return this.busRef;
  }

  /**
   * Subscribe the event bridge. Idempotent; the bridge enqueues a mapped
   * task per event (the mapping is application-provided).
   */
  connect(): void {
    if (this.connected || this.busRef === undefined) return;
    const { bus, id } = this.busRef.subscribe("job.completed", (event) => this.handleEvent(event));
    this.busRef = bus;
    this.listenerId = id;
    this.connected = true;
  }

  /** Remove the event bridge subscription. */
  disconnect(): void {
    if (!this.connected || this.busRef === undefined || this.listenerId === undefined) return;
    this.busRef = this.busRef.unsubscribe(this.listenerId);
    this.listenerId = undefined;
    this.connected = false;
  }

  /** Internal listener: enqueue the mapped task (isolated, never throws). */
  private async handleEvent(event: AppEvent): Promise<void> {
    if (!this.connected) return;
    try {
      const input = this.mapEventToTask(event, event.now);
      if (input === undefined) return;
      this.engineRef.enqueueTask(input, event.now);
    } catch {
      // Isolated: a mapping/enqueue failure never breaks the bus.
    }
  }

  /** Enqueue a mapped task for `event` directly (used by tests). */
  enqueueForEvent(event: AppEvent): CreateWorkerTaskInput | undefined {
    const input = this.mapEventToTask(event, event.now);
    if (input === undefined) return undefined;
    this.engineRef.enqueueTask(input, event.now);
    return input;
  }

  /**
   * Run one pass through the engine and persist the resulting state.
   * Persistence failures are isolated into the result.
   */
  async run(now?: string): Promise<WorkerIntegrationRunResult> {
    const at = now ?? this.now();
    const summary = await this.engineRef.runOnce(at);
    const errors: string[] = [];
    let persisted = false;
    if (this.database !== undefined) {
      try {
        await this.persist(at);
        persisted = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    return { summary, persisted, errors };
  }

  /**
   * Persist the current worker manager snapshot through the database engine.
   */
  async persist(at?: string): Promise<void> {
    if (this.database === undefined) {
      throw new Error("No database engine wired to the worker integration");
    }
    const snapshot = this.engineRef.manager.snapshot(at ?? this.now());
    const record = createDatabaseRecord({
      recordId: WORKER_SNAPSHOT_RECORD_ID,
      scope: this.scope,
      collection: "metadata",
      data: snapshot,
      createdAt: at ?? this.now(),
      updatedAt: at ?? this.now(),
    });
    const repository = this.database.scoped(this.scope, "metadata");
    const existing = await repository.find(WORKER_SNAPSHOT_RECORD_ID);
    if (existing === undefined) {
      await repository.insert(record as DatabaseRecord<unknown>);
    } else {
      await repository.replace(record as DatabaseRecord<unknown>);
    }
  }

  /**
   * Restart recovery: rebuild a fresh manager from the persisted snapshot and
   * replace the integration's engine reference with a successor engine.
   * Returns `{ engine, recovered }`.
   */
  async recover(): Promise<{ engine: WorkerEngine; recovered: boolean }> {
    if (this.database === undefined) {
      return { engine: this.engineRef, recovered: false };
    }
    const repository = this.database.scoped(this.scope, "metadata");
    const record = await repository.find(WORKER_SNAPSHOT_RECORD_ID);
    if (record === undefined) {
      return { engine: this.engineRef, recovered: false };
    }
    const snapshot = record.data as WorkerSnapshot;
    const manager = managerFromSnapshot(snapshot, this.engineRef.manager.configuration);
    const rebuilt = new WorkerEngine({
      manager,
      executor: this.engineRef.executor,
      scheduler: this.engineRef.scheduler,
      supervisor: this.engineRef.supervisor,
      jobEngine: this.engineRef.jobEngine,
      workflowEngine: this.engineRef.workflowEngine,
      actionEngine: this.engineRef.actionEngine,
      digestEngine: this.engineRef.digestEngine,
      toolExecutor: this.engineRef.toolExecutor,
      now: this.now,
    });
    this.engineRef = rebuilt;
    return { engine: rebuilt, recovered: true };
  }

  /** Graceful shutdown: stop every worker (delegated to the engine). */
  shutdown(now?: string, reason = "shutdown") {
    return this.engineRef.shutdownWorkers(now ?? this.now(), reason);
  }

  /** Restart every stopped worker (delegated to the engine). */
  restart(now?: string) {
    return this.engineRef.restartWorkers(now ?? this.now());
  }
}

/**
 * Wire a `job.completed` → worker task bridge over `bus` and return the
 * successor bus plus the subscription id. The mapping is application-supplied
 * (dependency injection); the default maps nothing.
 */
export function wireWorkerEvents(
  bus: EventBus,
  engine: WorkerEngine,
  mapEventToTask: (event: AppEvent, now: string) => CreateWorkerTaskInput | undefined = () =>
    undefined,
): { bus: EventBus; connected: boolean } {
  const integration = new WorkerIntegration({ engine, bus, mapEventToTask });
  return { bus: integration.currentBus() as EventBus, connected: integration.isConnected() };
}

/** Build a fresh worker integration. */
export function createProductionWorkerIntegration(
  options: WorkerIntegrationOptions,
): WorkerIntegration {
  return new WorkerIntegration(options);
}

/** Snapshot helper for tests and diagnostics. */
export function snapshotAt(engine: WorkerEngine, at: string): WorkerSnapshot {
  return createWorkerSnapshot({
    at,
    workers: engine.listWorkers(),
    tasks: engine.listTasks(),
    pools: engine.manager.pools(),
    leases: engine.manager.listLeases(),
    statistics: engine.manager.statistics(),
  });
}

/** Re-exported lease type for convenience. */
export type { WorkerLease };
