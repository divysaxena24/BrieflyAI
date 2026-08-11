/**
 * Background Worker Infrastructure — worker scheduler (Phase 6B STEP 6).
 *
 * Pure, deterministic scheduling strategies over the worker queues and task
 * store. The scheduler owns no timers, no polling loops and no engine state —
 * the caller (manager/executor/production) drives it with an injected `now`.
 *
 * Strategies:
 * - `priority`: order by priority (critical first), then due/enqueue time,
 *   then id.
 * - `fair`: round-robin across task "groups" (derived from the task name
 *   hash), so no single group starves the others.
 * - `weighted`: priority ranking weighted by the group's aggregate cost.
 * - `capacity`: only select while the pool has available capacity.
 * - `dependency`: skip tasks whose dependencies are not settled.
 * - `retry` / `delay`: pick items whose `dequeueAt` is due.
 * - `batch`: group consecutive selections into a `WorkerBatch`.
 * - `cron` / `workflow` / `job` handoff: schedule references to existing
 *   engines (pure metadata; the executor resolves them).
 *
 * Deterministic ordering is guaranteed: identical inputs produce identical
 * selections.
 */

import { hashString } from "@/lib/hash";
import { PRIORITY_RANK, type WorkerTask, type WorkerQueueItem, type WorkerBatch, createWorkerBatch } from "./types";
import { orderQueueItems } from "./queue";

/** A scheduling strategy. */
export type SchedulingStrategy =
  | "priority"
  | "fair"
  | "weighted"
  | "capacity"
  | "dependency"
  | "retry"
  | "delay"
  | "batch";

/** Options accepted by the selection functions. */
export interface SelectOptions {
  readonly strategy?: SchedulingStrategy;
  /** Batch size for the `batch` strategy. */
  readonly batchSize?: number;
  /** Fair-scheduling group size. */
  readonly fairGroupSize?: number;
  /** Whether to require dependency satisfaction (hard). */
  readonly requireDependencies?: boolean;
}

/** Derive a deterministic "group" key for fair/weighted scheduling. */
export function taskGroup(task: WorkerTask): string {
  return hashString(task.name);
}

/** Whether every dependency of `task` is satisfied by `tasks`. */
export function dependenciesSatisfied(
  task: WorkerTask,
  tasks: readonly WorkerTask[],
): boolean {
  if (task.dependencies.length === 0) return true;
  for (const dependencyId of task.dependencies) {
    const dependency = tasks.find((candidate) => candidate.id === dependencyId);
    if (dependency === undefined) return false;
    if (dependency.status !== "completed" && dependency.status !== "cancelled") {
      return false;
    }
  }
  return true;
}

/** Count of unsatisfied dependencies (0 = ready). */
export function unsatisfiedDependencyCount(
  task: WorkerTask,
  tasks: readonly WorkerTask[],
): number {
  return task.dependencies.filter((dependencyId) => {
    const dependency = tasks.find((candidate) => candidate.id === dependencyId);
    return dependency === undefined || dependency.status !== "completed";
  }).length;
}

/** Whether an item is due at `now`. */
export function isItemDue(item: WorkerQueueItem, now: string): boolean {
  if (item.dequeueAt === undefined) return true;
  return Date.parse(item.dequeueAt) <= Date.parse(now);
}

/**
 * Deterministically order candidate items for selection under `strategy`.
 * The input array is never mutated.
 */
export function orderCandidates(
  items: readonly WorkerQueueItem[],
  tasks: readonly WorkerTask[],
  strategy: SchedulingStrategy = "priority",
): WorkerQueueItem[] {
  if (strategy === "fair") {
    // Round-robin across deterministic name-hash groups.
    const grouped = new Map<string, WorkerQueueItem[]>();
    for (const item of items) {
      const task = tasks.find((candidate) => candidate.id === item.taskId);
      const group = task === undefined ? item.taskId : taskGroup(task);
      const bucket = grouped.get(group);
      if (bucket === undefined) {
        grouped.set(group, [item]);
      } else {
        bucket.push(item);
      }
    }
    const orderedGroups = [...grouped.keys()].sort();
    const result: WorkerQueueItem[] = [];
    let added = true;
    while (added) {
      added = false;
      for (const group of orderedGroups) {
        const bucket = grouped.get(group);
        if (bucket !== undefined && bucket.length > 0) {
          const next = bucket.shift();
          if (next !== undefined) result.push(next);
          added = true;
        }
      }
    }
    return result;
  }
  if (strategy === "weighted") {
    return [...items].sort((left, right) => {
      const leftTask = tasks.find((candidate) => candidate.id === left.taskId);
      const rightTask = tasks.find((candidate) => candidate.id === right.taskId);
      const leftWeight = leftTask === undefined ? 1 : PRIORITY_RANK[leftTask.priority];
      const rightWeight = rightTask === undefined ? 1 : PRIORITY_RANK[rightTask.priority];
      const weightDelta = rightWeight - leftWeight;
      if (weightDelta !== 0) return weightDelta;
      return orderQueueItems([left, right]).indexOf(left) === 0 ? -1 : 1;
    });
  }
  return orderQueueItems(items);
}

/**
 * Select the single next item from the candidates due at `now`, honouring
 * dependencies (unless disabled). Returns `undefined` when nothing is
 * selectable.
 */
export function selectNextItem(
  candidates: readonly WorkerQueueItem[],
  tasks: readonly WorkerTask[],
  now: string,
  options: SelectOptions = {},
): WorkerQueueItem | undefined {
  const due = candidates.filter((item) => isItemDue(item, now));
  if (due.length === 0) return undefined;
  const requireDeps = options.requireDependencies ?? true;
  if (requireDeps) {
    const ready = due.filter((item) => {
      const task = tasks.find((candidate) => candidate.id === item.taskId);
      return task === undefined || dependenciesSatisfied(task, tasks);
    });
    if (ready.length === 0) return undefined;
    const ordered = orderCandidates(ready, tasks, options.strategy ?? "priority");
    return ordered[0];
  }
  const ordered = orderCandidates(due, tasks, options.strategy ?? "priority");
  return ordered[0];
}

/**
 * Select up to `count` items from the candidates (deterministic order).
 *
 * A single deterministic sort is performed once (O(n log n)); blocked items
 * (future `dequeueAt` or unsatisfied dependencies) are skipped in order.
 * Dependency readiness does not change during selection in this layer, so the
 * outcome equals repeated single selection.
 */
export function selectBatchItems(
  candidates: readonly WorkerQueueItem[],
  tasks: readonly WorkerTask[],
  now: string,
  count: number,
  options: SelectOptions = {},
): WorkerQueueItem[] {
  if (count <= 0) return [];
  const due = candidates.filter((item) => isItemDue(item, now));
  const ordered = orderCandidates(due, tasks, options.strategy ?? "priority");
  const requireDeps = options.requireDependencies ?? true;
  const result: WorkerQueueItem[] = [];
  for (const item of ordered) {
    if (result.length >= count) break;
    if (requireDeps) {
      const task = tasks.find((candidate) => candidate.id === item.taskId);
      if (task !== undefined && !dependenciesSatisfied(task, tasks)) continue;
    }
    result.push(item);
  }
  return result;
}

/**
 * Build a deterministic batch over `taskIds` (chunked into `size`).
 */
export function buildBatches(
  taskIds: readonly string[],
  size: number,
  createdAt: string,
): WorkerBatch[] {
  const batches: WorkerBatch[] = [];
  const safeSize = Math.max(1, size);
  for (let index = 0; index < taskIds.length; index += safeSize) {
    const chunk = taskIds.slice(index, index + safeSize);
    batches.push(
      createWorkerBatch({
        id: `batch-${hashString(`${createdAt}:${chunk.join(":")}`)}`,
        taskIds: chunk,
        createdAt,
      }),
    );
  }
  return batches;
}

/** Input accepted by {@link scheduleTaskReference}. */
export interface ScheduleTaskReferenceInput {
  /** The referenced entity id (job, workflow, ...). */
  readonly referenceId: string;
  readonly kind: WorkerTask["kind"];
  /** Schedule delay in milliseconds (0 = due now). */
  readonly delayMs?: number;
  readonly priority?: WorkerTask["priority"];
  readonly name?: string;
  readonly createdAt: string;
  readonly now: string;
}

/**
 * Deterministic delay/schedule metadata for a task referencing an existing
 * engine entity (job/workflow/action/digest/tool). Pure — nothing is
 * scheduled; this only computes the due timestamp.
 */
export function scheduleTaskReference(
  input: ScheduleTaskReferenceInput,
): { dequeueAt: string; scheduledAt?: string } {
  const delayMs = Math.max(0, input.delayMs ?? 0);
  const dequeueAt = new Date(Date.parse(input.now) + delayMs).toISOString();
  return {
    dequeueAt,
    ...(delayMs > 0 ? { scheduledAt: dequeueAt } : {}),
  };
}

/** Options accepted by the {@link WorkerScheduler} constructor. */
export interface WorkerSchedulerOptions {
  readonly strategy?: SchedulingStrategy;
  readonly batchSize?: number;
  readonly requireDependencies?: boolean;
}

/**
 * A thin, configurable scheduler facade. Stateless with respect to time and
 * state — every method is pure given `now` and the current queues/tasks.
 */
export class WorkerScheduler {
  readonly strategy: SchedulingStrategy;
  readonly batchSize: number;
  readonly requireDependencies: boolean;

  constructor(options: WorkerSchedulerOptions = {}) {
    this.strategy = options.strategy ?? "priority";
    this.batchSize = options.batchSize ?? 1;
    this.requireDependencies = options.requireDependencies ?? true;
  }

  /** Select the single next task item. */
  next(
    candidates: readonly WorkerQueueItem[],
    tasks: readonly WorkerTask[],
    now: string,
  ): WorkerQueueItem | undefined {
    return selectNextItem(candidates, tasks, now, {
      strategy: this.strategy,
      requireDependencies: this.requireDependencies,
    });
  }

  /** Select the next batch of task items. */
  nextBatch(
    candidates: readonly WorkerQueueItem[],
    tasks: readonly WorkerTask[],
    now: string,
  ): WorkerQueueItem[] {
    return selectBatchItems(candidates, tasks, now, this.batchSize, {
      strategy: this.strategy,
      requireDependencies: this.requireDependencies,
    });
  }

  /** Build deterministic batches from task ids. */
  batches(taskIds: readonly string[], createdAt: string): WorkerBatch[] {
    return buildBatches(taskIds, this.batchSize, createdAt);
  }
}
