/**
 * Background Worker Infrastructure — worker registry (Phase 6B STEP 4).
 *
 * An immutable collection of workers. Every mutation returns a successor
 * registry; every read returns detached clones. Capacity calculations and
 * statistics are pure derivations over the stored workers.
 *
 * Complexity: `register`/`replace`/`update`/`remove`/`clear` are O(n);
 * list-style reads are O(n); `find` is O(n).
 */

import {
  createWorkerStatistics,
  isWorkerAvailable,
  isWorkerHealthy,
  touchWorker,
  type CreateWorkerInput,
  type Worker,
  type WorkerPatch,
  type WorkerPriority,
  type WorkerStatus,
  type WorkerSummary,
} from "./types";
import { cloneWorker, createWorker, createWorkerSummary, freezeWorker } from "./types";

/** Raised when registering a worker whose id is already stored. */
export class WorkerDuplicateError extends Error {
  constructor(workerId: string) {
    super(`Worker already registered: ${workerId}`);
    this.name = "WorkerDuplicateError";
  }
}

/** Raised when mutating an unknown worker id. */
export class WorkerNotFoundError extends Error {
  constructor(workerId: string) {
    super(`Worker not found: ${workerId}`);
    this.name = "WorkerNotFoundError";
  }
}

/** Immutable worker registry (successor pattern). */
export class WorkerRegistry {
  /** The stored workers (frozen array of frozen workers). */
  readonly workers: readonly Worker[];

  constructor(workers: readonly Worker[] = []) {
    // Workers are frozen in place (the manager always passes detached
    // successors built by `touchWorker`/`createWorker`); reads re-clone via
    // `find`/`list`, so no defensive copy is needed here — avoiding O(n)
    // deep clones on every successor construction.
    this.workers = Object.freeze(workers.map((worker) => freezeWorker(worker)));
  }

  /** Build a successor registry over `workers`. */
  private next(workers: readonly Worker[]): WorkerRegistry {
    return new WorkerRegistry(workers);
  }

  /** Number of registered workers. */
  count(): number {
    return this.workers.length;
  }

  /** The stored worker with `workerId`, or `undefined` (detached clone). */
  find(workerId: string): Worker | undefined {
    const worker = this.workers.find((entry) => entry.id === workerId);
    return worker === undefined ? undefined : cloneWorker(worker);
  }

  /** Whether a worker with `workerId` is stored. */
  has(workerId: string): boolean {
    return this.workers.some((worker) => worker.id === workerId);
  }

  /** Return a successor registry with `worker` stored. */
  register(worker: Worker): { registry: WorkerRegistry; worker: Worker } {
    if (this.has(worker.id)) {
      throw new WorkerDuplicateError(worker.id);
    }
    return { registry: this.next([...this.workers, worker]), worker: cloneWorker(worker) };
  }

  /** Register from a create-input (convenience). */
  registerInput(input: CreateWorkerInput): { registry: WorkerRegistry; worker: Worker } {
    return this.register(createWorker(input));
  }

  /** Return a successor registry with `worker` replacing the same id. */
  replace(worker: Worker): { registry: WorkerRegistry; worker: Worker } {
    if (!this.has(worker.id)) {
      throw new WorkerNotFoundError(worker.id);
    }
    return {
      registry: this.next(this.workers.map((entry) => (entry.id === worker.id ? worker : entry))),
      worker: cloneWorker(worker),
    };
  }

  /**
   * Return a successor registry with the worker's fields patched via
   * {@link touchWorker} (the receiver is never mutated).
   */
  update(
    workerId: string,
    patch: WorkerPatch,
  ): { registry: WorkerRegistry; worker: Worker } {
    const current = this.require(workerId);
    const updated = touchWorker(current, patch);
    return {
      registry: this.next(this.workers.map((entry) => (entry.id === workerId ? updated : entry))),
      worker: cloneWorker(updated),
    };
  }

  /** Return a successor registry without the worker `workerId`. */
  remove(workerId: string): WorkerRegistry {
    if (!this.has(workerId)) {
      throw new WorkerNotFoundError(workerId);
    }
    return this.next(this.workers.filter((worker) => worker.id !== workerId));
  }

  /** Return an empty successor registry. */
  clear(): WorkerRegistry {
    return new WorkerRegistry();
  }

  /** Detached clones of every worker, in registration order. */
  list(): Worker[] {
    return this.workers.map((worker) => cloneWorker(worker));
  }

  /** Workers whose heartbeat is fresh at `now`. */
  listHealthy(now: string): Worker[] {
    return this.list().filter((worker) => isWorkerHealthy(worker, now));
  }

  /** Workers currently running a task (state `busy`). */
  listBusy(): Worker[] {
    return this.list().filter((worker) => worker.state === "busy");
  }

  /** Workers currently available to run a task at `now`. */
  listIdle(now: string): Worker[] {
    return this.list().filter((worker) => isWorkerAvailable(worker, now));
  }

  /** Workers carrying every capability in `capabilities`. */
  findByCapability(capabilities: readonly string[]): Worker[] {
    return this.list().filter((worker) =>
      capabilities.every((capability) => worker.capabilities.includes(capability)),
    );
  }

  /** Workers registered into `pool`. */
  findByPool(pool: string): Worker[] {
    return this.list().filter((worker) => worker.pool === pool);
  }

  /** Workers whose status is one of `statuses`. */
  findByStatus(statuses: readonly WorkerStatus[]): Worker[] {
    return this.list().filter((worker) => statuses.includes(worker.status));
  }

  /** Workers whose priority is one of `priorities`. */
  findByPriority(priorities: readonly WorkerPriority[]): Worker[] {
    return this.list().filter((worker) => priorities.includes(worker.priority));
  }

  /** Lightweight summaries of every worker, in registration order. */
  summaries(): WorkerSummary[] {
    return this.workers.map((worker) => createWorkerSummary(worker));
  }

  /** Total capacity (sum of `estimateWorkerCost`). */
  totalCapacity(): number {
    return this.workers.reduce(
      (total, worker) => total + worker.capacity.maxConcurrent * worker.capacity.weight,
      0,
    );
  }

  /** Total currently-busy slots. */
  busySlots(): number {
    return this.workers.reduce((total, worker) => total + worker.capacity.busy, 0);
  }

  /** Available capacity at `now` (healthy idle workers' free slots). */
  availableCapacity(now: string): number {
    return this.listIdle(now).reduce(
      (total, worker) => total + Math.max(0, worker.capacity.maxConcurrent - worker.capacity.busy),
      0,
    );
  }

  /** Deterministic aggregated statistics over the stored workers. */
  statistics(): ReturnType<typeof createWorkerStatistics> {
    const workers = this.workers;
    const states = new Map<string, number>();
    for (const worker of workers) {
      const key = worker.status;
      states.set(key, (states.get(key) ?? 0) + 1);
    }
    return createWorkerStatistics({
      workers: {
        registered: states.get("registered") ?? 0,
        active: (states.get("running") ?? 0) + (states.get("idle") ?? 0) + (states.get("busy") ?? 0),
        idle: states.get("idle") ?? 0,
        busy: states.get("busy") ?? 0,
        paused: states.get("paused") ?? 0,
        stopped: states.get("stopped") ?? 0,
        failed: states.get("failed") ?? 0,
        dead: states.get("removed") ?? 0,
      },
    });
  }

  /** Return a detached clone of the stored worker or throw. */
  private require(workerId: string): Worker {
    const worker = this.find(workerId);
    if (worker === undefined) {
      throw new WorkerNotFoundError(workerId);
    }
    return worker;
  }
}
