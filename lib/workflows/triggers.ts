/**
 * Workflow Engine — built-in workflow triggers.
 *
 * The trigger layer decides *when* a workflow fires. A `WorkflowTriggerEvent`
 * is an immutable signal from an engine (conversation updated, memory added,
 * digest generated, job completed, action completed, tool finished, manual
 * run, scheduler tick); each trigger kind has a pure adapter that matches a
 * stored workflow against an event.
 *
 * - **Pure adapters**: every adapter is a pure function of `(workflow,
 *   event)` — no side effects, no engines, no I/O. Matching is fully
 *   deterministic.
 * - **Entity narrowing**: a workflow whose trigger pins an entity id
 *   (`conversationId`, `memoryId`, ...) only matches events about that
 *   entity; an unpinned trigger matches any event of its kind. An optional
 *   `event` qualifier on the workflow's trigger narrows further (e.g. only
 *   `"completed"` digest events).
 * - **Scheduled matching**: the `scheduled` adapter matches a scheduler tick
 *   when the workflow's schedule is due at the event's `now` (delegating to
 *   the workflow's own `isWorkflowRunnable`).
 * - **Registry**: `WorkflowTriggerRegistry` is immutable (successor
 *   `register`/`unregister`, snapshot `list`), mirroring the tool/action
 *   registries.
 *
 * The adapters never execute anything and never touch the repository — the
 * production engine selects and runs matching workflows.
 */

import {
  isWorkflowRunnable,
  type Workflow,
  type WorkflowTriggerKind,
} from "./types";

/**
 * An immutable engine signal that may fire workflows.
 *
 * `kind` selects the adapter; the optional `<x>Id` and `event` fields are
 * matched against the workflow's trigger; `now` anchors scheduled matching;
 * `signal` is the payload conditions may read at plan time.
 */
export interface WorkflowTriggerEvent {
  readonly kind: WorkflowTriggerKind;
  /** Optional entity qualifier matched against the workflow's trigger. */
  readonly conversationId?: string;
  readonly memoryId?: string;
  readonly digestId?: string;
  readonly jobId?: string;
  readonly actionId?: string;
  readonly toolId?: string;
  /** Optional event qualifier (e.g. `"completed"`, `"added"`). */
  readonly event?: string;
  /** ISO-8601 UTC timestamp of the signal (anchors scheduled matching). */
  readonly now: string;
  /** Optional payload exposed to plan conditions. */
  readonly signal?: Readonly<Record<string, unknown>>;
}

/**
 * A pure trigger adapter: decides whether `workflow` fires on `event`.
 */
export interface WorkflowTriggerAdapter {
  readonly kind: WorkflowTriggerKind;
  matches(workflow: Workflow, event: WorkflowTriggerEvent): boolean;
}

/**
 * Immutable collection of trigger adapters.
 *
 * `register` and `unregister` return a *new* registry rather than mutating
 * the current one, and `list()` exposes a snapshot — mirroring the
 * `ToolRegistry` conventions.
 */
export class WorkflowTriggerRegistry {
  private readonly adapters: ReadonlyMap<WorkflowTriggerKind, WorkflowTriggerAdapter>;

  constructor(adapters: readonly WorkflowTriggerAdapter[] = []) {
    const map = new Map<WorkflowTriggerKind, WorkflowTriggerAdapter>();
    for (const adapter of adapters) {
      if (map.has(adapter.kind)) {
        throw new Error(`Workflow trigger registry already contains adapter "${adapter.kind}"`);
      }
      map.set(adapter.kind, adapter);
    }
    this.adapters = map;
  }

  /** Return a new registry with `adapter` added. Never mutates `this`. */
  register(adapter: WorkflowTriggerAdapter): WorkflowTriggerRegistry {
    if (this.adapters.has(adapter.kind)) {
      throw new Error(`Workflow trigger registry already contains adapter "${adapter.kind}"`);
    }
    return new WorkflowTriggerRegistry([...this.adapters.values(), adapter]);
  }

  /** Return a new registry without the adapter `kind` (no-op when absent). */
  unregister(kind: WorkflowTriggerKind): WorkflowTriggerRegistry {
    if (!this.adapters.has(kind)) return this;
    return new WorkflowTriggerRegistry(
      [...this.adapters.values()].filter((adapter) => adapter.kind !== kind),
    );
  }

  /** Look up an adapter by kind; `undefined` when not registered. */
  get(kind: WorkflowTriggerKind): WorkflowTriggerAdapter | undefined {
    return this.adapters.get(kind);
  }

  /** Whether an adapter for `kind` is registered. */
  has(kind: WorkflowTriggerKind): boolean {
    return this.adapters.has(kind);
  }

  /** Snapshot of the registered adapters in registration order. */
  list(): readonly WorkflowTriggerAdapter[] {
    return [...this.adapters.values()];
  }
}

/**
 * The manual adapter: a manual workflow fires on a manual event whenever it
 * is pending, non-archived, and enabled.
 */
class ManualTriggerAdapter implements WorkflowTriggerAdapter {
  readonly kind: WorkflowTriggerKind = "manual";

  matches(workflow: Workflow, event: WorkflowTriggerEvent): boolean {
    if (event.kind !== "manual") return false;
    return workflow.trigger.kind === "manual" && isWorkflowRunnable(workflow, event.now);
  }
}

/**
 * The scheduled adapter: a scheduled workflow fires on a scheduler tick when
 * its schedule is due at the event's `now`.
 */
class ScheduledTriggerAdapter implements WorkflowTriggerAdapter {
  readonly kind: WorkflowTriggerKind = "scheduled";

  matches(workflow: Workflow, event: WorkflowTriggerEvent): boolean {
    if (event.kind !== "scheduled") return false;
    return workflow.trigger.kind === "scheduled" && isWorkflowRunnable(workflow, event.now);
  }
}

/**
 * Shared matching for the signal adapters: the trigger kind must match the
 * event kind, the workflow's pinned entity ids (and optional `event`
 * qualifier) must be consistent with the event, and the workflow must be
 * runnable at the event's `now`.
 */
function matchesSignalTrigger(
  workflow: Workflow,
  event: WorkflowTriggerEvent,
  kind: WorkflowTriggerKind,
): boolean {
  if (workflow.trigger.kind !== kind) return false;
  const trigger = workflow.trigger;
  if (trigger.event !== undefined && trigger.event !== event.event) return false;
  if (trigger.conversationId !== undefined && trigger.conversationId !== event.conversationId) {
    return false;
  }
  if (trigger.memoryId !== undefined && trigger.memoryId !== event.memoryId) return false;
  if (trigger.digestId !== undefined && trigger.digestId !== event.digestId) return false;
  if (trigger.jobId !== undefined && trigger.jobId !== event.jobId) return false;
  if (trigger.actionId !== undefined && trigger.actionId !== event.actionId) return false;
  if (trigger.toolId !== undefined && trigger.toolId !== event.toolId) return false;
  return isWorkflowRunnable(workflow, event.now);
}

/** The conversation adapter: fires on conversation signals. */
class ConversationTriggerAdapter implements WorkflowTriggerAdapter {
  readonly kind: WorkflowTriggerKind = "conversation";

  matches(workflow: Workflow, event: WorkflowTriggerEvent): boolean {
    if (event.kind !== "conversation") return false;
    return matchesSignalTrigger(workflow, event, "conversation");
  }
}

/** The memory adapter: fires on memory signals. */
class MemoryTriggerAdapter implements WorkflowTriggerAdapter {
  readonly kind: WorkflowTriggerKind = "memory";

  matches(workflow: Workflow, event: WorkflowTriggerEvent): boolean {
    if (event.kind !== "memory") return false;
    return matchesSignalTrigger(workflow, event, "memory");
  }
}

/** The digest adapter: fires on digest signals. */
class DigestTriggerAdapter implements WorkflowTriggerAdapter {
  readonly kind: WorkflowTriggerKind = "digest";

  matches(workflow: Workflow, event: WorkflowTriggerEvent): boolean {
    if (event.kind !== "digest") return false;
    return matchesSignalTrigger(workflow, event, "digest");
  }
}

/** The job adapter: fires on job signals. */
class JobTriggerAdapter implements WorkflowTriggerAdapter {
  readonly kind: WorkflowTriggerKind = "job";

  matches(workflow: Workflow, event: WorkflowTriggerEvent): boolean {
    if (event.kind !== "job") return false;
    return matchesSignalTrigger(workflow, event, "job");
  }
}

/** The action adapter: fires on action signals. */
class ActionTriggerAdapter implements WorkflowTriggerAdapter {
  readonly kind: WorkflowTriggerKind = "action";

  matches(workflow: Workflow, event: WorkflowTriggerEvent): boolean {
    if (event.kind !== "action") return false;
    return matchesSignalTrigger(workflow, event, "action");
  }
}

/** The tool adapter: fires on tool signals. */
class ToolTriggerAdapter implements WorkflowTriggerAdapter {
  readonly kind: WorkflowTriggerKind = "tool";

  matches(workflow: Workflow, event: WorkflowTriggerEvent): boolean {
    if (event.kind !== "tool") return false;
    return matchesSignalTrigger(workflow, event, "tool");
  }
}

/**
 * Build the eight built-in trigger adapters: manual, scheduled, conversation,
 * memory, digest, job, action, and tool.
 */
export function createBuiltInTriggerAdapters(): readonly WorkflowTriggerAdapter[] {
  return Object.freeze([
    new ManualTriggerAdapter(),
    new ScheduledTriggerAdapter(),
    new ConversationTriggerAdapter(),
    new MemoryTriggerAdapter(),
    new DigestTriggerAdapter(),
    new JobTriggerAdapter(),
    new ActionTriggerAdapter(),
    new ToolTriggerAdapter(),
  ]);
}

/**
 * Select the workflows (in the given order) that fire on `event`.
 *
 * Pure — nothing is executed and nothing is mutated. Uses `registry` (or the
 * built-in adapters when omitted) to match each workflow against the event,
 * and only returns workflows that are pending, non-archived, and enabled.
 */
export function selectWorkflowsForEvent(
  workflows: readonly Workflow[],
  event: WorkflowTriggerEvent,
  registry: WorkflowTriggerRegistry = new WorkflowTriggerRegistry(createBuiltInTriggerAdapters()),
): Workflow[] {
  const adapter = registry.get(event.kind);
  if (adapter === undefined) return [];
  return workflows.filter((workflow) => adapter.matches(workflow, event));
}
