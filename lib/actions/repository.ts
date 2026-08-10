/**
 * AI Actions — immutable in-memory action repository.
 *
 * `ActionRepository` is the storage facade of the actions layer: a private,
 * immutable collection of `Action` objects held in insertion order. Every
 * mutation returns a NEW repository — the original is never changed.
 *
 * Guarantees:
 * - **Constructor snapshot**: the initial actions are copied on entry; later
 *   caller mutation of those objects never affects the repository.
 * - **Detached clones**: every stored action is deep-frozen internally, and
 *   every read returns a fresh detached clone.
 * - **Insertion order**: `list()` returns actions in creation order;
 *   `update`/`replace` keep an action's position; `remove` removes it.
 * - **Filter queries**: `findByStatus`, `findByType`, `findByPriority`,
 *   `findByConversation`, `findByMemory`, and `findByJob` (actions linked to
 *   the corresponding entity).
 * - **No caching, no singleton, no storage, no database**.
 *
 * All operations are deterministic: identical operation sequences produce
 * deep-equal repository states.
 */

import { AppError } from "@/lib/errors";
import {
  cloneAction,
  freezeAction,
  isActionDue,
  touchAction,
  type Action,
  type ActionPatch,
  type ActionPriority,
  type ActionStatus,
  type ActionType,
} from "./types";

/** Raised when an operation targets an action id that is not stored. */
export class ActionNotFoundError extends AppError {
  constructor(actionId: string) {
    super(`Action not found: ${actionId}`, 404, "action_not_found");
  }
}

/** Raised when an action is added with an id that is already stored. */
export class ActionDuplicateError extends AppError {
  constructor(actionId: string) {
    super(`Action already exists: ${actionId}`, 409, "action_duplicate_id");
  }
}

/**
 * Immutable in-memory collection of actions.
 *
 * All methods are pure with respect to the repository: reads never mutate,
 * and mutations return the successor repository without touching `this`.
 */
export class ActionRepository {
  /** The stored actions, oldest first, deep-frozen. */
  private readonly actions: readonly Action[];

  /**
   * Build a repository from an initial set of actions.
   *
   * Every action is copied (detached from the caller) and deep-frozen; the
   * internal array itself is frozen. Insertion order of the input is
   * preserved.
   */
  constructor(initialActions: readonly Action[] = []) {
    this.actions = Object.freeze(
      initialActions.map((action) => freezeAction(cloneAction(action))),
    );
  }

  /**
   * Store a new action (appended at the end). Throws `ActionDuplicateError`
   * for an already-stored id. Returns the stored action plus the successor
   * repository.
   */
  add(action: Action): { action: Action; repository: ActionRepository } {
    if (this.has(action.id)) {
      throw new ActionDuplicateError(action.id);
    }
    const stored = freezeAction(cloneAction(action));
    return { action: stored, repository: new ActionRepository([...this.actions, stored]) };
  }

  /**
   * Apply a partial patch to the stored action with the given id.
   *
   * Missing patch keys are preserved; `input`/`dependsOn`/`tags`/`executions`
   * are copied; a `null` value clears an optional field. Throws
   * `ActionNotFoundError` for unknown ids. Returns the patched action (a new
   * object) plus the successor repository (position preserved).
   */
  update(id: string, patch: ActionPatch): { action: Action; repository: ActionRepository } {
    const current = this.require(id);
    const updated = touchAction(current, patch);
    return {
      action: cloneAction(updated),
      repository: new ActionRepository(
        this.actions.map((stored) =>
          stored.id === id ? freezeAction(cloneAction(updated)) : stored,
        ),
      ),
    };
  }

  /**
   * Replace the stored action with the same id by a detached copy of
   * `action`. The action keeps its insertion position. Throws
   * `ActionNotFoundError` for unknown ids.
   */
  replace(action: Action): ActionRepository {
    this.require(action.id);
    return new ActionRepository(
      this.actions.map((stored) =>
        stored.id === action.id ? freezeAction(cloneAction(action)) : stored,
      ),
    );
  }

  /** Remove the action with the given id. Throws for unknown ids. */
  remove(id: string): ActionRepository {
    this.require(id);
    return new ActionRepository(this.actions.filter((action) => action.id !== id));
  }

  /** Return a new, empty repository. The receiver is never modified. */
  clear(): ActionRepository {
    return new ActionRepository();
  }

  /** Return a detached clone of the stored action, or `undefined`. */
  find(id: string): Action | undefined {
    const stored = this.actions.find((action) => action.id === id);
    return stored === undefined ? undefined : cloneAction(stored);
  }

  /** Return detached clones of every action with the given status, in order. */
  findByStatus(status: ActionStatus): Action[] {
    return this.list().filter((action) => action.status === status);
  }

  /** Return detached clones of every action of the given type, in order. */
  findByType(type: ActionType): Action[] {
    return this.list().filter((action) => action.type === type);
  }

  /** Return detached clones of every action with the given priority, in order. */
  findByPriority(priority: ActionPriority): Action[] {
    return this.list().filter((action) => action.priority === priority);
  }

  /** Return detached clones of every action linked to a conversation, in order. */
  findByConversation(conversationId: string): Action[] {
    return this.list().filter((action) => action.conversationId === conversationId);
  }

  /** Return detached clones of every action linked to a memory, in order. */
  findByMemory(memoryId: string): Action[] {
    return this.list().filter((action) => action.memoryId === memoryId);
  }

  /** Return detached clones of every action linked to a job, in order. */
  findByJob(jobId: string): Action[] {
    return this.list().filter((action) => action.jobId === jobId);
  }

  /**
   * Return detached clones of every pending, non-archived action that is due
   * at `now`, in insertion order (see `isActionDue`).
   */
  findRunnableActions(now: string): Action[] {
    return this.list().filter((action) => isActionDue(action, now));
  }

  /** Return detached clones of every stored action, in insertion order. */
  list(): Action[] {
    return this.actions.map(cloneAction);
  }

  /** Whether an action with the given id is stored. */
  has(id: string): boolean {
    return this.actions.some((action) => action.id === id);
  }

  /** Number of stored actions. */
  count(): number {
    return this.actions.length;
  }

  /** Throw `ActionNotFoundError` unless the id is stored. */
  private require(id: string): Action {
    const stored = this.actions.find((action) => action.id === id);
    if (stored === undefined) {
      throw new ActionNotFoundError(id);
    }
    return stored;
  }
}
