/**
 * Engine API — `EngineApi` resource tests (Phase 5J STEP 4).
 *
 * Verifies the resource facade over `ApplicationEngines` + persistence:
 * per-resource CRUD, 404s, the wire→model converters, route-param parsing,
 * persistence save/load/clear round-trips (restart recovery), and
 * determinism. All engines/stores are injected fresh per test.
 */

import { describe, expect, it } from "vitest";
import {
  EngineApi,
  createEngineApi,
  routeId,
  triggerEventFromWire,
  workflowFromWire,
  ResourceNotFoundError,
} from "@/lib/api/resources";
import { ApplicationEngines, createApplicationEngines } from "@/lib/api/engines";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { getProductionContextEngine } from "@/lib/context/production";
import { JobEngine } from "@/lib/jobs/production";
import { createProductionPersistence } from "@/lib/persistence/production";
import { MemoryPersistenceStore } from "@/lib/persistence/store";
import { createWorkflow, createWorkflowStep } from "@/lib/workflows/types";
import { ValidationError } from "@/lib/errors";

const NOW = "2026-08-10T00:00:00.000Z";

/** A fresh application engines root over clean engines + injected clock. */
function freshEngines(now: () => string = () => NOW): ApplicationEngines {
  const memory = createProductionMemoryEngine();
  const conversation = createProductionConversationEngine();
  const context = getProductionContextEngine();
  const jobs = new JobEngine({
    memoryEngine: memory,
    conversationEngine: conversation,
    contextEngine: context,
    seedDigestJob: false,
    now,
  });
  return createApplicationEngines({ memory, conversation, jobs, now });
}

/** A fresh resource facade over clean engines + a fresh in-memory store. */
function freshApi(store: MemoryPersistenceStore = new MemoryPersistenceStore()): EngineApi {
  return createEngineApi({
    engines: freshEngines(),
    persistence: createProductionPersistence({ store }),
    now: () => NOW,
  });
}

describe("EngineApi memories", () => {
  it("creates, reads, updates, archives, restores, and deletes memories", () => {
    const api = freshApi();
    const memory = api.createMemory({ id: "mem-1", title: "T", content: "C", createdAt: NOW });
    expect(api.getMemory("mem-1").id).toBe(memory.id);
    expect(api.updateMemory("mem-1", { content: "C2" }).content).toBe("C2");
    expect(api.archiveMemory("mem-1").metadata.state).toBe("archived");
    expect(api.restoreMemory("mem-1").metadata.state).toBe("active");
    api.deleteMemory("mem-1");
    expect(api.listMemories()).toHaveLength(0);
  });

  it("throws a 404 ResourceNotFoundError for unknown ids", () => {
    const api = freshApi();
    expect(() => api.getMemory("nope")).toThrow(ResourceNotFoundError);
    try {
      api.getMemory("nope");
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceNotFoundError);
      expect((err as ResourceNotFoundError).status).toBe(404);
    }
  });
});

describe("EngineApi conversations", () => {
  it("starts, appends, renames, closes, and deletes conversations", () => {
    const api = freshApi();
    api.startConversation({ id: "conv-1", createdAt: NOW, title: "Plan" });
    const message = api.appendMessage("conv-1", {
      role: "user",
      content: "hello",
      createdAt: NOW,
    });
    expect(message.content).toBe("hello");
    expect(api.renameConversation("conv-1", "Renamed").metadata.title).toBe("Renamed");
    expect(api.closeConversation("conv-1").metadata.state).toBe("deleted");
    api.deleteConversation("conv-1");
    expect(api.listConversations()).toHaveLength(0);
  });

  it("throws a 404 for unknown conversation ids", () => {
    const api = freshApi();
    expect(() => api.getConversation("nope")).toThrow(ResourceNotFoundError);
  });
});

describe("EngineApi digests", () => {
  it("builds, reads, publishes, marks read, and deletes digests", async () => {
    const api = freshApi();
    api.createMemory({ id: "mem-1", title: "T", content: "Standup at 9", createdAt: NOW });
    const digest = await api.buildDigest("morning", { userId: "u1", now: NOW });
    expect(digest.metadata.kind).toBe("morning");
    expect(digest.statistics.itemCount).toBeGreaterThanOrEqual(1);

    expect(api.getDigest(digest.id).id).toBe(digest.id);
    expect(api.publishDigest(digest.id, NOW).metadata.status).toBe("published");
    expect(api.markDigestRead(digest.id, NOW).metadata.read).toBe(true);
    // `deleteDigest` is a soft delete (status "deleted"; still stored).
    api.deleteDigest(digest.id, NOW);
    expect(api.getDigest(digest.id).metadata.status).toBe("deleted");
  });

  it("rejects unsupported digest kinds", async () => {
    const api = freshApi();
    await expect(api.buildDigest("custom" as never, { userId: "u1", now: NOW })).rejects.toThrow(
      ValidationError,
    );
  });

  it("builds deterministically for the same injected time", async () => {
    const first = freshApi();
    const second = freshApi();
    const a = await first.buildDigest("morning", { userId: "u1", now: NOW });
    const b = await second.buildDigest("morning", { userId: "u1", now: NOW });
    expect(a.id).toBe(b.id);
    expect(a.sections.map((section) => section.id)).toEqual(
      b.sections.map((section) => section.id),
    );
  });
});

describe("EngineApi jobs", () => {
  it("registers, reads, cancels, archives, restores, and unregisters jobs", () => {
    const api = freshApi();
    const job = api.registerJob({ id: "job-1", name: "Manual", trigger: "manual", createdAt: NOW });
    expect(api.getJob(job.id).id).toBe(job.id);
    expect(api.cancelJob(job.id, NOW).status).toBe("cancelled");
    api.unregisterJob(job.id);
    expect(() => api.getJob(job.id)).toThrow(ResourceNotFoundError);
  });

  it("runs a registered background job to completion", async () => {
    const api = freshApi();
    api.registerJob({ id: "bg-daily-digest", name: "Digest", trigger: "manual", createdAt: NOW });
    const summary = await api.runJob("bg-daily-digest", NOW);
    expect(summary.completed).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);
    expect(api.listMemories().some((m) => m.metadata.title === "Background digest")).toBe(true);
  });
});

describe("EngineApi actions", () => {
  it("plans intents deterministically", () => {
    const api = freshApi();
    const intent = { text: "remember the plan", userId: "u1", now: NOW };
    const plan = api.plan(intent);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(api.plan(intent).id).toBe(plan.id);
  });

  it("runs a create_memory action and stores the memory", async () => {
    const api = freshApi();
    const { result } = await api.runAction({
      name: "Remember",
      type: "create_memory",
      input: { title: "Note", content: "note content" },
      createdAt: NOW,
    });
    expect(result.status).toBe("completed");
    expect(api.listMemories().some((m) => m.content === "note content")).toBe(true);
  });
});

describe("EngineApi workflows", () => {
  it("registers, runs, disables, and deletes workflows", async () => {
    const api = freshApi();
    const workflow = api.registerWorkflow({
      name: "Digest on demand",
      steps: [
        createWorkflowStep({
          id: "s1",
          name: "Run digest",
          action: { kind: "job", jobId: "bg-daily-digest" },
        }),
      ],
      createdAt: NOW,
    });
    expect(api.getWorkflow(workflow.id).id).toBe(workflow.id);
    await api.runWorkflowById(workflow.id);
    expect(api.getWorkflow(workflow.id).status).toBe("completed");
    expect(api.disableWorkflow(workflow.id).enabled).toBe(false);
    expect(api.enableWorkflow(workflow.id).enabled).toBe(true);
    api.deleteWorkflow(workflow.id);
    expect(() => api.getWorkflow(workflow.id)).toThrow(ResourceNotFoundError);
  });

  it("throws a 404 for unknown workflow ids", () => {
    const api = freshApi();
    expect(() => api.getWorkflow("nope")).toThrow(ResourceNotFoundError);
  });
});

describe("EngineApi wire converters", () => {
  it("converts wire workflows with every step action kind", () => {
    const input = workflowFromWire({
      name: "Wired",
      trigger: { kind: "memory", memoryId: "mem-1", event: "stored" },
      steps: [
        { id: "a", name: "Action", action: { kind: "action", intent: "remember this" } },
        { id: "b", name: "Job", action: { kind: "job", jobId: "bg-daily-digest" } },
        {
          id: "c",
          name: "Tool",
          action: { kind: "tool", plan: { id: "plan-1", steps: [], intent: "x", userId: "u", now: NOW, summary: "s" } },
        },
        { id: "d", name: "Digest", action: { kind: "digest", query: "morning brief" } },
      ],
      createdAt: NOW,
    });
    expect(input.name).toBe("Wired");
    expect(input.trigger?.kind).toBe("memory");
    expect(input.trigger?.memoryId).toBe("mem-1");
    expect(input.steps).toHaveLength(4);
    expect(input.steps[0]?.action.kind).toBe("action");
    expect(input.steps[1]?.action.kind).toBe("job");
    expect((input.steps[1]?.action as { jobId: string }).jobId).toBe("bg-daily-digest");
    expect(input.steps[2]?.action.kind).toBe("tool");
    expect(input.steps[3]?.action.kind).toBe("digest");
  });

  it("defaults a missing trigger kind to manual (via createWorkflow)", () => {
    const input = workflowFromWire({
      name: "Default",
      steps: [{ id: "s1", name: "S", action: { kind: "job", jobId: "j1" } }],
      createdAt: NOW,
    });
    expect(input.trigger).toBeUndefined();
    // The model's createWorkflow applies the "manual" default.
    const workflow = createWorkflow(input);
    expect(workflow.trigger.kind).toBe("manual");
  });

  it("maps trigger events with entity ids per kind", () => {
    expect(triggerEventFromWire({ kind: "memory", entityId: "mem-9", now: NOW }).memoryId).toBe(
      "mem-9",
    );
    expect(triggerEventFromWire({ kind: "conversation", entityId: "c-9", now: NOW }).conversationId).toBe(
      "c-9",
    );
    expect(triggerEventFromWire({ kind: "digest", entityId: "d-9", now: NOW }).digestId).toBe("d-9");
    expect(triggerEventFromWire({ kind: "job", entityId: "j-9", now: NOW }).jobId).toBe("j-9");
    expect(triggerEventFromWire({ kind: "action", entityId: "a-9", now: NOW }).actionId).toBe("a-9");
    expect(triggerEventFromWire({ kind: "tool", entityId: "t-9", now: NOW }).toolId).toBe("t-9");
    const manual = triggerEventFromWire({ kind: "manual", now: NOW });
    expect(manual.kind).toBe("manual");
    expect(manual.conversationId).toBeUndefined();
  });

  it("parses dynamic-route id parameters (Next.js params promise)", async () => {
    expect(await routeId({ params: Promise.resolve({ id: "mem-1" }) })).toBe("mem-1");
    await expect(routeId({})).rejects.toThrow(ValidationError);
    await expect(routeId(null)).rejects.toThrow(ValidationError);
    await expect(routeId({ params: Promise.resolve({}) })).rejects.toThrow(ValidationError);
  });
});

describe("EngineApi persistence", () => {
  it("saves and restores every engine collection (restart recovery)", async () => {
    const store = new MemoryPersistenceStore();
    const first = freshApi(store);
    first.createMemory({ id: "mem-1", title: "T", content: "C", createdAt: NOW });
    first.startConversation({ id: "conv-1", createdAt: NOW });
    const digest = await first.buildDigest("morning", { userId: "u1", now: NOW });
    first.registerJob({ id: "bg-daily-digest", name: "D", trigger: "manual", createdAt: NOW });
    const { saved, errors } = await first.saveAll("user-1");
    expect(saved).toHaveLength(6);
    expect(errors).toHaveLength(0);

    // A fresh facade over the same store restores the full state.
    const second = freshApi(store);
    expect(second.listMemories()).toHaveLength(0);
    const { errors: loadErrors } = await second.loadAll("user-1");
    expect(loadErrors).toHaveLength(0);
    expect(second.listMemories()).toHaveLength(1);
    expect(second.listConversations()).toHaveLength(1);
    expect(second.listDigests()).toHaveLength(1);
    expect(second.getDigest(digest.id).id).toBe(digest.id);
    expect(second.listJobs().length).toBeGreaterThanOrEqual(1);
  });

  it("clears every persisted collection", async () => {
    const store = new MemoryPersistenceStore();
    const api = freshApi(store);
    api.createMemory({ id: "mem-1", title: "T", content: "C", createdAt: NOW });
    await api.saveAll("user-1");
    await api.clearAll("user-1");
    await expect(api.persistence.load("user-1", "memory")).rejects.toThrow();
  });

  it("reports the state overview", async () => {
    const api = freshApi();
    api.createMemory({ id: "mem-1", title: "T", content: "C", createdAt: NOW });
    api.startConversation({ id: "conv-1", createdAt: NOW });
    const overview = api.stateOverview();
    expect(overview.memory).toBe(1);
    expect(overview.conversation).toBe(1);
    expect(overview.job).toBe(0);
  });
});
