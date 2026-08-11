import { describe, expect, it } from "vitest";
import {
  createBuiltInTriggerAdapters,
  selectWorkflowsForEvent,
  WorkflowTriggerRegistry,
} from "@/lib/workflows/triggers";
import {
  createWorkflow,
  createWorkflowStep,
  type Workflow,
  type WorkflowStep,
} from "@/lib/workflows/types";

const NOW = "2026-08-10T12:00:00.000Z";

function step(id: string): WorkflowStep {
  return createWorkflowStep({ id, name: `Step ${id}`, action: { kind: "job", jobId: "job-1" } });
}

function makeWorkflow(
  id: string,
  trigger: Workflow["trigger"],
  overrides: Partial<Parameters<typeof createWorkflow>[0]> = {},
): Workflow {
  return createWorkflow({
    id,
    name: `Workflow ${id}`,
    createdAt: NOW,
    trigger,
    steps: [step("s1")],
    ...overrides,
  });
}

const MANUAL = makeWorkflow("manual", { kind: "manual" });
const SCHEDULED = makeWorkflow("scheduled", {
  kind: "scheduled",
  schedule: { at: NOW },
});
const CONVERSATION = makeWorkflow("conversation", {
  kind: "conversation",
  conversationId: "conv-1",
});
const MEMORY = makeWorkflow("memory", { kind: "memory", memoryId: "mem-1" });
const DIGEST = makeWorkflow("digest", { kind: "digest", digestId: "dig-1" });
const JOB = makeWorkflow("job", { kind: "job", jobId: "job-1" });
const ACTION = makeWorkflow("action", { kind: "action", actionId: "action-1" });
const TOOL = makeWorkflow("tool", { kind: "tool", toolId: "tool-1" });

const ALL = [MANUAL, SCHEDULED, CONVERSATION, MEMORY, DIGEST, JOB, ACTION, TOOL];

function event(kind: Workflow["trigger"]["kind"], extra: Record<string, unknown> = {}) {
  return { kind, now: NOW, ...extra };
}

describe("built-in trigger adapters", () => {
  it("registers all eight adapters", () => {
    const adapters = createBuiltInTriggerAdapters();
    expect(adapters.map((adapter) => adapter.kind).sort()).toEqual([
      "action",
      "conversation",
      "digest",
      "job",
      "manual",
      "memory",
      "scheduled",
      "tool",
    ]);
  });

  it("manual fires on manual events only", () => {
    expect(selectWorkflowsForEvent(ALL, event("manual")).map((w) => w.id)).toEqual(["manual"]);
  });

  it("scheduled fires when the schedule is due", () => {
    const fired = selectWorkflowsForEvent(ALL, event("scheduled"));
    expect(fired.map((w) => w.id)).toEqual(["scheduled"]);
  });

  it("scheduled does not fire before the schedule", () => {
    const fired = selectWorkflowsForEvent(
      [SCHEDULED],
      event("scheduled", { now: "2026-08-10T11:00:00.000Z" }),
    );
    expect(fired).toEqual([]);
  });

  it("signal adapters fire only for their own kind", () => {
    expect(selectWorkflowsForEvent(ALL, event("conversation", { conversationId: "conv-1" })).map((w) => w.id)).toEqual(["conversation"]);
    expect(selectWorkflowsForEvent(ALL, event("memory", { memoryId: "mem-1" })).map((w) => w.id)).toEqual(["memory"]);
    expect(selectWorkflowsForEvent(ALL, event("digest", { digestId: "dig-1" })).map((w) => w.id)).toEqual(["digest"]);
    expect(selectWorkflowsForEvent(ALL, event("job", { jobId: "job-1" })).map((w) => w.id)).toEqual(["job"]);
    expect(selectWorkflowsForEvent(ALL, event("action", { actionId: "action-1" })).map((w) => w.id)).toEqual(["action"]);
    expect(selectWorkflowsForEvent(ALL, event("tool", { toolId: "tool-1" })).map((w) => w.id)).toEqual(["tool"]);
  });

  it("a pinned trigger ignores events about other entities", () => {
    const fired = selectWorkflowsForEvent(
      [CONVERSATION],
      event("conversation", { conversationId: "conv-2" }),
    );
    expect(fired).toEqual([]);
  });

  it("an unpinned trigger matches any event of its kind", () => {
    const unpinned = makeWorkflow("unpinned", { kind: "memory" });
    const fired = selectWorkflowsForEvent([unpinned], event("memory", { memoryId: "anything" }));
    expect(fired.map((w) => w.id)).toEqual(["unpinned"]);
  });

  it("an event qualifier narrows matching", () => {
    const completed = makeWorkflow("completed-only", {
      kind: "job",
      jobId: "job-1",
      event: "completed",
    });
    const fired = selectWorkflowsForEvent([completed], event("job", { jobId: "job-1", event: "completed" }));
    expect(fired.map((w) => w.id)).toEqual(["completed-only"]);
    const notFired = selectWorkflowsForEvent([completed], event("job", { jobId: "job-1", event: "started" }));
    expect(notFired).toEqual([]);
  });

  it("skips non-runnable workflows (completed/archived/disabled)", () => {
    const completed = makeWorkflow("done", { kind: "manual" }, { status: "completed" });
    const archived = makeWorkflow("archived", { kind: "manual" }, { archived: true });
    const disabled = makeWorkflow("disabled", { kind: "manual" }, { enabled: false });
    const fired = selectWorkflowsForEvent([completed, archived, disabled], event("manual"));
    expect(fired).toEqual([]);
  });

  it("an empty registry fires nothing", () => {
    const fired = selectWorkflowsForEvent(ALL, event("manual"), new WorkflowTriggerRegistry([]));
    expect(fired).toEqual([]);
  });
});

describe("WorkflowTriggerRegistry", () => {
  it("is immutable: register returns a successor without touching the receiver", () => {
    const registry = new WorkflowTriggerRegistry();
    const custom = { kind: "tool" as const, matches: () => true };
    const next = registry.register(custom);
    expect(next.has("tool")).toBe(true);
    expect(registry.has("tool")).toBe(false);
    expect(() => next.register(custom)).toThrow(/already contains/);
  });

  it("unregister removes an adapter functionally", () => {
    const registry = new WorkflowTriggerRegistry(createBuiltInTriggerAdapters());
    const next = registry.unregister("manual");
    expect(next.has("manual")).toBe(false);
    expect(registry.has("manual")).toBe(true);
  });

  it("get returns the registered adapter by kind", () => {
    const registry = new WorkflowTriggerRegistry(createBuiltInTriggerAdapters());
    expect(registry.get("digest")?.kind).toBe("digest");
    expect(registry.get("manual")).toBeDefined();
  });

  it("custom registries drive selection", () => {
    const registry = new WorkflowTriggerRegistry(createBuiltInTriggerAdapters());
    const fired = selectWorkflowsForEvent(ALL, event("manual"), registry);
    expect(fired.map((w) => w.id)).toEqual(["manual"]);
  });
});
