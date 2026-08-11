/**
 * Background Worker Infrastructure — worker supervisor (Phase 6B STEP 8).
 *
 * Monitoring and automatic recovery over the worker manager:
 *
 * - **Heartbeat monitoring**: workers whose heartbeat is stale at `now` are
 *   detected as dead.
 * - **Restart limits**: a dead worker is restarted while its `restartCount`
 *   is below the configured `maxRestarts`; beyond that (or beyond the
 *   consecutive-failure escalation threshold) it is escalated (stopped).
 * - **Automatic recovery**: restarted workers get their failures reset and a
 *   `recovered` record is emitted.
 * - **Capacity monitoring / health aggregation**: deterministic reports over
 *   the current manager state.
 *
 * Everything is pure given the manager and `now`; the supervisor applies
 * transitions through the manager's successor API (the receiver manager is
 * never mutated).
 */

import type { WorkerManager } from "./manager";
import {
  isWorkerHealthy,
  type Worker,
  type WorkerHealthStatus,
  type WorkerRecovery,
} from "./types";
import { createWorkerRecovery } from "./types";

/** Options accepted by the {@link WorkerSupervisor} constructor. */
export interface WorkerSupervisorOptions {
  /** Maximum automatic restarts per worker before escalation. */
  readonly maxRestarts?: number;
  /** Consecutive failures beyond which a worker is escalated. */
  readonly escalationThreshold?: number;
  /** Supervisor run interval in milliseconds (metadata only). */
  readonly intervalMs?: number;
}

/** A supervisor report (deterministic given inputs). */
export interface WorkerSupervisorReport {
  readonly at: string;
  /** Workers examined. */
  readonly checked: number;
  /** Workers detected dead (stale heartbeat). */
  readonly dead: readonly string[];
  /** Recovery actions taken (restarts). */
  readonly restarted: readonly WorkerRecovery[];
  /** Recovery actions taken (escalations). */
  readonly escalated: readonly WorkerRecovery[];
  /** Workers found healthy again after a previous failure. */
  readonly recovered: readonly WorkerRecovery[];
  /** Aggregate health of the pool. */
  readonly health: WorkerHealthAggregation;
}

/** Aggregate health of a pool. */
export interface WorkerHealthAggregation {
  readonly healthy: number;
  readonly degraded: number;
  readonly unhealthy: number;
  readonly unknown: number;
  readonly total: number;
}

/** Build a deterministic recovery record. */
export function createWorkerRecoveryRecord(
  workerId: string,
  at: string,
  restartCount: number,
  action: WorkerRecovery["action"],
): WorkerRecovery {
  return createWorkerRecovery({ workerId, at, restartCount, action });
}

/**
 * Detect workers whose heartbeat is stale at `now` (dead worker detection).
 * Workers without a heartbeat record are considered alive (just started).
 */
export function detectDeadWorkers(workers: readonly Worker[], now: string): Worker[] {
  return workers.filter(
    (worker) =>
      worker.lastHeartbeatAt !== undefined && !isWorkerHealthy(worker, now),
  );
}

/**
 * Aggregate the health of a pool at `now` (deterministic counts).
 */
export function aggregateHealth(
  workers: readonly Worker[],
  now: string,
): WorkerHealthAggregation {
  let healthy = 0;
  let degraded = 0;
  let unhealthy = 0;
  let unknown = 0;
  for (const worker of workers) {
    if (!isWorkerHealthy(worker, now)) {
      unhealthy += 1;
    } else {
      switch (worker.health.status) {
        case "healthy":
          healthy += 1;
          break;
        case "degraded":
          degraded += 1;
          break;
        case "unhealthy":
          unhealthy += 1;
          break;
        default:
          unknown += 1;
      }
    }
  }
  return { healthy, degraded, unhealthy, unknown, total: workers.length };
}

/**
 * The supervisor: applies recovery transitions through a worker manager.
 */
export class WorkerSupervisor {
  readonly maxRestarts: number;
  readonly escalationThreshold: number;
  readonly intervalMs: number;

  constructor(options: WorkerSupervisorOptions = {}) {
    this.maxRestarts = options.maxRestarts ?? 3;
    this.escalationThreshold = options.escalationThreshold ?? 5;
    this.intervalMs = options.intervalMs ?? 15_000;
  }

  /**
   * Run one supervision pass over `manager` at `now`. Returns the successor
   * manager plus the deterministic report. Never throws.
   */
  supervise(
    manager: WorkerManager,
    now: string,
  ): { manager: WorkerManager; report: WorkerSupervisorReport } {
    const workers = manager.listWorkers();
    const dead = detectDeadWorkers(workers, now);
    const deadIds = new Set(dead.map((worker) => worker.id));
    let current: WorkerManager = manager;
    const restarted: WorkerRecovery[] = [];
    const escalated: WorkerRecovery[] = [];
    const recovered: WorkerRecovery[] = [];

    for (const worker of workers) {
      if (deadIds.has(worker.id)) {
        if (
          worker.restartCount < this.maxRestarts &&
          worker.failures < this.escalationThreshold
        ) {
          const { manager: next, worker: restartedWorker } = current.restartWorker(
            worker.id,
            now,
          );
          current = next;
          restarted.push(
            createWorkerRecoveryRecord(
              worker.id,
              now,
              restartedWorker.restartCount,
              "restarted",
            ),
          );
        } else {
          const { manager: next } = current.stopWorker(worker.id, now, "escalated");
          current = next;
          escalated.push(
            createWorkerRecoveryRecord(worker.id, now, worker.restartCount, "escalated"),
          );
        }
      } else if (worker.failures > 0) {
        recovered.push(
          createWorkerRecoveryRecord(worker.id, now, worker.restartCount, "restarted"),
        );
      }
    }

    const report: WorkerSupervisorReport = {
      at: now,
      checked: workers.length,
      dead: Object.freeze([...deadIds]),
      restarted: Object.freeze(restarted),
      escalated: Object.freeze(escalated),
      recovered: Object.freeze(recovered),
      health: aggregateHealth(current.listWorkers(), now),
    };
    return { manager: current, report };
  }
}

/** Build a supervisor with default options. */
export function createWorkerSupervisor(
  options: WorkerSupervisorOptions = {},
): WorkerSupervisor {
  return new WorkerSupervisor(options);
}

/** Re-export the health aggregation type for convenience. */
export type { WorkerHealthStatus };
