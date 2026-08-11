/**
 * Workflow Engine — immutable in-memory workflow repository.
 *
 * `WorkflowRepository` is the storage facade of the workflow layer: a
 * private, immutable collection of `Workflow` objects held in insertion
 * order. Every mutation returns a NEW repository — the original is never
 * changed — so the repository is safe to share and trivial to reason about.
 *
 * Guarantees:
 * - **Constructor snapshot**: the initial workflows are copied on entry;
 *   later caller mutation of those objects never affects the repository.
 * - **Detached clones**: every stored workflow is deep-frozen internally, and
 *   every read returns a fresh detached clone, so callers can never reach
 *   (or corrupt) the internal collection.
 * - **Insertion order**: `list()` returns workflows in creation order;
 *   `update`/`replace` keep a workflow's position; `remove` removes it.
 * - **Scheduling queries**: `findRunnableWorkflows(now)` returns the pending,
 *   non-archived, enabled workflows due at `now` (including unscheduled
 *   manual/signal workflows while pending).
 * - **No caching, no singleton, no timers, no storage, no database**.
 *
 * All operations are deterministic: identical operation sequences produce
 * deep-equal repository states.
 */

import { AppError } from "@/lib/errors";
import {
  cloneWorkflow,
  freezeWorkflow,
  isWorkflowRunnable,
  touchWorkflow,
  type Workflow,
  type WorkflowPatch,
  type WorkflowPriority,
  type WorkflowStatus,
  type WorkflowTriggerKind,
} from "./types";

/** Raised when an operation targets a workflow id that is not stored. */
export class WorkflowNotFoundError extends AppError {
  constructor(workflowId: string) {
    super(`Workflow not found: ${workflowId}`, 404, "workflow_not_found");
  }
}

/** Raised when a workflow is added with an id that is already stored. */
export class WorkflowDuplicateError extends AppError {
  constructor(workflowId: string) {
    super(`Workflow already exists: ${workflowId}`, 409, "workflow_duplicate_id");
  }
}

/**
 * Immutable in-memory collection of workflows.
 *
 * All methods are pure with respect to the repository: reads never mutate,
 * and mutations return the successor repository without touching `this`.
 */
export class WorkflowRepository {
  /** The stored workflows, oldest first, deep-frozen. */
  private readonly workflows: readonly Workflow[];

  /**
   * Build a repository from an initial set of workflows.
   *
   * Every workflow is copied (detached from the caller) and deep-frozen; the
   * internal array itself is frozen. Insertion order of the input is
   * preserved.
   */
  constructor(initialWorkflows: readonly Workflow[] = []) {
    this.workflows = Object.freeze(initialWorkflows.map((workflow) => freezeWorkflow(cloneWorkflow(workflow))));
  }

  /**
   * Store a new workflow (appended at the end). Throws
   * `WorkflowDuplicateError` for an already-stored id. Returns the stored
   * workflow plus the successor repository.
   */
  add(workflow: Workflow): { workflow: Workflow; repository: WorkflowRepository } {
    if (this.has(workflow.id)) {
      throw new WorkflowDuplicateError(workflow.id);
    }
    const stored = freezeWorkflow(cloneWorkflow(workflow));
    return { workflow: stored, repository: new WorkflowRepository([...this.workflows, stored]) };
  }

  /**
   * Apply a partial patch to the stored workflow with the given id.
   *
   * Missing patch keys are preserved; `steps`/`tags`/`executions` are copied;
   * a `null` value clears an optional field. A patched `steps` array is
   * re-validated. Throws `WorkflowNotFoundError` for unknown ids. Returns the
   * patched workflow (a new object) plus the successor repository (position
   * preserved).
   */
  update(id: string, patch: WorkflowPatch): { workflow: Workflow; repository: WorkflowRepository } {
    const current = this.require(id);
    const updated = touchWorkflow(current, patch);
    return {
      workflow: cloneWorkflow(updated),
      repository: new WorkflowRepository(
        this.workflows.map((stored) =>
          stored.id === id ? freezeWorkflow(cloneWorkflow(updated)) : stored,
        ),
      ),
    };
  }

  /**
   * Replace the stored workflow with the same id by a detached copy of
   * `workflow`. The workflow keeps its insertion position. Throws
   * `WorkflowNotFoundError` for unknown ids.
   */
  replace(workflow: Workflow): WorkflowRepository {
    this.require(workflow.id);
    return new WorkflowRepository(
      this.workflows.map((stored) =>
        stored.id === workflow.id ? freezeWorkflow(cloneWorkflow(workflow)) : stored,
      ),
    );
  }

  /** Remove the workflow with the given id. Throws for unknown ids. */
  remove(id: string): WorkflowRepository {
    this.require(id);
    return new WorkflowRepository(this.workflows.filter((workflow) => workflow.id !== id));
  }

  /** Return a new, empty repository. The receiver is never modified. */
  clear(): WorkflowRepository {
    return new WorkflowRepository();
  }

  /** Return a detached clone of the stored workflow, or `undefined`. */
  find(id: string): Workflow | undefined {
    const stored = this.workflows.find((workflow) => workflow.id === id);
    return stored === undefined ? undefined : cloneWorkflow(stored);
  }

  /** Return detached clones of every workflow with the given status, in order. */
  findByStatus(status: WorkflowStatus): Workflow[] {
    return this.list().filter((workflow) => workflow.status === status);
  }

  /** Return detached clones of every workflow with the given priority, in order. */
  findByPriority(priority: WorkflowPriority): Workflow[] {
    return this.list().filter((workflow) => workflow.priority === priority);
  }

  /** Return detached clones of every workflow with the given trigger kind, in order. */
  findByTrigger(trigger: WorkflowTriggerKind): Workflow[] {
    return this.list().filter((workflow) => workflow.trigger.kind === trigger);
  }

  /** Return detached clones of every workflow linked to the conversation. */
  findByConversation(conversationId: string): Workflow[] {
    return this.list().filter((workflow) => workflow.conversationId === conversationId);
  }

  /** Return detached clones of every workflow linked to the memory. */
  findByMemory(memoryId: string): Workflow[] {
    return this.list().filter((workflow) => workflow.memoryId === memoryId);
  }

  /** Return detached clones of every workflow linked to the job. */
  findByJob(jobId: string): Workflow[] {
    return this.list().filter((workflow) => workflow.jobId === jobId);
  }

  /** Return detached clones of every workflow linked to the digest. */
  findByDigest(digestId: string): Workflow[] {
    return this.list().filter((workflow) => workflow.digestId === digestId);
  }

  /**
   * Return detached clones of every workflow that may run at `now` — pending,
   * non-archived, enabled, and due (see `isWorkflowRunnable`) — in insertion
   * order. Workflows without a schedule (manual/signal triggers) are runnable
   * while pending.
   */
  findRunnableWorkflows(now: string): Workflow[] {
    return this.list().filter((workflow) => isWorkflowRunnable(workflow, now));
  }

  /** Return detached clones of every stored workflow, in insertion order. */
  list(): Workflow[] {
    return this.workflows.map(cloneWorkflow);
  }

  /** Whether a workflow with the given id is stored. */
  has(id: string): boolean {
    return this.workflows.some((workflow) => workflow.id === id);
  }

  /** Number of stored workflows. */
  count(): number {
    return this.workflows.length;
  }

  /** Throw `WorkflowNotFoundError` unless the id is stored. */
  private require(id: string): Workflow {
    const stored = this.workflows.find((workflow) => workflow.id === id);
    if (stored === undefined) {
      throw new WorkflowNotFoundError(id);
    }
    return stored;
  }
}
