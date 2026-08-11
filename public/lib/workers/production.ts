/**
 * Background Worker Infrastructure — production composition (Phase 6B STEP 10).
 *
 * `WorkerEngine` is the composition root of the worker layer. It wires:
 *
 * ```text
 * WorkerManager (registry + queues + leases + dead letter)
 *   → WorkerScheduler   (deterministic selection)
 *   → WorkerExecutor    (built-in handlers over the production engines)
 *       → Job Engine     (job tasks → runManual)
 *       → Workflow Engine(workflow tasks → runWorkflow)
 *       → Action Engine  (action tasks → plan + execute)
 *       → Digest Engine  (digest tasks → morning/evening/weekly)
 *       → Tool Executor  (tool tasks → execute plan)
 *   → WorkerSupervisor  (heartbeat monitoring + restart/escalation)
 * ```
 *
 * - `createProductionWorkerEngine()` is a pure factory: it only wires the
 *   dependency graph (optionally seeded with injected engines); nothing runs
 *   during construction.
 * - `getProductionWorkerEngine()` returns the application's single engine
 *   instance (module-level singleton).
 * - `runWorkers()` / `shutdownWorkers()` / `restartWorkers()` / `workerStatus()`
 *   are the application entry points.
 *
 * No engine logic is reimplemented: every task kind delegates to the
 * existing production engine it references. Deterministic given `now` (when
 * the manager has no wall-clock dependency).
 */

import { getProductionActionEngine } from "@/lib/actions/production";
import type { ActionEngine } from "@/lib/actions/production";
import { getProductionDigestEngine, type DigestEngine } from "@/lib/digest/production";
import type { BuildDigestOptions } from "@/lib/digest/production";
import { getProductionJobEngine, type JobEngine } from "@/lib/jobs/production";
import { getProductionWorkflowEngine, type WorkflowEngine } from "@/lib/workflows/production";
import { ToolExecutor } from "@/lib/tools/executor";
import { createBuiltInReadTools } from "@/lib/tools/builtin";
import { ToolRegistry } from "@/lib/tools/registry";
import { createExecutionPlan, type ExecutionStep } from "@/lib/tools/plan";
import type { ExecutionResult } from "@/lib/tools/executor";
import { WorkerExecutor, WorkerTaskHandlerRegistry, type WorkerTaskHandler } from "./executor";
import { selectBatchItems } from "./scheduler";
import { WorkerManager } from "./manager";
import { WorkerScheduler } from "./scheduler";
import { createWorkerSupervisor, WorkerSupervisor, type WorkerSupervisorReport } from "./supervisor";
import { buildHealthReport, type HealthReport } from "./metrics";
import type { ActionType } from "@/lib/actions/types";
import type { PlanActionRequest } from "@/lib/actions/planner";
import type {
  CreateWorkerInput,
  CreateWorkerTaskInput,
  Worker,
  WorkerError,
  WorkerTask,
  WorkerTaskPayload,
} from "./types";

/** The aggregated outcome of one worker run pass. */
export interface WorkerRunSummaryShape {
  readonly at: string;
  readonly leased: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly restarted: number;
}

/** Options accepted by the {@link WorkerEngine} constructor. */
export interface WorkerEngineOptions {
  /** Initial worker manager (dependency injection); empty by default. */
  readonly manager?: WorkerManager;
  /** Executor (dependency injection); built from the handler registry. */
  readonly executor?: WorkerExecutor;
  /** Handler registry (dependency injection); built-ins added unless provided. */
  readonly handlerRegistry?: WorkerTaskHandlerRegistry;
  /** Scheduler (dependency injection); priority strategy by default. */
  readonly scheduler?: WorkerScheduler;
  /** Supervisor (dependency injection); defaults applied. */
  readonly supervisor?: WorkerSupervisor;
  /** Job Engine reused by `"job"` tasks (production singleton). */
  readonly jobEngine?: JobEngine;
  /** Workflow Engine reused by `"workflow"` tasks (production singleton). */
  readonly workflowEngine?: WorkflowEngine;
  /** Action Engine reused by `"action"` tasks (production singleton). */
  readonly actionEngine?: ActionEngine;
  /** Digest Engine reused by `"digest"` tasks (production singleton). */
  readonly digestEngine?: DigestEngine;
  /** Tool Executor reused by `"tool"` tasks (built-in read tools). */
  readonly toolExecutor?: ToolExecutor;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
  /** Injected millisecond clock for execution durations; defaults to `Date.now`. */
  readonly clockMs?: () => number;
}

/** Validate a non-empty string field of a task payload. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Worker task payload field "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Narrow a worker task payload to the member matching `kind`.
 *
 * `WorkerTaskPayload` is a discriminated union on `kind`; every built-in
 * handler is registered for exactly one kind, so a mismatch is a task
 * authoring error and surfaces as a structured handler failure.
 */
function requirePayloadKind<K extends WorkerTaskPayload["kind"]>(
  payload: WorkerTaskPayload,
  kind: K,
): Extract<WorkerTaskPayload, { readonly kind: K }> {
  if (payload.kind !== kind) {
    throw new Error(`Worker task payload kind "${payload.kind}" does not match handler "${kind}"`);
  }
  // The runtime check narrows the discriminated union; the generic return
  // needs an explicit cast because TS cannot distribute over `kind: K`.
  return payload as Extract<WorkerTaskPayload, { readonly kind: K }>;
}

/** Validate a string-array field of a task payload. */
function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Worker task payload field "${field}" must be an array`);
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`Worker task payload field "${field}" must contain only strings`);
    }
  }
  return value as readonly string[];
}

/** Validate an object field of a task payload. */
function requireObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Worker task payload field "${field}" must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Convert an untrusted worker-payload request entry into a typed
 * `PlanActionRequest`. The entry must be an object carrying a non-empty
 * `type` string; optional `input`/`priority`/`name` fields are forwarded.
 * Unknown type strings are legal — the planner degrades them through its
 * `default` enrichment branch rather than throwing.
 */
function toActionRequest(value: unknown): PlanActionRequest {
  const record = requireObject(value, "requests[]");
  const type = record.type;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error(`Worker task payload field "requests[].type" must be a non-empty string`);
  }
  let request: PlanActionRequest = { type: type as ActionType };
  if (record.input !== undefined) {
    request = { ...request, input: requireObject(record.input, "requests[].input") };
  }
  if (record.priority !== undefined) {
    const priority = record.priority;
    if (
      priority !== "low" &&
      priority !== "normal" &&
      priority !== "high" &&
      priority !== "critical"
    ) {
      throw new Error(`Worker task payload field "requests[].priority" is invalid`);
    }
    request = { ...request, priority };
  }
  if (record.name !== undefined) {
    request = { ...request, name: requireString(record.name, "requests[].name") };
  }
  return request;
}

/**
 * The worker engine — the application composition root.
 *
 * Owns the immutable `WorkerManager` (exposed readonly), the executor, the
 * scheduler and the supervisor, plus the engines the built-in handlers work
 * through. `WorkerEngine` itself is stateful by design (it is the
 * composition root): the manager it holds is *replaced* via successor
 * construction on every transition.
 */
export class WorkerEngine {
  private _manager: WorkerManager;

  /** The scheduler (deterministic selection). */
  readonly scheduler: WorkerScheduler;
  /** The supervisor (monitoring + recovery). */
  readonly supervisor: WorkerSupervisor;
  /** The executor (resolves handlers by task kind). */
  readonly executor: WorkerExecutor;
  /** The Job Engine reused by `"job"` tasks (never replaced). */
  readonly jobEngine: JobEngine;
  /** The Workflow Engine reused by `"workflow"` tasks (never replaced). */
  readonly workflowEngine: WorkflowEngine;
  /** The Action Engine reused by `"action"` tasks (never replaced). */
  readonly actionEngine: ActionEngine;
  /** The Digest Engine reused by `"digest"` tasks (never replaced). */
  readonly digestEngine: DigestEngine;
  /** The Tool Executor reused by `"tool"` tasks (never replaced). */
  readonly toolExecutor: ToolExecutor;

  private readonly now: () => string;

  constructor(options: WorkerEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.jobEngine = options.jobEngine ?? getProductionJobEngine();
    this.workflowEngine = options.workflowEngine ?? getProductionWorkflowEngine();
    this.actionEngine = options.actionEngine ?? getProductionActionEngine();
    this.digestEngine = options.digestEngine ?? getProductionDigestEngine();
    this.toolExecutor =
      options.toolExecutor ?? new ToolExecutor(new ToolRegistry(createBuiltInReadTools()));

    const registry =
      options.handlerRegistry ??
      registerBuiltInWorkerHandlers(new WorkerTaskHandlerRegistry(), {
        jobEngine: this.jobEngine,
        workflowEngine: this.workflowEngine,
        actionEngine: this.actionEngine,
        digestEngine: this.digestEngine,
        toolExecutor: this.toolExecutor,
      });
    this.executor = options.executor ?? new WorkerExecutor(registry, { now: options.now, clockMs: options.clockMs });
    this.scheduler = options.scheduler ?? new WorkerScheduler();
    this.supervisor = options.supervisor ?? createWorkerSupervisor();
    this._manager = options.manager ?? new WorkerManager();
  }

  /** The current worker manager (readonly view; never replaced in place). */
  get manager(): WorkerManager {
    return this._manager;
  }

  /** Number of registered workers. */
  countWorkers(): number {
    return this._manager.countWorkers();
  }

  /** Number of registered tasks. */
  countTasks(): number {
    return this._manager.countTasks();
  }

  /** Detached clones of every worker. */
  listWorkers() {
    return this._manager.listWorkers();
  }

  /** Detached clones of every task. */
  listTasks(): WorkerTask[] {
    return this._manager.listTasks();
  }

  /** The stored worker, or `undefined`. */
  findWorker(workerId: string) {
    return this._manager.find(workerId);
  }

  /** The stored task, or `undefined`. */
  findTask(taskId: string) {
    return this._manager.findTask(taskId);
  }

  /** Register a worker through the engine (application seam). */
  registerWorker(input: CreateWorkerInput): { engine: WorkerEngine; worker: Worker } {
    const { manager, worker } = this._manager.registerWorker(input);
    this._manager = manager;
    return { engine: this, worker };
  }

  /** Start a registered worker through the engine. */
  startWorker(workerId: string, at?: string): { engine: WorkerEngine; worker: Worker } {
    const { manager, worker } = this._manager.startWorker(workerId, at ?? this.now());
    this._manager = manager;
    return { engine: this, worker };
  }

  /** Record a heartbeat through the engine. */
  heartbeat(workerId: string, at?: string): { engine: WorkerEngine; worker: Worker } {
    const { manager, worker } = this._manager.heartbeat(workerId, at ?? this.now());
    this._manager = manager;
    return { engine: this, worker };
  }

  /** Enqueue a task through the engine. */
  enqueueTask(input: CreateWorkerTaskInput, now?: string): { engine: WorkerEngine; task: WorkerTask } {
    const { manager, task } = this._manager.enqueueTask(input, now ?? this.now());
    this._manager = manager;
    return { engine: this, task };
  }

  /** Scale a pool through the engine. */
  scalePool(
    pool: string,
    targetSize: number,
    at?: string,
  ): { engine: WorkerEngine; added: Worker[]; removed: Worker[] } {
    const { manager, added, removed } = this._manager.scalePool(pool, targetSize, at ?? this.now());
    this._manager = manager;
    return { engine: this, added, removed };
  }

  /**
   * Run one full pass over the worker layer at `now`:
   *
   * 1. advance — promote due delayed/retry items into pending;
   * 2. expire stale leases (automatic recovery);
   * 3. supervise — restart/escalate dead workers;
   * 4. lease — assign the next pending task to every idle worker;
   * 5. execute — run every leased task through the executor (in parallel)
   *    and settle each outcome in deterministic lease order;
   * 6. report the aggregated run summary.
   *
   * Deterministic given `now` (leased tasks run in worker registration
   * order and settle in lease order).
   */
  async runOnce(now?: string, signal?: AbortSignal): Promise<WorkerRunSummaryShape> {
    const at = now ?? this.now();
    let manager = this._manager;

    // 1. Advance due delayed/retry items.
    const { manager: advanced } = manager.advance(at);
    manager = advanced;

    // 2. Expire stale leases.
    const { manager: afterExpiry, expired } = manager.expireLeases(at);
    manager = afterExpiry;

    // 3. Supervise (restart/escalate dead workers).
    const { manager: supervised, report } = this.supervisor.supervise(manager, at);
    manager = supervised;

    // 4. Lease to every idle worker (deterministic order). Selection is
    //    batched once (a single deterministic sort) and each selected task is
    //    assigned to a distinct idle worker.
    const idleWorkers = manager.registry.listIdle(at);
    const selectedItems = selectBatchItems(
      manager.pending.items,
      manager.tasks,
      at,
      idleWorkers.length,
      { strategy: this.scheduler.strategy },
    );
    const leased: { taskId: string; workerId: string }[] = [];
    for (let index = 0; index < selectedItems.length; index += 1) {
      const worker = idleWorkers[index];
      const item = selectedItems[index];
      if (worker === undefined || item === undefined) break;
      const assigned = manager.assignTask(worker.id, item.taskId, at);
      manager = assigned.manager;
      leased.push({ taskId: assigned.task.id, workerId: worker.id });
    }

    // 5. Execute every leased task in parallel; settle in lease order.
    const executions = leased.map((entry) =>
      this.executor.execute(this.requireTask(entry.taskId), {
        workerId: entry.workerId,
        now: at,
        signal,
      }),
    );
    const outcomes = await Promise.all(executions);

    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index];
      const entry = leased[index];
      if (outcome === undefined || entry === undefined) continue;
      if (outcome.status === "completed") {
        manager = manager
          .completeTask(entry.taskId, entry.workerId, at, outcome.output, outcome.durationMs)
          .manager;
        completed += 1;
      } else if (outcome.status === "failed") {
        manager = manager
          .failTask(
            entry.taskId,
            entry.workerId,
            at,
            outcome.error ?? { code: "handler_error", message: "Unknown failure" },
            outcome.durationMs,
          )
          .manager;
        failed += 1;
      } else {
        manager = manager.cancelTask(entry.taskId, at, outcome.error).manager;
        cancelled += 1;
      }
    }

    this._manager = manager;
    return {
      at,
      leased: leased.length,
      completed,
      failed,
      cancelled,
      expired: expired.length,
      restarted: report.restarted.length,
    };
  }

  /** Run one pass; alias of {@link runOnce} (the application entry point). */
  runWorkers(options: { now?: string; signal?: AbortSignal } = {}): Promise<WorkerRunSummaryShape> {
    return this.runOnce(options.now, options.signal);
  }

  /** Stop every worker (releases active leases). Returns the successor engine. */
  shutdownWorkers(
    now?: string,
    reason = "shutdown",
  ): { engine: WorkerEngine; workers: Worker[]; summary: WorkerShutdownReport } {
    const at = now ?? this.now();
    let manager = this._manager;
    const stopped: string[] = [];
    for (const worker of manager.listWorkers()) {
      if (worker.status === "stopped" || worker.status === "removed") continue;
      const result = manager.stopWorker(worker.id, at, reason);
      manager = result.manager;
      stopped.push(worker.id);
    }
    this._manager = manager;
    return {
      engine: this,
      workers: manager.listWorkers(),
      summary: { at, stopped, stoppedCount: stopped.length, total: manager.countWorkers() },
    };
  }

  /** Restart every stopped worker. Returns the successor engine. */
  restartWorkers(now?: string): { engine: WorkerEngine; workers: Worker[]; summary: WorkerRestartReport } {
    const at = now ?? this.now();
    let manager = this._manager;
    const restarted: string[] = [];
    for (const worker of manager.listWorkers()) {
      if (worker.status !== "stopped" && worker.status !== "failed") continue;
      const result = manager.restartWorker(worker.id, at);
      manager = result.manager;
      restarted.push(worker.id);
    }
    this._manager = manager;
    return {
      engine: this,
      workers: manager.listWorkers(),
      summary: { at, restarted, restartedCount: restarted.length, total: manager.countWorkers() },
    };
  }

  /** A health report over every worker at `now`. */
  workerStatus(now?: string): HealthReport {
    return buildHealthReport(this._manager, now ?? this.now());
  }

  /** Detached clone of the stored task or throw. */
  private requireTask(taskId: string): WorkerTask {
    const task = this._manager.findTask(taskId);
    if (task === undefined) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }
}

/** Report of a shutdown pass. */
export interface WorkerShutdownReport {
  readonly at: string;
  readonly stopped: readonly string[];
  readonly stoppedCount: number;
  readonly total: number;
}

/** Report of a restart pass. */
export interface WorkerRestartReport {
  readonly at: string;
  readonly restarted: readonly string[];
  readonly restartedCount: number;
  readonly total: number;
}

/** Dependencies injected into the built-in task handlers. */
export interface BuiltInWorkerHandlerDependencies {
  readonly jobEngine: JobEngine;
  readonly workflowEngine: WorkflowEngine;
  readonly actionEngine: ActionEngine;
  readonly digestEngine: DigestEngine;
  readonly toolExecutor: ToolExecutor;
}

/**
 * Register the built-in task handlers over the injected production engines.
 *
 * - `"job"`: runs the referenced background job through the Job Engine's
 *   `runManual` (no new job is created).
 * - `"workflow"`: runs the referenced stored workflow through the Workflow
 *   Engine's `runWorkflow`.
 * - `"action"`: plans + executes the referenced action intent through the
 *   Action Engine.
 * - `"digest"`: builds the named digest (morning/evening/weekly) through the
 *   Digest Engine.
 * - `"tool"`: executes the referenced tool plan through the Tool Executor.
 * - `"custom"`: intentionally unsupported by the built-ins — a handler must
 *   be injected (documented; the executor fails the task structurally).
 *
 * A handler that throws is isolated into a failed task by the executor.
 */
export function registerBuiltInWorkerHandlers(
  registry: WorkerTaskHandlerRegistry,
  deps: BuiltInWorkerHandlerDependencies,
): WorkerTaskHandlerRegistry {
  const handleJob: WorkerTaskHandler = async (context) => {
    const payload = requirePayloadKind(context.payload, "job");
    const jobId = requireString(payload.jobId, "jobId");
    return deps.jobEngine.runManual(jobId, context.now, context.signal);
  };

  const handleWorkflow: WorkerTaskHandler = async (context) => {
    const payload = requirePayloadKind(context.payload, "workflow");
    const workflowId = requireString(payload.workflowId, "workflowId");
    const workflow = deps.workflowEngine.findWorkflow(workflowId);
    if (workflow === undefined) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    const { result } = await deps.workflowEngine.runWorkflow(workflow, {
      now: context.now,
      signal: context.signal,
    });
    return result;
  };

  const handleAction: WorkerTaskHandler = async (context) => {
    const payload = requirePayloadKind(context.payload, "action");
    const text = requireString(payload.text, "text");
    const userId = requireString(payload.userId, "userId");
    const requests: readonly PlanActionRequest[] = payload.requests.map(toActionRequest);
    const plan = deps.actionEngine.planner.plan({
      text,
      userId,
      now: context.now,
      requests,
    });
    const { result } = await deps.actionEngine.executePlan(plan, {
      now: context.now,
      signal: context.signal,
      timeoutMs: context.task.timeoutMs,
    });
    return result;
  };

  const handleDigest: WorkerTaskHandler = async (context) => {
    const payload = requirePayloadKind(context.payload, "digest");
    const template = requireString(payload.template, "template");
    const userId = requireString(payload.userId, "userId");
    const options: BuildDigestOptions = { userId, now: context.now };
    switch (template) {
      case "morning":
        return deps.digestEngine.buildMorningDigest(options);
      case "evening":
        return deps.digestEngine.buildEveningDigest(options);
      case "weekly":
        return deps.digestEngine.buildWeeklyDigest(options);
      default:
        throw new Error(`Unknown digest template "${template}"`);
    }
  };

  const handleTool: WorkerTaskHandler = async (context) => {
    const payload = requirePayloadKind(context.payload, "tool");
    const planId = requireString(payload.planId, "planId");
    const stepsValue = payload.steps;
    if (!Array.isArray(stepsValue)) {
      throw new Error(`Worker task payload field "steps" must be an array`);
    }
    const steps = stepsValue.map((step) => {
      const record = requireObject(step, "steps[]");
      const stepId = requireString(record.stepId, "stepId");
      const toolId = requireString(record.toolId, "toolId");
      const dependsOn = requireStringArray(record.dependsOn, "dependsOn");
      const input = requireObject(record.input ?? {}, "input");
      const executionStep = {
        stepId,
        toolId,
        input,
        dependsOn,
      } as ExecutionStep;
      return executionStep;
    });
    const plan = createExecutionPlan({ id: planId, steps });
    const result: ExecutionResult = await deps.toolExecutor.execute(plan, {
      timeoutMs: context.task.timeoutMs,
      signal: context.signal,
    });
    return result;
  };

  return registry.registerMany([
    { kind: "job", handler: handleJob },
    { kind: "workflow", handler: handleWorkflow },
    { kind: "action", handler: handleAction },
    { kind: "digest", handler: handleDigest },
    { kind: "tool", handler: handleTool },
  ]);
}

/**
 * Build a fresh production worker engine.
 *
 * Wires the built-in handlers over the production Job/Workflow/Action/Digest
 * engines and the built-in read-tool executor. Optional overrides seed the
 * graph for dependency injection. Pure — construction only; nothing runs.
 */
export function createProductionWorkerEngine(options: WorkerEngineOptions = {}): WorkerEngine {
  return new WorkerEngine(options);
}

/**
 * The application's single production worker engine instance.
 * Created once at module load.
 */
const productionWorkerEngine = createProductionWorkerEngine();

/** Return the application's single production worker engine instance. */
export function getProductionWorkerEngine(): WorkerEngine {
  return productionWorkerEngine;
}

/** Run one pass through the production worker engine. */
export function runWorkers(
  options: { now?: string; signal?: AbortSignal } = {},
): Promise<WorkerRunSummaryShape> {
  return getProductionWorkerEngine().runWorkers(options);
}

/** Shut down every worker through the production engine. */
export function shutdownWorkers(now?: string): WorkerShutdownReport {
  const { summary } = getProductionWorkerEngine().shutdownWorkers(now);
  return summary;
}

/** Restart every stopped worker through the production engine. */
export function restartWorkers(now?: string): WorkerRestartReport {
  const { summary } = getProductionWorkerEngine().restartWorkers(now);
  return summary;
}

/** The current worker health status through the production engine. */
export function workerStatus(now?: string): HealthReport {
  return getProductionWorkerEngine().workerStatus(now);
}

/** Re-exported for convenience. */
export type { WorkerError, HealthReport, WorkerSupervisorReport };
