/**
 * AI Actions — action manager (pure orchestration).
 *
 * The operation-facing facade over `ActionRepository`. Every mutation is an
 * immutable step: the receiver is never changed, and each operation returns
 * the successor manager (with the successor repository) plus any artifact it
 * produced (created/started/patched action).
 *
 * Uses only `ActionRepository` — no planner, no executor, no persistence, no
 * database, no AI.
 *
 * Lifecycle: `createAction` / `scheduleAction` → `executeAction` →
 * `completeAction` / `failAction` / `cancelAction`; `retryAction` re-enables
 * a failed/cancelled action; `archiveAction` / `restoreAction` toggle the
 * archived flag that excludes an action from scheduling; `deleteAction`
 * removes the action entirely; `bulkCreate` / `bulkCancel` are the atomic
 * batch operations.
 */

import { ActionNotFoundError, ActionRepository } from "./repository";
import {
  createAction,
  createActionExecution,
  touchAction,
  type Action,
  type ActionError,
  type ActionResult,
  type ActionExecution,
  type ActionStatus,
  type CreateActionInput,
} from "./types";

/** Input accepted by {@link ActionManager.executeAction}. */
export interface ExecuteActionInput {
  /** ISO-8601 UTC timestamp of the run start. */
  readonly at: string;
}

/** Input accepted by {@link ActionManager.completeAction}. */
export interface CompleteActionInput {
  /** ISO-8601 UTC timestamp of the completion. */
  readonly at: string;
  /** Executor attempt number that succeeded. */
  readonly attempt?: number;
  /** The action's output. */
  readonly output?: unknown;
  /** Optional human-readable note about the run. */
  readonly message?: string;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/** Input accepted by {@link ActionManager.failAction}. */
export interface FailActionInput {
  /** ISO-8601 UTC timestamp of the failure. */
  readonly at: string;
  /** Structured failure detail. */
  readonly error: ActionError;
  /** Executor attempt number that failed. */
  readonly attempt?: number;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/** Input accepted by {@link ActionManager.cancelAction}. */
export interface CancelActionInput {
  /** ISO-8601 UTC timestamp of the cancellation. */
  readonly at: string;
  /** Optional structured reason for the cancellation. */
  readonly error?: ActionError;
  /** Executor attempt number that was cancelled. */
  readonly attempt?: number;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs?: number;
}

/**
 * Pure in-memory orchestration over an `ActionRepository`.
 *
 * The backing repository is exposed as a public readonly field so downstream
 * composition (the planner, the executor, production wiring) can read the
 * exact state this manager operates on.
 */
export class ActionManager {
  /** The backing immutable repository (never replaced in place). */
  readonly repository: ActionRepository;

  /**
   * Build a manager over a repository. When omitted, an empty repository is
   * used.
   */
  constructor(repository: ActionRepository = new ActionRepository()) {
    this.repository = repository;
  }

  /** Return a detached clone of the stored action, or `undefined`. */
  find(id: string): Action | undefined {
    return this.repository.find(id);
  }

  /** Return detached clones of every stored action, in insertion order. */
  list(): Action[] {
    return this.repository.list();
  }

  /** Whether an action with the given id is stored. */
  has(id: string): boolean {
    return this.repository.has(id);
  }

  /** Number of stored actions. */
  count(): number {
    return this.repository.count();
  }

  /**
   * Create a new action (built via `createAction` with defaults) and return
   * it plus the successor manager. Throws `ActionDuplicateError` for an
   * already-stored id.
   */
  createAction(input: CreateActionInput): { manager: ActionManager; action: Action } {
    const action = createAction(input);
    const { action: stored, repository } = this.repository.add(action);
    return { manager: new ActionManager(repository), action: stored };
  }

  /**
   * Create an action with a schedule (the entry point for scheduled and
   * recurring actions). Identical to `createAction`; documented separately so
   * callers express intent. Throws `ActionDuplicateError` for duplicates.
   */
  scheduleAction(input: CreateActionInput): { manager: ActionManager; action: Action } {
    return this.createAction(input);
  }

  /**
   * Mark an action as running: status `"running"`, `startedAt` set, `attempts`
   * incremented, and a `running` execution record appended. Returns the
   * started action (plus its execution) and the successor manager. Throws
   * `ActionNotFoundError` for unknown ids.
   */
  executeAction(
    actionId: string,
    input: ExecuteActionInput,
  ): { manager: ActionManager; action: Action; execution: ActionExecution } {
    const current = this.require(actionId);
    const attempts = current.attempts + 1;
    const execution = createActionExecution({
      actionId,
      attempt: attempts,
      status: "running",
      startedAt: input.at,
    });
    const action = touchAction(current, {
      status: "running",
      attempts,
      startedAt: input.at,
      completedAt: null,
      executions: [...current.executions, execution],
    });
    return { manager: new ActionManager(this.repository.replace(action)), action, execution };
  }

  /**
   * Mark an action as completed: status `"completed"`, `completedAt` set, the
   * `running` execution finalized as `completed` with the outcome attached.
   * Throws `ActionNotFoundError` for unknown ids.
   */
  completeAction(
    actionId: string,
    input: CompleteActionInput,
  ): { manager: ActionManager; action: Action } {
    const current = this.require(actionId);
    const result: ActionResult = {
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
    const action = touchAction(current, {
      status: "completed",
      completedAt: input.at,
      result,
      error: null,
      executions,
    });
    return { manager: new ActionManager(this.repository.replace(action)), action };
  }

  /**
   * Mark an action as failed: status `"failed"`, `error` set, the `running`
   * execution finalized as `failed`. Throws `ActionNotFoundError` for unknown
   * ids.
   */
  failAction(actionId: string, input: FailActionInput): { manager: ActionManager; action: Action } {
    const current = this.require(actionId);
    const executions = this.finalizeExecution(current, {
      status: "failed",
      finishedAt: input.at,
      attempt: input.attempt,
      error: { ...input.error },
      durationMs: input.durationMs,
    });
    const action = touchAction(current, {
      status: "failed",
      error: { ...input.error },
      result: null,
      executions,
    });
    return { manager: new ActionManager(this.repository.replace(action)), action };
  }

  /**
   * Mark an action as cancelled: status `"cancelled"`, optional `error` set,
   * the `running` execution finalized as `cancelled`. Throws
   * `ActionNotFoundError` for unknown ids.
   */
  cancelAction(
    actionId: string,
    input: CancelActionInput,
  ): { manager: ActionManager; action: Action } {
    const current = this.require(actionId);
    const executions = this.finalizeExecution(current, {
      status: "cancelled",
      finishedAt: input.at,
      attempt: input.attempt,
      ...(input.error !== undefined ? { error: { ...input.error } } : {}),
      durationMs: input.durationMs,
    });
    const action = touchAction(current, {
      status: "cancelled",
      ...(input.error !== undefined ? { error: { ...input.error } } : {}),
      result: null,
      executions,
    });
    return { manager: new ActionManager(this.repository.replace(action)), action };
  }

  /**
   * Re-enable a failed or cancelled action for a new run: status `"pending"`,
   * `error` cleared, `result` cleared, `scheduledAt` preserved. Runs already
   * recorded in `executions` are kept. Throws `ActionNotFoundError` for
   * unknown ids; actions that are not failed/cancelled are returned
   * unchanged.
   */
  retryAction(actionId: string): { manager: ActionManager; action: Action } {
    const current = this.require(actionId);
    if (current.status !== "failed" && current.status !== "cancelled") {
      return { manager: this, action: current };
    }
    const action = touchAction(current, { status: "pending", error: null, result: null });
    return { manager: new ActionManager(this.repository.replace(action)), action };
  }

  /**
   * Archive an action: sets `archived` so it is excluded from scheduling
   * while remaining stored. Throws `ActionNotFoundError` for unknown ids.
   */
  archiveAction(actionId: string): ActionManager {
    return new ActionManager(this.repository.update(actionId, { archived: true }).repository);
  }

  /**
   * Restore an archived action: clears `archived`. Throws
   * `ActionNotFoundError` for unknown ids.
   */
  restoreAction(actionId: string): ActionManager {
    return new ActionManager(this.repository.update(actionId, { archived: false }).repository);
  }

  /**
   * Remove the action with the given id entirely. Throws
   * `ActionNotFoundError` for unknown ids. Distinct from `cancelAction` (which
   * marks the action cancelled but keeps it stored) and `archiveAction` (which
   * keeps it stored but unschedulable).
   */
  deleteAction(actionId: string): ActionManager {
    return new ActionManager(this.repository.remove(actionId));
  }

  /**
   * Create many actions atomically. Returns the successor manager plus every
   * stored action. Throws `ActionDuplicateError` on the first duplicate id
   * (the receiver is unchanged either way).
   */
  bulkCreate(inputs: readonly CreateActionInput[]): {
    manager: ActionManager;
    actions: Action[];
  } {
    let repository = this.repository;
    const actions: Action[] = [];
    for (const input of inputs) {
      const action = createAction(input);
      const result = repository.add(action);
      repository = result.repository;
      actions.push(result.action);
    }
    return { manager: new ActionManager(repository), actions };
  }

  /**
   * Cancel many actions atomically. Throws `ActionNotFoundError` on the first
   * unknown id (the receiver is unchanged either way).
   */
  bulkCancel(actionIds: readonly string[]): ActionManager {
    let repository = this.repository;
    for (const actionId of actionIds) {
      const current = repository.find(actionId);
      if (current === undefined) {
        throw new ActionNotFoundError(actionId);
      }
      const action = touchAction(current, { status: "cancelled" });
      repository = repository.replace(action);
    }
    return new ActionManager(repository);
  }

  /** Return a detached clone of the stored action or throw. */
  private require(actionId: string): Action {
    const action = this.repository.find(actionId);
    if (action === undefined) {
      throw new ActionNotFoundError(actionId);
    }
    return action;
  }

  /**
   * Build the successor executions list: the most recent `running` execution
   * is replaced by a finalized record carrying `status`, `finishedAt`, and
   * the optional error/result/duration. When the action has no running
   * execution (e.g. a direct settle without `executeAction`), the finalized
   * record is appended.
   */
  private finalizeExecution(
    action: Action,
    finalize: {
      status: ActionStatus;
      finishedAt: string;
      attempt?: number;
      error?: ActionError;
      result?: ActionResult;
      durationMs?: number;
    },
  ): readonly ActionExecution[] {
    const executions = action.executions;
    const runningIndex = executions.reduce(
      (lastIndex, execution, index) => (execution.status === "running" ? index : lastIndex),
      -1,
    );

    const finalized = createActionExecution({
      actionId: action.id,
      attempt: finalize.attempt ?? executions[runningIndex]?.attempt ?? action.attempts,
      status: finalize.status,
      startedAt: executions[runningIndex]?.startedAt ?? action.startedAt ?? finalize.finishedAt,
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
