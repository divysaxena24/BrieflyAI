/**
 * Workflow Engine — production composition point.
 *
 * The single place the application composes the workflow framework. The
 * pipeline is wired from the existing engines — nothing is reimplemented:
 *
 * ```text
 * WorkflowRepository → WorkflowManager → WorkflowPlanner (Action Planner)
 *   → WorkflowExecutor (step handlers)
 *       → Action Engine   (action steps → plan + execute)
 *       → Job Engine      (job steps → runManual)
 *       → Tool Executor   (tool steps → execute plan)
 *       → Digest Engine   (digest steps → build)
 *   → WorkflowTriggerRegistry (built-in trigger adapters)
 *   → WorkflowEngine (composition root)
 * ```
 *
 * - `createProductionWorkflowEngine()` is a pure factory: it only wires the
 *   dependency graph (optionally seeded with injected engines for dependency
 *   injection); no workflow is planned or executed during construction.
 * - `getProductionWorkflowEngine()` returns the application's single engine
 *   instance (module-level singleton).
 * - `planWorkflow()` / `executeWorkflow()` / `runWorkflow()` /
 *   `triggerWorkflow()` are the entry points the application uses.
 *
 * No LLM and no reasoning live here — the planner is a deterministic
 * orchestrator, the executor delegates to the existing engines, and every
 * state transition goes through the immutable successor manager.
 *
 * Stop conditions (documented, per architecture rules): workflow state is
 * pure in-memory per process (no database/storage exists for it anywhere in
 * the codebase); trigger *emission* (wiring engine mutations to workflow
 * events) is the application's responsibility — this layer provides the pure
 * matching surface (`selectWorkflowsForEvent`) and the manual/scheduled
 * entry points (`runWorkflow` / `triggerWorkflow`).
 */

import { ActionEngine, getProductionActionEngine } from "@/lib/actions/production";
import { getProductionContextEngine } from "@/lib/context/production";
import type { ContextEngine } from "@/lib/context/engine";
import { DigestEngine, getProductionDigestEngine } from "@/lib/digest/production";
import type { Digest } from "@/lib/digest/types";
import { JobEngine, getProductionJobEngine } from "@/lib/jobs/production";
import type { RunSummary } from "@/lib/jobs/runner";
import { ToolExecutor } from "@/lib/tools/executor";
import { createBuiltInReadTools } from "@/lib/tools/builtin";
import { ToolRegistry } from "@/lib/tools/registry";
import type { ExecutionResult } from "@/lib/tools/executor";
import {
  WorkflowExecutor,
  WorkflowStepHandlerRegistry,
  type WorkflowExecutionResult,
  type WorkflowExecuteOptions,
  type WorkflowStepContext,
  type WorkflowStepResult,
} from "./executor";
import { WorkflowManager } from "./manager";
import {
  WorkflowPlanner,
  type PlannedWorkflowStep,
  type PlanWorkflowOptions,
  type WorkflowPlan,
} from "./planner";
import {
  createBuiltInTriggerAdapters,
  selectWorkflowsForEvent,
  WorkflowTriggerRegistry,
  type WorkflowTriggerEvent,
} from "./triggers";
import {
  createWorkflowReference,
  isWorkflowRunnable,
  type Workflow,
  type WorkflowError,
  type WorkflowReference,
  type WorkflowTriggerKind,
} from "./types";

/** Options accepted by {@link WorkflowEngine.executePlan}. */
export interface ExecuteWorkflowOptions {
  /** Injected current time; defaults to the engine clock. */
  readonly now?: string;
  /** Injected user id forwarded to handlers. */
  readonly userId?: string;
  /** Whole-run cancellation signal. */
  readonly signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Outcome of running one workflow in a trigger pass. */
export interface WorkflowRunOutcome {
  readonly reference: WorkflowReference;
  readonly status: "completed" | "failed" | "cancelled" | "skipped";
  /** The execution result when the workflow actually ran. */
  readonly result?: WorkflowExecutionResult;
  /** Structured failure detail when the pass could not run the workflow. */
  readonly error?: WorkflowError;
}

/** Aggregated outcome of a trigger pass. */
export interface TriggerSummary {
  readonly triggered: readonly WorkflowRunOutcome[];
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
}

/** Build a trigger summary from run outcomes. */
function summarizeOutcomes(outcomes: readonly WorkflowRunOutcome[]): TriggerSummary {
  return {
    triggered: outcomes,
    total: outcomes.length,
    completed: outcomes.filter((outcome) => outcome.status === "completed").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    cancelled: outcomes.filter((outcome) => outcome.status === "cancelled").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
  };
}

/**
 * The workflow engine — the application composition root.
 *
 * Owns the immutable `WorkflowManager` (exposed readonly), the planner, the
 * executor, and the engines the step handlers work through. `WorkflowEngine`
 * itself is stateful by design (it is the composition root): the manager it
 * holds is *replaced* via successor construction on every transition — the
 * underlying models/repositories/managers remain immutable and deterministic.
 */
export class WorkflowEngine {
  private _manager: WorkflowManager;

  /** The planner (converts workflows into execution plans). */
  readonly planner: WorkflowPlanner;
  /** The executor (runs plans through the step handler registry). */
  readonly executor: WorkflowExecutor;
  /** The trigger registry (matches workflows against events). */
  readonly triggerRegistry: WorkflowTriggerRegistry;
  /** The Action Engine reused by `"action"` steps (never replaced). */
  readonly actionEngine: ActionEngine;
  /** The Job Engine reused by `"job"` steps (never replaced). */
  readonly jobEngine: JobEngine;
  /** The Digest Engine reused by `"digest"` steps (never replaced). */
  readonly digestEngine: DigestEngine;
  /** The Context Engine reused via the action/digest engines. */
  readonly contextEngine: ContextEngine;
  /** The Tool Executor reused by `"tool"` steps (never replaced). */
  readonly toolExecutor: ToolExecutor;

  private readonly now: () => string;

  constructor(options: WorkflowEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.actionEngine = options.actionEngine ?? getProductionActionEngine();
    this.jobEngine = options.jobEngine ?? getProductionJobEngine();
    this.digestEngine = options.digestEngine ?? getProductionDigestEngine();
    this.contextEngine = options.contextEngine ?? getProductionContextEngine();
    this.toolExecutor =
      options.toolExecutor ?? new ToolExecutor(new ToolRegistry(createBuiltInReadTools()));

    // The workflow step-kind set is closed (action | job | tool | digest), so
    // an injected handler registry is a *full override* — built-ins are wired
    // only when no registry is provided (mirroring the action engine's
    // inject-to-extend seam, but with no `custom` escape hatch here).
    const registry =
      options.handlerRegistry ??
      registerBuiltInHandlers(new WorkflowStepHandlerRegistry(), {
        actionEngine: this.actionEngine,
        jobEngine: this.jobEngine,
        digestEngine: this.digestEngine,
        toolExecutor: this.toolExecutor,
      });
    this.executor = options.executor ?? new WorkflowExecutor(registry, { now: options.now });
    this.planner =
      options.planner ?? new WorkflowPlanner(this.actionEngine.planner);
    this.triggerRegistry =
      options.triggerRegistry ??
      new WorkflowTriggerRegistry(createBuiltInTriggerAdapters());
    this._manager = options.manager ?? new WorkflowManager();
  }

  /** The current workflow manager (readonly view; never replaced in place). */
  get manager(): WorkflowManager {
    return this._manager;
  }

  /** Number of stored workflows. */
  count(): number {
    return this._manager.count();
  }

  /** Detached clones of every stored workflow, in insertion order. */
  listWorkflows(): Workflow[] {
    return this._manager.list();
  }

  /** The stored workflow with the given id, or `undefined`. */
  findWorkflow(id: string): Workflow | undefined {
    return this._manager.find(id);
  }

  /**
   * Plan a workflow into an immutable `WorkflowPlan` through the planner.
   * Pure — nothing is stored or executed.
   */
  plan(workflow: Workflow, options: PlanWorkflowOptions): WorkflowPlan {
    return this.planner.plan(workflow, options);
  }

  /**
   * Execute a planned `WorkflowPlan`: start the stored workflow through the
   * successor manager, run it through the executor, and commit the settle
   * transition (complete/fail/cancel). Completed recurring workflows are
   * re-armed to their next occurrence. Returns the structured execution
   * result; the receiver engine is updated to the successor manager in
   * place.
   *
   * Documented throw paths (the executor itself never throws):
   * - `WorkflowNotFoundError` when the plan's workflow is not stored.
   */
  async executePlan(
    plan: WorkflowPlan,
    options: ExecuteWorkflowOptions = {},
  ): Promise<{ result: WorkflowExecutionResult }> {
    const now = options.now ?? this.now();
    this.require(plan.workflowId);

    const started = this._manager.startWorkflow(plan.workflowId, { at: now });
    this._manager = started.manager;
    const result = await this.executor.executePlan(plan, {
      now,
      userId: options.userId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    const settled =
      result.failedStepIds.length > 0
        ? this._manager.failWorkflow(plan.workflowId, {
            at: now,
            attempt: started.workflow.attempts,
            error: {
              code: "step_failed",
              message: `Workflow "${plan.workflowId}" failed: ${result.failedStepIds.join(", ")}`,
            },
            durationMs: resultDurationMs(result),
          })
        : result.cancelledStepIds.length > 0
          ? this._manager.cancelWorkflow(plan.workflowId, {
              at: now,
              attempt: started.workflow.attempts,
              error: { code: "cancelled", message: "Workflow was cancelled" },
              durationMs: resultDurationMs(result),
            })
          : this._manager.completeWorkflow(plan.workflowId, {
              at: now,
              attempt: started.workflow.attempts,
              output: result,
              durationMs: resultDurationMs(result),
            });
    this._manager = settled.manager;

    // Re-arm completed recurring workflows (successor-safe; mirrors the job
    // runner's rescheduling of recurring jobs).
    if (settled.workflow.status === "completed") {
      const rescheduled = this._manager.rescheduleWorkflow(plan.workflowId, now);
      if (rescheduled.workflow !== settled.workflow) {
        this._manager = rescheduled.manager;
      }
    }

    return { result };
  }

  /**
   * Store a workflow (when absent), plan it, and execute it. Returns the
   * structured execution result.
   *
   * Documented throw paths:
   * - `WorkflowDuplicateError` when the workflow id is already stored (e.g.
   *   re-running the same workflow against an accumulating engine —
   *   deterministic ids collide).
   */
  async runWorkflow(
    workflow: Workflow,
    options: ExecuteWorkflowOptions = {},
  ): Promise<{ result: WorkflowExecutionResult }> {
    const now = options.now ?? this.now();
    if (!this._manager.has(workflow.id)) {
      const added = this._manager.repository.add(workflow);
      this._manager = new WorkflowManager(added.repository);
    }
    const plan = this.planner.plan(workflow, {
      now,
      userId: options.userId,
    });
    return this.executePlan(plan, { ...options, now });
  }

  /**
   * Fire a trigger event: select every matching stored workflow, plan and
   * run each (in insertion order), and return the aggregated summary.
   *
   * - Only pending, non-archived, enabled workflows are selected (the
   *   adapters enforce this).
   * - Failure isolation: a workflow that cannot run (already settled, plan
   *   error, executor anomaly) is reported as `failed`/`skipped` without
   *   stopping the pass.
   */
  async triggerWorkflow(
    event: WorkflowTriggerEvent,
    options: ExecuteWorkflowOptions = {},
  ): Promise<TriggerSummary> {
    const now = options.now ?? this.now();
    const candidates = selectWorkflowsForEvent(this._manager.list(), event, this.triggerRegistry);
    const outcomes: WorkflowRunOutcome[] = [];

    for (const candidate of candidates) {
      const reference = createWorkflowReference(candidate);
      if (!isWorkflowRunnable(candidate, now)) {
        outcomes.push({ reference, status: "skipped" });
        continue;
      }
      try {
        const plan = this.planner.plan(candidate, {
          now,
          userId: options.userId,
          signal: event.signal,
        });
        const { result } = await this.executePlan(plan, { ...options, now });
        outcomes.push({ reference, status: outcomeStatus(result), result });
      } catch (err) {
        outcomes.push({
          reference,
          status: "failed",
          error: {
            code: "run_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    return summarizeOutcomes(outcomes);
  }

  /** Return a detached clone of the stored workflow or throw. */
  private require(workflowId: string): Workflow {
    const workflow = this._manager.find(workflowId);
    if (workflow === undefined) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    return workflow;
  }
}

/** Map an execution result to the trigger outcome status. */
function outcomeStatus(result: WorkflowExecutionResult): "completed" | "failed" | "cancelled" {
  if (result.failedStepIds.length > 0) return "failed";
  if (result.cancelledStepIds.length > 0) return "cancelled";
  return "completed";
}

/** Sum the step durations of an execution result. */
function resultDurationMs(result: WorkflowExecutionResult): number {
  return result.results.reduce((total, step) => total + step.durationMs, 0);
}

/** Options accepted by the {@link WorkflowEngine} constructor. */
export interface WorkflowEngineOptions {
  /** Initial workflow manager (dependency injection); empty by default. */
  readonly manager?: WorkflowManager;
  /** Planner (dependency injection); plain `WorkflowPlanner` by default. */
  readonly planner?: WorkflowPlanner;
  /** Executor (dependency injection); built from the handler registry. */
  readonly executor?: WorkflowExecutor;
  /** Handler registry (dependency injection); built-ins added unless provided. */
  readonly handlerRegistry?: WorkflowStepHandlerRegistry;
  /** Trigger registry (dependency injection); built-in adapters by default. */
  readonly triggerRegistry?: WorkflowTriggerRegistry;
  /** Action Engine reused by `"action"` steps (production singleton). */
  readonly actionEngine?: ActionEngine;
  /** Job Engine reused by `"job"` steps (production singleton). */
  readonly jobEngine?: JobEngine;
  /** Digest Engine reused by `"digest"` steps (production singleton). */
  readonly digestEngine?: DigestEngine;
  /** Context Engine reused via the action/digest engines. */
  readonly contextEngine?: ContextEngine;
  /** Tool executor reused by `"tool"` steps (built-in read tools). */
  readonly toolExecutor?: ToolExecutor;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
}

/** Dependencies injected into the built-in step handlers. */
interface BuiltInStepHandlerDependencies {
  readonly actionEngine: ActionEngine;
  readonly jobEngine: JobEngine;
  readonly digestEngine: DigestEngine;
  readonly toolExecutor: ToolExecutor;
}

/**
 * The production wiring used by `createProductionWorkflowEngine`: register
 * the four built-in step handlers over the injected engines.
 *
 * - `"action"`: executes the step's planned `ActionPlan` through the Action
 *   Engine (reusing the action planner + executor wholesale).
 * - `"job"`: runs the referenced background job through the Job Engine's
 *   `runManual` (no new job is created).
 * - `"tool"`: executes the step's tool plan through the Tool Executor.
 * - `"digest"`: builds the step's digest through the Digest Engine.
 *
 * A handler that throws is isolated into a failed step by the executor.
 */
function registerBuiltInHandlers(
  registry: WorkflowStepHandlerRegistry,
  deps: BuiltInStepHandlerDependencies,
): WorkflowStepHandlerRegistry {
  const handleAction = async (context: WorkflowStepContext): Promise<unknown> => {
    const plan = context.step.actionPlan;
    if (plan === undefined) {
      throw new Error(`Action step "${context.step.stepId}" has no planned action plan`);
    }
    const { result } = await deps.actionEngine.executePlan(plan, {
      now: context.now,
      userId: context.userId,
      signal: context.signal,
      timeoutMs: context.step.timeoutMs,
    });
    return result;
  };

  const handleJob = async (context: WorkflowStepContext): Promise<unknown> => {
    const jobId = context.step.action.jobId;
    if (jobId === undefined) {
      throw new Error(`Job step "${context.step.stepId}" has no job id`);
    }
    const summary: RunSummary = await deps.jobEngine.runManual(jobId, context.now, context.signal);
    return summary;
  };

  const handleTool = async (context: WorkflowStepContext): Promise<unknown> => {
    const plan = context.step.action.plan;
    if (plan === undefined) {
      throw new Error(`Tool step "${context.step.stepId}" has no tool plan`);
    }
    const result: ExecutionResult = await deps.toolExecutor.execute(plan, {
      timeoutMs: context.step.timeoutMs,
      signal: context.signal,
    });
    return result;
  };

  const handleDigest = async (context: WorkflowStepContext): Promise<unknown> => {
    const template = context.step.action.template;
    if (template === undefined) {
      throw new Error(`Digest step "${context.step.stepId}" has no digest template`);
    }
    const digest: Digest = await deps.digestEngine.build(template, {
      userId: context.userId ?? "workflow",
      now: context.now,
      ...(context.step.action.query !== undefined ? { query: context.step.action.query } : {}),
    });
    return digest;
  };

  return registry.registerMany([
    { kind: "action", handler: handleAction },
    { kind: "job", handler: handleJob },
    { kind: "tool", handler: handleTool },
    { kind: "digest", handler: handleDigest },
  ]);
}

/**
 * Build a fresh production workflow engine.
 *
 * Wires the planner (over the production Action Engine's planner), the
 * executor (with the four built-in step handlers over the production Action/
 * Job/Digest engines and the built-in read tool executor), and the built-in
 * trigger registry. Optional overrides seed the graph for dependency
 * injection. Pure — construction only; nothing is planned or executed.
 */
export function createProductionWorkflowEngine(options: WorkflowEngineOptions = {}): WorkflowEngine {
  return new WorkflowEngine(options);
}

/**
 * The application's single production workflow engine instance.
 * Created once at module load.
 */
const productionWorkflowEngine = createProductionWorkflowEngine();

/** Return the application's single production workflow engine instance. */
export function getProductionWorkflowEngine(): WorkflowEngine {
  return productionWorkflowEngine;
}

/**
 * Plan a workflow through the production workflow engine.
 */
export function planWorkflow(
  workflow: Workflow,
  options: PlanWorkflowOptions,
): WorkflowPlan {
  return getProductionWorkflowEngine().plan(workflow, options);
}

/**
 * Execute a planned workflow through the production workflow engine.
 */
export function executeWorkflow(
  plan: WorkflowPlan,
  options: ExecuteWorkflowOptions = {},
): Promise<{ result: WorkflowExecutionResult }> {
  return getProductionWorkflowEngine().executePlan(plan, options);
}

/**
 * Store, plan, and run a workflow through the production workflow engine.
 */
export function runWorkflow(
  workflow: Workflow,
  options: ExecuteWorkflowOptions = {},
): Promise<{ result: WorkflowExecutionResult }> {
  return getProductionWorkflowEngine().runWorkflow(workflow, options);
}

/**
 * Fire a trigger event through the production workflow engine.
 */
export function triggerWorkflow(
  event: WorkflowTriggerEvent,
  options: ExecuteWorkflowOptions = {},
): Promise<TriggerSummary> {
  return getProductionWorkflowEngine().triggerWorkflow(event, options);
}

// Re-exported for convenience so callers can build workflows without
// importing the model file directly.
export type {
  PlanWorkflowOptions,
  PlannedWorkflowStep,
  Workflow,
  WorkflowError,
  WorkflowExecutionResult,
  WorkflowExecuteOptions,
  WorkflowPlan,
  WorkflowReference,
  WorkflowStepContext,
  WorkflowStepResult,
  WorkflowTriggerEvent,
  WorkflowTriggerKind,
};
