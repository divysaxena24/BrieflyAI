/**
 * Background Worker Infrastructure — health and metrics (Phase 6B STEP 12).
 *
 * Pure, deterministic computations over worker manager state. Everything is
 * derived — no timers, no collectors, no global state. Callers supply `now`;
 * every report, metric and snapshot is immutable.
 *
 * Complexity: all functions are O(n) over the manager's executions/workers.
 */

import type { WorkerManager } from "./manager";
import { aggregateHealth, detectDeadWorkers } from "./supervisor";
import {
  createWorkerMetrics,
  createWorkerReport,
  createWorkerStatistics,
  createWorkerSummary,
  type WorkerExecution,
  type WorkerMetrics,
  type WorkerReport,
  type WorkerStatistics,
} from "./types";
import type { WorkerHealthAggregation } from "./supervisor";

/** Aggregated queue depth. */
export interface QueueDepthReport {
  readonly pending: number;
  readonly delayed: number;
  readonly retry: number;
  readonly deadLetter: number;
  readonly total: number;
}

/** A pool-level metrics report. */
export interface PoolMetricsReport {
  readonly metrics: WorkerMetrics;
  readonly utilization: number;
  readonly successRate: number;
  readonly failureRate: number;
  readonly retryRate: number;
  readonly throughputPerMinute: number;
  readonly averageLatencyMs: number;
}

/** A full health report over every worker. */
export interface HealthReport {
  readonly at: string;
  readonly reports: readonly WorkerReport[];
  readonly aggregate: WorkerHealthAggregation;
  readonly dead: readonly string[];
}

/** Executions relevant to a worker (or all when `workerId` is omitted). */
function executionsFor(
  manager: WorkerManager,
  workerId?: string,
): readonly WorkerExecution[] {
  return manager
    .listExecutions()
    .filter((execution) => workerId === undefined || execution.workerId === workerId);
}

/**
 * Compute the raw metrics of a worker (or the whole pool when `workerId` is
 * omitted): completed/failed/cancelled counts, total runs, total duration and
 * the current queue depth.
 */
export function computeWorkerMetrics(
  manager: WorkerManager,
  workerId?: string,
): WorkerMetrics {
  const executions = executionsFor(manager, workerId);
  const completed = executions.filter((execution) => execution.status === "completed").length;
  const failed = executions.filter((execution) => execution.status === "failed").length;
  const cancelled = executions.filter((execution) => execution.status === "cancelled").length;
  const retried = executions.filter(
    (execution) =>
      execution.status === "failed" &&
      manager.findTask(execution.taskId)?.status === "retrying",
  ).length;
  const totalDurationMs = executions.reduce(
    (total, execution) => total + (execution.durationMs ?? 0),
    0,
  );
  return createWorkerMetrics({
    tasksCompleted: completed,
    tasksFailed: failed,
    tasksCancelled: cancelled,
    tasksRetried: retried,
    totalRuns: executions.length,
    totalDurationMs,
    queueDepth: manager.queueStatistics(manager.pending.createdAt).pending.due,
  });
}

/** Queue depth across every queue. */
export function computeQueueDepth(manager: WorkerManager, now: string): QueueDepthReport {
  const stats = manager.queueStatistics(now);
  return Object.freeze({
    pending: stats.pending.total,
    delayed: stats.delayed.total,
    retry: stats.retry.total,
    deadLetter: manager.deadLetter.count(),
    total: stats.pending.total + stats.delayed.total + stats.retry.total + manager.deadLetter.count(),
  });
}

/** Average wall-clock duration of settled executions, in milliseconds. */
export function averageLatencyMs(executions: readonly WorkerExecution[]): number {
  const settled = executions.filter((execution) => execution.durationMs !== undefined);
  if (settled.length === 0) return 0;
  const total = settled.reduce((sum, execution) => sum + (execution.durationMs ?? 0), 0);
  return total / settled.length;
}

/** Completed executions whose `finishedAt` falls within the window at `now`. */
export function throughputPerWindow(
  executions: readonly WorkerExecution[],
  now: string,
  windowMs: number,
): number {
  const cutoff = Date.parse(now) - windowMs;
  return executions.filter(
    (execution) =>
      execution.status === "completed" &&
      execution.finishedAt !== undefined &&
      Date.parse(execution.finishedAt) >= cutoff,
  ).length;
}

/** Pool utilization: busy slots ÷ total capacity (0 when no capacity). */
export function utilization(manager: WorkerManager): number {
  const total = manager.registry.totalCapacity();
  if (total === 0) return 0;
  return manager.registry.busySlots() / total;
}

/** Heartbeat latency of a worker (ms since the last heartbeat). */
export function heartbeatLatencyMs(worker: { lastHeartbeatAt?: string }, now: string): number {
  if (worker.lastHeartbeatAt === undefined) return 0;
  return Math.max(0, Date.parse(now) - Date.parse(worker.lastHeartbeatAt));
}

/** Success rate of settled executions (0 when none). */
export function successRate(metrics: WorkerMetrics): number {
  const settled = metrics.tasksCompleted + metrics.tasksFailed + metrics.tasksCancelled;
  if (settled === 0) return 0;
  return metrics.tasksCompleted / settled;
}

/** Failure rate of settled executions (0 when none). */
export function failureRate(metrics: WorkerMetrics): number {
  const settled = metrics.tasksCompleted + metrics.tasksFailed + metrics.tasksCancelled;
  if (settled === 0) return 0;
  return metrics.tasksFailed / settled;
}

/** Retry rate: retried attempts ÷ total runs (0 when none). */
export function retryRate(metrics: WorkerMetrics): number {
  if (metrics.totalRuns === 0) return 0;
  return metrics.tasksRetried / metrics.totalRuns;
}

/** A full pool metrics report at `now`. */
export function computePoolMetrics(manager: WorkerManager, now: string): PoolMetricsReport {
  const metrics = computeWorkerMetrics(manager);
  const executions = executionsFor(manager);
  const throughput = throughputPerWindow(executions, now, 60_000);
  return Object.freeze({
    metrics,
    utilization: utilization(manager),
    successRate: successRate(metrics),
    failureRate: failureRate(metrics),
    retryRate: retryRate(metrics),
    throughputPerMinute: throughput,
    averageLatencyMs: averageLatencyMs(executions),
  });
}

/** Build a deterministic report for one worker. */
export function buildWorkerReport(
  manager: WorkerManager,
  workerId: string,
  now: string,
): WorkerReport | undefined {
  const worker = manager.find(workerId);
  if (worker === undefined) return undefined;
  return createWorkerReport({
    workerId,
    at: now,
    health: worker.health,
    metrics: computeWorkerMetrics(manager, workerId),
    summary: createWorkerSummary(worker),
  });
}

/** A full health report over every registered worker at `now`. */
export function buildHealthReport(manager: WorkerManager, now: string): HealthReport {
  const workers = manager.listWorkers();
  return Object.freeze({
    at: now,
    reports: Object.freeze(
      workers.map((worker) => {
        const report = buildWorkerReport(manager, worker.id, now);
        return report as WorkerReport;
      }),
    ),
    aggregate: aggregateHealth(workers, now),
    dead: Object.freeze(detectDeadWorkers(workers, now).map((worker) => worker.id)),
  });
}

/** Deterministic statistics (delegates to the manager). */
export function computeStatistics(manager: WorkerManager): WorkerStatistics {
  return manager.statistics();
}

/** Alias of the statistics computation (immutable). */
export function statisticsSnapshot(manager: WorkerManager): WorkerStatistics {
  const stats = manager.statistics();
  return createWorkerStatistics({
    workers: stats.workers,
    tasks: stats.tasks,
    leases: stats.leases,
  });
}
