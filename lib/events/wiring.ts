/**
 * Application Event Bus — workflow triggering wiring (Phase 5J STEP 6).
 *
 * Connects the application event bus to `WorkflowEngine.triggerWorkflow`:
 * every engine signal the app emits (conversation updated, memory stored,
 * digest published, job completed, action completed) is translated to a
 * `WorkflowTriggerEvent` and fired through the Workflow Engine — the pure,
 * event-driven path (no polling).
 *
 * Pipeline per event:
 *
 * ```text
 * Engine mutation → bus.emit → WorkflowEventWiring
 *   → appEventToWorkflowEvent (STEP 5)
 *   → WorkflowEngine.triggerWorkflow (Phase 5I)
 * ```
 *
 * Guarantees:
 * - **Application wiring only**: no engine logic lives here; the wiring is a
 *   thin subscriber over the existing bus and engine.
 * - **Failure isolation**: a throwing `triggerWorkflow` (or mapping) is
 *   isolated — the emit summary reports it and other listeners continue.
 * - **No event duplication**: the bus delivers each event exactly once to
 *   this wiring (it subscribes once per kind).
 */

import type { EventBus } from "./bus";
import type { AppEvent, AppEventType } from "./types";
import { appEventToWorkflowEvent } from "./types";
import type { WorkflowEngine } from "@/lib/workflows/production";
import type { TriggerSummary } from "@/lib/workflows/production";

/** Event kinds the wiring forwards to the Workflow Engine. */
export const WIRED_EVENT_TYPES: readonly AppEventType[] = Object.freeze([
  "conversation.updated",
  "memory.stored",
  "digest.published",
  "job.completed",
  "action.completed",
]);

/** The outcome of firing one event through the wiring. */
export interface WiringFireResult {
  readonly event: AppEvent;
  /** The trigger summary when the event fired workflows. */
  readonly summary?: TriggerSummary;
  /** Set when the event kind has no workflow trigger adapter. */
  readonly skipped?: boolean;
  /** Structured failure when the wiring could not fire (isolated). */
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * The bus → Workflow Engine wiring handle.
 *
 * `connect()` subscribes to every wired event kind; `disconnect()` removes
 * the subscriptions. Idempotent and never throws — the wiring is
 * application composition, not engine logic.
 *
 * The engine may be supplied as a live getter (`() => WorkflowEngine`).
 * Application composition roots (e.g. `ApplicationEngines`) rebuild their
 * engine instances on mutation, so the dynamic form keeps the wiring
 * pointing at the current engine without re-wiring.
 */
export class WorkflowEventWiring {
  private readonly workflowEngineRef: WorkflowEngine | (() => WorkflowEngine);
  private busRef: EventBus;
  private listenerIds: readonly string[];
  private connected: boolean;

  constructor(bus: EventBus, workflowEngine: WorkflowEngine | (() => WorkflowEngine)) {
    this.workflowEngineRef = workflowEngine;
    this.busRef = bus;
    this.listenerIds = [];
    this.connected = false;
  }

  /** The engine the wiring fires through (resolves the getter each call). */
  private workflowEngine(): WorkflowEngine {
    return typeof this.workflowEngineRef === "function"
      ? this.workflowEngineRef()
      : this.workflowEngineRef;
  }

  /** Whether the wiring is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Subscribe to every wired event kind. Idempotent — connecting when
   * already connected is a no-op.
   */
  connect(): void {
    if (this.connected) return;
    let next = this.busRef;
    const ids: string[] = [];
    for (const type of WIRED_EVENT_TYPES) {
      const { bus, id } = next.subscribe(type, (event) => this.handle(event));
      next = bus;
      ids.push(id);
    }
    this.busRef = next;
    this.listenerIds = Object.freeze(ids);
    this.connected = true;
  }

  /**
   * Remove every wiring subscription from the tracked bus (successor).
   * Idempotent — the unsubscribed successor bus is exposed via
   * {@link currentBus}.
   */
  disconnect(): void {
    if (!this.connected) return;
    let next = this.busRef;
    for (const id of this.listenerIds) {
      next = next.unsubscribe(id);
    }
    this.busRef = next;
    this.listenerIds = [];
    this.connected = false;
  }

  /**
   * Fire one event through the Workflow Engine (used by the internal
   * listener and available for tests). Never throws.
   */
  async fire(event: AppEvent): Promise<WiringFireResult> {
    try {
      const trigger = appEventToWorkflowEvent(event);
      if (trigger === undefined) {
        return { event, skipped: true };
      }
      const summary = await this.workflowEngine().triggerWorkflow(trigger);
      return { event, summary };
    } catch (err) {
      return {
        event,
        error: {
          code: "wiring_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** The current (successor) bus reference — for tests and diagnostics. */
  currentBus(): EventBus {
    return this.busRef;
  }

  /** Internal listener: only forwards while connected (never throws). */
  private handle(event: AppEvent): Promise<void> {
    if (!this.connected) return Promise.resolve();
    return this.fire(event).then(() => undefined);
  }
}

/**
 * Wire the production bus to `workflowEngine` and return the handle.
 */
export function wireWorkflowTriggers(
  bus: EventBus,
  workflowEngine: WorkflowEngine,
): WorkflowEventWiring {
  const wiring = new WorkflowEventWiring(bus, workflowEngine);
  wiring.connect();
  return wiring;
}

/**
 * Wire the production bus to a *live* workflow engine accessor and return
 * the handle. Use when the composition root rebuilds its engine instances
 * (e.g. `ApplicationEngines`): the getter resolves the current engine on
 * every fired event.
 */
export function wireWorkflowTriggersDynamic(
  bus: EventBus,
  getWorkflowEngine: () => WorkflowEngine,
): WorkflowEventWiring {
  const wiring = new WorkflowEventWiring(bus, getWorkflowEngine);
  wiring.connect();
  return wiring;
}
