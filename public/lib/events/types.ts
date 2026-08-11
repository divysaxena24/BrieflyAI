/**
 * Application Event Bus — immutable event models (Phase 5J STEP 5).
 *
 * Application events are the signals engines emit when their state changes.
 * Each event is an immutable, frozen value; every field is caller-supplied
 * (no `Date.now()`, no `Math.random()`), so events are deterministic and
 * reproducible.
 *
 * The six event kinds map onto the Workflow Engine's trigger adapters via
 * {@link appEventToWorkflowEvent} — this is the seam the automatic workflow
 * triggering wiring (STEP 6) uses to connect the bus to
 * `WorkflowEngine.triggerWorkflow`.
 */

import { hashString } from "@/lib/hash";
import type { WorkflowTriggerEvent } from "@/lib/workflows/triggers";

/** The six application event kinds. */
export type AppEventType =
  | "conversation.updated"
  | "memory.stored"
  | "digest.published"
  | "workflow.triggered"
  | "job.completed"
  | "action.completed";

/** Every event kind, in a stable canonical order. */
export const APP_EVENT_TYPES: readonly AppEventType[] = Object.freeze([
  "conversation.updated",
  "memory.stored",
  "digest.published",
  "workflow.triggered",
  "job.completed",
  "action.completed",
]);

/**
 * An immutable application event.
 *
 * - `type` selects the kind.
 * - `entityId` is the id of the entity the event is about (conversation,
 *   memory, digest, workflow, job, or action).
 * - `now` anchors the event in time (caller-supplied, deterministic).
 * - `payload` is optional structured context listeners may read.
 */
export interface AppEvent {
  readonly type: AppEventType;
  /** Id of the entity the event is about. */
  readonly entityId: string;
  /** ISO-8601 UTC timestamp of the event (caller-supplied). */
  readonly now: string;
  /** Optional structured payload exposed to listeners. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Stable event id derived deterministically from the event's contents. */
  readonly id: string;
}

/** Input accepted by {@link createAppEvent}. */
export interface CreateAppEventInput {
  readonly type: AppEventType;
  readonly entityId: string;
  readonly now: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Build a new immutable application event.
 *
 * The event id is a deterministic hash of type + entityId + now, so
 * re-emitting the same signal produces the same id (dedupe-friendly).
 */
export function createAppEvent(input: CreateAppEventInput): AppEvent {
  return Object.freeze({
    type: input.type,
    entityId: input.entityId,
    now: input.now,
    ...(input.payload !== undefined ? { payload: Object.freeze({ ...input.payload }) } : {}),
    id: `event-${hashString(`${input.type}:${input.entityId}:${input.now}`)}`,
  });
}

/** Return a deep, detached copy of an event (never frozen). */
export function cloneAppEvent(event: AppEvent): AppEvent {
  return {
    type: event.type,
    entityId: event.entityId,
    now: event.now,
    ...(event.payload !== undefined ? { payload: { ...event.payload } } : {}),
    id: event.id,
  };
}

/** Deep-freeze an event in place and return it (idempotent). */
export function freezeAppEvent(event: AppEvent): AppEvent {
  if (event.payload !== undefined) Object.freeze(event.payload);
  return Object.freeze(event);
}

/** Stable hash of an event's identity (type + entityId + now). */
export function hashAppEvent(event: AppEvent): string {
  return hashString(`${event.type}:${event.entityId}:${event.now}`);
}

/**
 * Map an application event to the Workflow Engine trigger event it fires.
 *
 * - `conversation.updated` → `{ kind: "conversation", conversationId }`
 * - `memory.stored`       → `{ kind: "memory", memoryId }`
 * - `digest.published`    → `{ kind: "digest", digestId }`
 * - `job.completed`       → `{ kind: "job", jobId }`
 * - `action.completed`    → `{ kind: "action", actionId }`
 * - `workflow.triggered`  → `undefined` — no trigger adapter exists for a
 *   workflow completing (documented; the wiring skips this kind).
 *
 * Pure and deterministic.
 */
export function appEventToWorkflowEvent(event: AppEvent): WorkflowTriggerEvent | undefined {
  const now = event.now;
  const signal = event.payload;
  switch (event.type) {
    case "conversation.updated":
      return { kind: "conversation", conversationId: event.entityId, event: "updated", now, ...(signal !== undefined ? { signal } : {}) };
    case "memory.stored":
      return { kind: "memory", memoryId: event.entityId, event: "stored", now, ...(signal !== undefined ? { signal } : {}) };
    case "digest.published":
      return { kind: "digest", digestId: event.entityId, event: "published", now, ...(signal !== undefined ? { signal } : {}) };
    case "job.completed":
      return { kind: "job", jobId: event.entityId, event: "completed", now, ...(signal !== undefined ? { signal } : {}) };
    case "action.completed":
      return { kind: "action", actionId: event.entityId, event: "completed", now, ...(signal !== undefined ? { signal } : {}) };
    case "workflow.triggered":
      return undefined;
  }
}

/** Convenience builders for each event kind. */
export const eventBuilders = Object.freeze({
  conversationUpdated: (entityId: string, now: string, payload?: Readonly<Record<string, unknown>>): AppEvent =>
    createAppEvent({ type: "conversation.updated", entityId, now, ...(payload !== undefined ? { payload } : {}) }),
  memoryStored: (entityId: string, now: string, payload?: Readonly<Record<string, unknown>>): AppEvent =>
    createAppEvent({ type: "memory.stored", entityId, now, ...(payload !== undefined ? { payload } : {}) }),
  digestPublished: (entityId: string, now: string, payload?: Readonly<Record<string, unknown>>): AppEvent =>
    createAppEvent({ type: "digest.published", entityId, now, ...(payload !== undefined ? { payload } : {}) }),
  workflowTriggered: (entityId: string, now: string, payload?: Readonly<Record<string, unknown>>): AppEvent =>
    createAppEvent({ type: "workflow.triggered", entityId, now, ...(payload !== undefined ? { payload } : {}) }),
  jobCompleted: (entityId: string, now: string, payload?: Readonly<Record<string, unknown>>): AppEvent =>
    createAppEvent({ type: "job.completed", entityId, now, ...(payload !== undefined ? { payload } : {}) }),
  actionCompleted: (entityId: string, now: string, payload?: Readonly<Record<string, unknown>>): AppEvent =>
    createAppEvent({ type: "action.completed", entityId, now, ...(payload !== undefined ? { payload } : {}) }),
});
