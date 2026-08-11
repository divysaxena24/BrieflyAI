/**
 * Phase 5J STEP 6 — automatic workflow triggering wiring tests.
 */
import { describe, expect, it } from "vitest";
import { EventBus } from "@/lib/events/bus";
import { createAppEvent, eventBuilders } from "@/lib/events/types";
import { WIRED_EVENT_TYPES, wireWorkflowTriggers, WorkflowEventWiring } from "@/lib/events/wiring";
import { createProductionWorkflowEngine, type WorkflowEngine } from "@/lib/workflows/production";
import { WorkflowManager } from "@/lib/workflows/manager";
import { createWorkflow, createWorkflowStep } from "@/lib/workflows/types";

const NOW = "2026-08-10T08:00:00.000Z";

/** A workflow engine with one digest-triggered workflow stored and pending. */
function engineWithDigestWorkflow(): WorkflowEngine {
  const engine = createProductionWorkflowEngine();
  const step = createWorkflowStep({ id: "step-1", name: "Run", action: { kind: "job", jobId: "bg-daily-digest" } });
  const workflow = createWorkflow({
    id: "wf-digest",
    name: "On digest",
    trigger: { kind: "digest", event: "published" },
    steps: [step],
    createdAt: NOW,
    scheduledAt: NOW,
  });
  const { repository } = engine.manager.repository.add(workflow);
  return createProductionWorkflowEngine({ manager: new WorkflowManager(repository) });
}

describe("WorkflowEventWiring", () => {
  it("wires every workflow-capable event kind", () => {
    expect(WIRED_EVENT_TYPES).toEqual([
      "conversation.updated",
      "memory.stored",
      "digest.published",
      "job.completed",
      "action.completed",
    ]);
  });

  it("fires matching workflows when the bus emits an event", async () => {
    const bus = new EventBus();
    const engine = engineWithDigestWorkflow();
    const wiring = new WorkflowEventWiring(bus, engine);
    wiring.connect();
    expect(wiring.isConnected()).toBe(true);

    const summary = await wiring.fire(eventBuilders.digestPublished("digest-x", NOW));
    expect(summary.skipped).toBeUndefined();
    expect(summary.summary?.total).toBe(1);
    expect(summary.summary?.completed).toBe(1);

    // The workflow ran to completion through the engine.
    expect(engine.findWorkflow("wf-digest")?.status).toBe("completed");
  });

  it("does not fire workflows whose trigger pins another entity", async () => {
    const bus = new EventBus();
    const engine = engineWithDigestWorkflow();
    const wiring = wireWorkflowTriggers(bus, engine);
    const summary = await wiring.fire(eventBuilders.digestPublished("digest-other", NOW));
    // The workflow's trigger pins no digestId, so any digest event matches.
    expect(summary.summary?.total).toBe(1);
  });

  it("is skipped for events with no workflow trigger adapter", async () => {
    const bus = new EventBus();
    const engine = createProductionWorkflowEngine();
    const wiring = new WorkflowEventWiring(bus, engine);
    wiring.connect();
    const result = await wiring.fire(eventBuilders.workflowTriggered("wf-1", NOW));
    expect(result.skipped).toBe(true);
  });

  it("isolates a throwing workflow engine (never throws)", async () => {
    const bus = new EventBus();
    const wiring = new WorkflowEventWiring(bus, {
      triggerWorkflow: async () => {
        throw new Error("engine down");
      },
    } as unknown as WorkflowEngine);
    wiring.connect();
    const result = await wiring.fire(eventBuilders.memoryStored("mem-1", NOW));
    expect(result.error?.code).toBe("wiring_failed");
    expect(result.error?.message).toBe("engine down");
  });

  it("delivers the event through the bus to the wiring listener", async () => {
    const bus = new EventBus();
    const engine = engineWithDigestWorkflow();
    wireWorkflowTriggers(bus, engine);
    // The wiring is subscribed on the (successor) bus.
    expect(bus.subscriberCount("digest.published")).toBe(0);
    // Emitting on the successor returned by currentBus fires the workflow.
    const wiring = new WorkflowEventWiring(bus, engine);
    wiring.connect();
    const summary = await wiring.currentBus().emit(eventBuilders.digestPublished("digest-z", NOW));
    expect(summary.total).toBe(1);
    expect(summary.delivered).toBe(1);
  });

  it("disconnect stops forwarding and unsubscribes the listeners", async () => {
    const bus = new EventBus();
    const engine = engineWithDigestWorkflow();
    const wiring = new WorkflowEventWiring(bus, engine);
    wiring.connect();
    expect(wiring.currentBus().subscriberCount("digest.published")).toBe(1);

    wiring.disconnect();
    expect(wiring.isConnected()).toBe(false);
    expect(wiring.currentBus().subscriberCount("digest.published")).toBe(0);

    // Emitting now delivers to nobody.
    const summary = await wiring.currentBus().emit(eventBuilders.digestPublished("digest-y", NOW));
    expect(summary.total).toBe(0);
    expect(engine.findWorkflow("wf-digest")?.status).toBe("pending");
  });

  it("connect is idempotent", () => {
    const bus = new EventBus();
    const engine = createProductionWorkflowEngine();
    const wiring = new WorkflowEventWiring(bus, engine);
    wiring.connect();
    wiring.connect();
    expect(wiring.currentBus().subscriberCount("digest.published")).toBe(1);
  });

  it("fire never throws even for unknown event kinds", async () => {
    const bus = new EventBus();
    const engine = createProductionWorkflowEngine();
    const wiring = new WorkflowEventWiring(bus, engine);
    wiring.connect();
    const result = await wiring.fire(createAppEvent({ type: "workflow.triggered", entityId: "w", now: NOW }));
    expect(result.skipped).toBe(true);
  });
});

describe("wireWorkflowTriggers", () => {
  it("returns a connected wiring", () => {
    const bus = new EventBus();
    const wiring = wireWorkflowTriggers(bus, createProductionWorkflowEngine());
    expect(wiring).toBeInstanceOf(WorkflowEventWiring);
    expect(wiring.isConnected()).toBe(true);
  });
});
