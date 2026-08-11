/**
 * Workflow Engine — workflow manager (pure orchestration).
 *
 * The operation-facing facade over `WorkflowRepository`. Every mutation is an
 * immutable step: the receiver is never changed, and each operation returns
 * the successor manager (with the successor repository) plus any artifact it
 * produced (created/started/patched workflow).
 *
 * Uses only `WorkflowRepository` — no planner, no executor, no persistence,
 * no database, no AI.
 *
 * Lifecycle: `createWorkflow` / `scheduleWorkflow` → `startWorkflow` →
 * `completeWorkflow` / `failWorkflow` / `cancelWorkflow`; `retryWorkflow`
 * re-enables a failed/cancelled workflow; `rescheduleWorkflow` re-arms a
 * completed recurring workflow; `archiveWorkflow` / `restoreWorkflow` toggle
 * archival; `enableWorkflow` / `disableWorkflow` toggle the enabled flag;
 * `deleteWorkflow` removes the workflow entirely; `bulkCreate` / `bulkDelete`
 * are the atomic batch operations.
 */

import { WorkflowNotFoundError, WorkflowRepository } from "./repository";
import {
  createWorkflow,
  createWorkflowExecution,
  isRecurringSchedule,
  nextWorkflowOccurrence,
  touchWorkflow,
  type CreateWorkflowInput,
  type Workflow,
  type WorkflowError,
  type WorkflowExecution,
  type WorkflowPatch,
  type WorkflowResult,
  type WorkflowStatus,
} from "./types";

/** Input accepted by {@link WorkflowManager.startWorkflow}. */
export interface StartWorkflowInput {
  /** ISO-8601 UTC timestamp of the run start. */
  readonly at: string;
}

/** Input accepted by {@link WorkflowManager.completeWorkflow}. */
export interface CompleteWorkflowInput {
  /** ISO-8601 UTC timestamp of the completion. */
  readonly at: string;
  /** Executor attempt number that succeeded. */
  readonly attempt?: number;
  /** The workflow's output. */
  readonly output?: unknown;
  /** Optional human-readable note about the run. */
  readonly message?: string;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/** Input accepted by {@link WorkflowManager.failWorkflow}. */
export interface FailWorkflowInput {
  /** ISO-8601 UTC timestamp of the failure. */
  readonly at: string;
  /** Structured failure detail. */
  readonly error: WorkflowError;
  /** Executor attempt number that failed. */
  readonly attempt?: number;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/** Input accepted by {@link WorkflowManager.cancelWorkflow}. */
export interface CancelWorkflowInput {
  /** ISO-8601 UTC timestamp of the cancellation. */
  readonly at: string;
  /** Optional structured reason for the cancellation. */
  readonly error?: WorkflowError;
  /** Executor attempt number that was cancelled. */
  readonly attempt?: number;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/**
 * Pure in-memory orchestration over a `WorkflowRepository`.
 *
 * The backing repository is exposed as a public readonly field so downstream
 * composition (the planner, the executor, production wiring) can read the
 * exact state this manager operates on.
 */
export class WorkflowManager {
  /** The backing immutable repository (never replaced in place). */
  readonly repository: WorkflowRepository;

  /**
   * Build a manager over a repository. When omitted, an empty repository is
   * used.
   */
  constructor(repository: WorkflowRepository = new WorkflowRepository()) {
    this.repository = repository;
  }

  /** Return a detached clone of the stored workflow, or `undefined`. */
  find(id: string): Workflow | undefined {
    return this.repository.find(id);
  }

  /** Return detached clones of every stored workflow, in insertion order. */
  list(): Workflow[] {
    return this.repository.list();
  }

  /** Whether a workflow with the given id is stored. */
  has(id: string): boolean {
    return this.repository.has(id);
  }

  /** Number of stored workflows. */
  count(): number {
    return this.repository.count();
  }

  /**
   * Create a new workflow (built via `createWorkflow` with defaults) and
   * return it plus the successor manager. Throws `WorkflowDuplicateError` for
   * an already-stored id.
   */
  createWorkflow(input: CreateWorkflowInput): { manager: WorkflowManager; workflow: Workflow } {
    const workflow = createWorkflow(input);
    const { workflow: stored, repository } = this.repository.add(workflow);
    return { manager: new WorkflowManager(repository), workflow: stored };
  }

  /**
   * Create a workflow with a schedule (the entry point for scheduled and
   * recurring workflows). Identical to `createWorkflow`; documented
   * separately so callers express intent. Throws `WorkflowDuplicateError` for
   * duplicates.
   */
  scheduleWorkflow(input: CreateWorkflowInput): { manager: WorkflowManager; workflow: Workflow } {
    return this.createWorkflow(input);
  }

  /**
   * Apply a partial patch to a stored workflow. A patched `steps` array is
   * re-validated. Throws `WorkflowNotFoundError` for unknown ids. Returns the
   * patched workflow plus the successor manager.
   */
  updateWorkflow(workflowId: string, patch: WorkflowPatch): {
    manager: WorkflowManager;
    workflow: Workflow;
  } {
    const { workflow, repository } = this.repository.update(workflowId, patch);
    return { manager: new WorkflowManager(repository), workflow };
  }

  /**
   * Archive a workflow: sets `archived` so it is excluded from scheduling
   * while remaining stored. Throws `WorkflowNotFoundError` for unknown ids.
   */
  archiveWorkflow(workflowId: string): WorkflowManager {
    return new WorkflowManager(this.repository.update(workflowId, { archived: true }).repository);
  }

  /**
   * Restore an archived workflow: clears `archived`. Throws
   * `WorkflowNotFoundError` for unknown ids.
   */
  restoreWorkflow(workflowId: string): WorkflowManager {
    return new WorkflowManager(this.repository.update(workflowId, { archived: false }).repository);
  }

  /**
   * Disable a workflow: sets `enabled` false so it never fires while
   * remaining stored. Throws `WorkflowNotFoundError` for unknown ids.
   */
  disableWorkflow(workflowId: string): WorkflowManager {
    return new WorkflowManager(this.repository.update(workflowId, { enabled: false }).repository);
  }

  /**
   * Enable a disabled workflow: sets `enabled` true. Throws
   * `WorkflowNotFoundError` for unknown ids.
   */
  enableWorkflow(workflowId: string): WorkflowManager {
    return new WorkflowManager(this.repository.update(workflowId, { enabled: true }).repository);
  }

  /**
   * Remove the workflow with the given id entirely. Throws
   * `WorkflowNotFoundError` for unknown ids. Distinct from `cancelWorkflow`
   * (which marks the workflow cancelled but keeps it stored) and
   * `archiveWorkflow` (which keeps it stored but unschedulable).
   */
  deleteWorkflow(workflowId: string): WorkflowManager {
    return new WorkflowManager(this.repository.remove(workflowId));
  }

  /**
   * Mark a workflow as running: status `"running"`, `startedAt` set,
   * `attempts` incremented, and a `running` execution record appended.
   * Returns the started workflow (plus its execution) and the successor
   * manager. Throws `WorkflowNotFoundError` for unknown ids.
   */
  startWorkflow(
    workflowId: string,
    input: StartWorkflowInput,
  ): { manager: WorkflowManager; workflow: Workflow; execution: WorkflowExecution } {
    const current = this.require(workflowId);
    const attempts = current.attempts + 1;
    const execution = createWorkflowExecution({
      workflowId,
      attempt: attempts,
      status: "running",
      startedAt: input.at,
    });
    const workflow = touchWorkflow(current, {
      status: "running",
      attempts,
      startedAt: input.at,
      completedAt: null,
      executions: [...current.executions, execution],
    });
    return { manager: new WorkflowManager(this.repository.replace(workflow)), workflow, execution };
  }

  /**
   * Mark a workflow as completed: status `"completed"`, `completedAt` set, the
   * `running` execution finalized as `completed` with the outcome attached.
   * Throws `WorkflowNotFoundError` for unknown ids.
   */
  completeWorkflow(workflowId: string, input: CompleteWorkflowInput): {
    manager: WorkflowManager;
    workflow: Workflow;
  } {
    const current = this.require(workflowId);
    const result: WorkflowResult = {
      success: true,
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    };
    const executions = this.finalizeExecution(current, {
      status: "completed",
      finishedAt: input.at,
      attempt: input.attempt,
      result,
      durationMs: input.durationMs,
    });
    const workflow = touchWorkflow(current, {
      status: "completed",
      completedAt: input.at,
      result,
      error: null,
      executions,
    });
    return { manager: new WorkflowManager(this.repository.replace(workflow)), workflow };
  }

  /**
   * Mark a workflow as failed: status `"failed"`, `error` set, the `running`
   * execution finalized as `failed`. Throws `WorkflowNotFoundError` for
   * unknown ids.
   */
  failWorkflow(workflowId: string, input: FailWorkflowInput): {
    manager: WorkflowManager;
    workflow: Workflow;
  } {
    const current = this.require(workflowId);
    const executions = this.finalizeExecution(current, {
      status: "failed",
      finishedAt: input.at,
      attempt: input.attempt,
      error: { ...input.error },
      durationMs: input.durationMs,
    });
    const workflow = touchWorkflow(current, {
      status: "failed",
      error: { ...input.error },
      result: null,
      executions,
    });
    return { manager: new WorkflowManager(this.repository.replace(workflow)), workflow };
  }

  /**
   * Mark a workflow as cancelled: status `"cancelled"`, optional `error` set,
   * the `running` execution finalized as `cancelled`. Throws
   * `WorkflowNotFoundError` for unknown ids.
   */
  cancelWorkflow(workflowId: string, input: CancelWorkflowInput): {
    manager: WorkflowManager;
    workflow: Workflow;
  } {
    const current = this.require(workflowId);
    const executions = this.finalizeExecution(current, {
      status: "cancelled",
      finishedAt: input.at,
      attempt: input.attempt,
      ...(input.error !== undefined ? { error: { ...input.error } } : {}),
      durationMs: input.durationMs,
    });
    const workflow = touchWorkflow(current, {
      status: "cancelled",
      ...(input.error !== undefined ? { error: { ...input.error } } : {}),
      result: null,
      executions,
    });
    return { manager: new WorkflowManager(this.repository.replace(workflow)), workflow };
  }

  /**
   * Re-enable a failed or cancelled workflow for a new run: status
   * `"pending"`, `error` cleared, `result` cleared, `scheduledAt` preserved.
   * Runs already recorded in `executions` are kept. Throws
   * `WorkflowNotFoundError` for unknown ids; workflows that are not
   * failed/cancelled are returned unchanged.
   */
  retryWorkflow(workflowId: string): { manager: WorkflowManager; workflow: Workflow } {
    const current = this.require(workflowId);
    if (current.status !== "failed" && current.status !== "cancelled") {
      return { manager: this, workflow: current };
    }
    const workflow = touchWorkflow(current, { status: "pending", error: null, result: null });
    return { manager: new WorkflowManager(this.repository.replace(workflow)), workflow };
  }

  /**
   * Re-arm a completed recurring workflow for its next occurrence: status
   * `"pending"` and `scheduledAt` set to the next occurrence strictly after
   * `now`. Deterministic — `nextWorkflowOccurrence` derives the timestamp
   * from the schedule alone. Throws `WorkflowNotFoundError` for unknown ids.
   */
  rescheduleWorkflow(workflowId: string, now: string): {
    manager: WorkflowManager;
    workflow: Workflow;
  } {
    const current = this.require(workflowId);
    if (current.trigger.schedule === undefined || !isRecurringSchedule(current.trigger.schedule)) {
      return { manager: this, workflow: current };
    }
    const next = nextWorkflowOccurrence(current.trigger.schedule, now);
    if (next === undefined) {
      return { manager: this, workflow: current };
    }
    const workflow = touchWorkflow(current, { status: "pending", scheduledAt: next });
    return { manager: new WorkflowManager(this.repository.replace(workflow)), workflow };
  }

  /**
   * Create many workflows atomically. Returns the successor manager plus
   * every stored workflow. Throws `WorkflowDuplicateError` on the first
   * duplicate id (the receiver is unchanged either way).
   */
  bulkCreate(inputs: readonly CreateWorkflowInput[]): {
    manager: WorkflowManager;
    workflows: Workflow[];
  } {
    let repository = this.repository;
    const workflows: Workflow[] = [];
    for (const input of inputs) {
      const workflow = createWorkflow(input);
      const result = repository.add(workflow);
      repository = result.repository;
      workflows.push(result.workflow);
    }
    return { manager: new WorkflowManager(repository), workflows };
  }

  /**
   * Delete many workflows atomically. Throws `WorkflowNotFoundError` on the
   * first unknown id (the receiver is unchanged either way).
   */
  bulkDelete(workflowIds: readonly string[]): WorkflowManager {
    let repository = this.repository;
    for (const workflowId of workflowIds) {
      repository = repository.remove(workflowId);
    }
    return new WorkflowManager(repository);
  }

  /** Return a detached clone of the stored workflow or throw. */
  private require(workflowId: string): Workflow {
    const workflow = this.repository.find(workflowId);
    if (workflow === undefined) {
      throw new WorkflowNotFoundError(workflowId);
    }
    return workflow;
  }

  /**
   * Build the successor executions list: the most recent `running` execution
   * is replaced by a finalized record carrying `status`, `finishedAt`, and
   * the optional error/result/duration. When the workflow has no running
   * execution (e.g. a direct settle without `startWorkflow`), the finalized
   * record is appended.
   */
  private finalizeExecution(
    workflow: Workflow,
    finalize: {
      status: WorkflowStatus;
      finishedAt: string;
      attempt?: number;
      error?: WorkflowError;
      result?: WorkflowResult;
      durationMs?: number;
    },
  ): readonly WorkflowExecution[] {
    const executions = workflow.executions;
    const runningIndex = executions.reduce(
      (lastIndex, execution, index) => (execution.status === "running" ? index : lastIndex),
      -1,
    );

    const finalized = createWorkflowExecution({
      workflowId: workflow.id,
      attempt: finalize.attempt ?? executions[runningIndex]?.attempt ?? workflow.attempts,
      status: finalize.status,
      startedAt: executions[runningIndex]?.startedAt ?? workflow.startedAt ?? finalize.finishedAt,
      finishedAt: finalize.finishedAt,
      ...(finalize.error !== undefined ? { error: finalize.error } : {}),
      ...(finalize.result !== undefined ? { result: finalize.result } : {}),
      ...(finalize.durationMs !== undefined ? { durationMs: finalize.durationMs } : {}),
    });

    if (runningIndex === -1) {
      return [...executions, finalized];
    }
    const next = [...executions];
    next[runningIndex] = finalized;
    return next;
  }
}
