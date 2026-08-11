/**
 * Phase 5J STEP 5 — application event model tests.
 */
import { describe, expect, it } from "vitest";
import {
  APP_EVENT_TYPES,
  appEventToWorkflowEvent,
  cloneAppEvent,
  createAppEvent,
  eventBuilders,
  freezeAppEvent,
  hashAppEvent,
} from "@/lib/events/types";

const NOW = "2026-08-10T08:00:00.000Z";

describe("createAppEvent", () => {
  it("builds immutable events with deterministic ids", () => {
    const event = createAppEvent({ type: "memory.stored", entityId: "mem-1", now: NOW });
    expect(event.id).toBe(
      createAppEvent({ type: "memory.stored", entityId: "mem-1", now: NOW }).id,
    );
    expect(event.id).toMatch(/^event-[0-9a-f]{8}$/);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("ids differ across kinds / entities / times", () => {
    const a = createAppEvent({ type: "memory.stored", entityId: "mem-1", now: NOW });
    const b = createAppEvent({ type: "memory.stored", entityId: "mem-2", now: NOW });
    const c = createAppEvent({ type: "digest.published", entityId: "mem-1", now: NOW });
    const d = createAppEvent({ type: "memory.stored", entityId: "mem-1", now: "2026-08-10T09:00:00.000Z" });
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4);
  });

  it("freezes the payload and preserves it", () => {
    const event = createAppEvent({
      type: "job.completed",
      entityId: "job-1",
      now: NOW,
      payload: { status: "ok" },
    });
    expect(event.payload).toEqual({ status: "ok" });
    expect(Object.isFrozen(event.payload)).toBe(true);
  });

  it("lists every event kind in canonical order", () => {
    expect(APP_EVENT_TYPES).toEqual([
      "conversation.updated",
      "memory.stored",
      "digest.published",
      "workflow.triggered",
      "job.completed",
      "action.completed",
    ]);
  });

  it("convenience builders produce the right kinds", () => {
    expect(eventBuilders.memoryStored("m", NOW).type).toBe("memory.stored");
    expect(eventBuilders.conversationUpdated("c", NOW).type).toBe("conversation.updated");
    expect(eventBuilders.digestPublished("d", NOW).type).toBe("digest.published");
    expect(eventBuilders.jobCompleted("j", NOW).type).toBe("job.completed");
    expect(eventBuilders.actionCompleted("a", NOW).type).toBe("action.completed");
    expect(eventBuilders.workflowTriggered("w", NOW).type).toBe("workflow.triggered");
  });
});

describe("cloneAppEvent / freezeAppEvent", () => {
  it("clones detach payloads", () => {
    const event = createAppEvent({ type: "memory.stored", entityId: "m", now: NOW, payload: { a: 1 } });
    const clone = cloneAppEvent(event);
    expect(clone).toEqual(event);
    expect(clone).not.toBe(event);
    expect(Object.isFrozen(clone)).toBe(false);
    (clone.payload as { a: number }).a = 2;
    expect(event.payload).toEqual({ a: 1 });
  });

  it("freeze is idempotent and deep", () => {
    const event = createAppEvent({ type: "job.completed", entityId: "j", now: NOW, payload: { x: [1] } });
    const frozen = freezeAppEvent(event);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.payload)).toBe(true);
    expect(freezeAppEvent(frozen)).toBe(frozen);
  });

  it("hashAppEvent is stable and distinct", () => {
    const a = createAppEvent({ type: "memory.stored", entityId: "m", now: NOW });
    const b = createAppEvent({ type: "memory.stored", entityId: "m", now: NOW });
    const c = createAppEvent({ type: "memory.stored", entityId: "n", now: NOW });
    expect(hashAppEvent(a)).toBe(hashAppEvent(b));
    expect(hashAppEvent(a)).not.toBe(hashAppEvent(c));
    expect(hashAppEvent(a)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("appEventToWorkflowEvent", () => {
  it("maps each engine signal to its trigger kind with entity qualifiers", () => {
    const conversation = appEventToWorkflowEvent(eventBuilders.conversationUpdated("conv-1", NOW));
    expect(conversation).toEqual({ kind: "conversation", conversationId: "conv-1", event: "updated", now: NOW });

    const memory = appEventToWorkflowEvent(eventBuilders.memoryStored("mem-1", NOW));
    expect(memory).toEqual({ kind: "memory", memoryId: "mem-1", event: "stored", now: NOW });

    const digest = appEventToWorkflowEvent(eventBuilders.digestPublished("digest-1", NOW));
    expect(digest).toEqual({ kind: "digest", digestId: "digest-1", event: "published", now: NOW });

    const job = appEventToWorkflowEvent(eventBuilders.jobCompleted("job-1", NOW));
    expect(job).toEqual({ kind: "job", jobId: "job-1", event: "completed", now: NOW });

    const action = appEventToWorkflowEvent(eventBuilders.actionCompleted("action-1", NOW));
    expect(action).toEqual({ kind: "action", actionId: "action-1", event: "completed", now: NOW });
  });

  it("forwards the payload as the trigger signal", () => {
    const event = createAppEvent({
      type: "digest.published",
      entityId: "digest-1",
      now: NOW,
      payload: { sections: 3 },
    });
    const trigger = appEventToWorkflowEvent(event);
    expect(trigger?.signal).toEqual({ sections: 3 });
  });

  it("returns undefined for workflow.triggered (no adapter)", () => {
    expect(appEventToWorkflowEvent(eventBuilders.workflowTriggered("wf-1", NOW))).toBeUndefined();
  });

  it("is deterministic", () => {
    const a = appEventToWorkflowEvent(eventBuilders.memoryStored("mem-1", NOW));
    const b = appEventToWorkflowEvent(eventBuilders.memoryStored("mem-1", NOW));
    expect(a).toEqual(b);
  });
});
