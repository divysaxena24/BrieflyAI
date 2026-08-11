/**
 * Phase 5J — Persistence & Application Integration end-to-end test.
 *
 * Verifies the complete production pipeline through the application
 * composition root:
 *
 * ```text
 * conversation → memory → context → planner → tool executor → actions
 *   → jobs → digest → workflow → delivery
 * ```
 *
 * plus persistence + restart recovery, event-driven workflow triggering,
 * channel delivery, determinism, immutability, failure isolation, and
 * 1000-object datasets. All engines/stores/buses are injected fresh.
 */

import { describe, expect, it } from "vitest";
import { createEngineApi, type EngineApi } from "@/lib/api/resources";
import { createApplicationEngines, type ApplicationEngines } from "@/lib/api/engines";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { getProductionContextEngine } from "@/lib/context/production";
import { JobEngine } from "@/lib/jobs/production";
import { createProductionPersistence } from "@/lib/persistence/production";
import { MemoryPersistenceStore } from "@/lib/persistence/store";
import type { CollectionKind, PersistenceStore } from "@/lib/persistence/types";
import { createProductionEventBus } from "@/lib/events/production";
import { wireWorkflowTriggersDynamic } from "@/lib/events/wiring";
import { eventBuilders } from "@/lib/events/types";
import { createProductionChannelPublisher } from "@/lib/delivery/production";
import {
  createChannelRecipient,
  type ChannelSendInput,
  type ChannelSendOutput,
  type ChannelSender,
} from "@/lib/delivery/types";
import { formatDigest } from "@/lib/digest/delivery";
import { createWorkflow, createWorkflowStep } from "@/lib/workflows/types";
import type { CreateMemoryInput } from "@/lib/memory/types";

const NOW = "2026-08-10T00:00:00.000Z";
const USER = "user-1";

/** Fresh application engines over clean engines + injected clock. */
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

/** Fresh resource facade over clean engines + an in-memory store. */
function freshApi(store: PersistenceStore = new MemoryPersistenceStore()): EngineApi {
  return createEngineApi({
    engines: freshEngines(),
    persistence: createProductionPersistence({ store }),
    now: () => NOW,
  });
}

/** A recording fake sender for a channel. */
class RecordingSender implements ChannelSender {
  readonly received: ChannelSendInput[] = [];

  constructor(readonly channel: ChannelSender["channel"]) {}

  async send(input: ChannelSendInput): Promise<ChannelSendOutput> {
    this.received.push(input);
    return { ok: true, message: `sent-${input.recipient.address}` };
  }
}

/** A store that fails writes for one collection kind (failure isolation). */
class ThrowingStore implements PersistenceStore {
  constructor(
    private readonly inner: PersistenceStore,
    private readonly failingKind: CollectionKind,
  ) {}

  read(scope: string, kind: CollectionKind) {
    return this.inner.read(scope, kind);
  }

  async write(scope: string, kind: CollectionKind, collection: unknown): Promise<void> {
    if (kind === this.failingKind) {
      throw new Error(`write failed for ${kind}`);
    }
    return this.inner.write(scope, kind, collection as never);
  }

  clear(scope: string, kind: CollectionKind): Promise<void> {
    return this.inner.clear(scope, kind);
  }
}

/**
 * Bulk-remember `count` deterministic memories. The inputs are plain
 * `CreateMemoryInput` objects (NOT `createMemory` results — a `Memory`
 * carries its title/createdAt under `metadata`, so re-using one as an input
 * would store memories without those fields).
 */
function bulkMemories(count: number, prefix = "bulk"): CreateMemoryInput[] {
  const inputs: CreateMemoryInput[] = [];
  for (let index = 0; index < count; index += 1) {
    inputs.push({
      id: `mem-${prefix}-${index}`,
      title: `${prefix} memory ${index}`,
      content: `Content of ${prefix} memory number ${index}`,
      createdAt: NOW,
    });
  }
  return inputs;
}

describe("Phase 5J end-to-end", () => {
  it("runs the complete pipeline: conversation → memory → context → planner → actions → job → digest → workflow → delivery", async () => {
    const store = new MemoryPersistenceStore();
    const api = freshApi(store);

    // 1. Conversation.
    api.startConversation({ id: "conv-1", createdAt: NOW, title: "Sprint planning" });
    api.appendMessage("conv-1", {
      role: "user",
      content: "Remember the quarterly report is due Friday",
      createdAt: NOW,
    });

    // 2. Memory.
    api.createMemory({
      id: "mem-1",
      title: "Quarterly report",
      content: "Quarterly report due Friday",
      createdAt: NOW,
    });

    // 3. Context (gathers memories + conversation into a deterministic prompt).
    const prompt = await api.engines.context.buildPrompt({
      retrievalQuery: { userId: USER, query: "report" },
      tokenBudget: 1000,
      userQuery: "report",
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);

    // 4–6. Planner → Action Executor (tool plans run inside the actions).
    const plan = api.plan({
      text: "remember the quarterly report",
      userId: USER,
      now: NOW,
      conversationId: "conv-1",
    });
    expect(plan.actions.length).toBeGreaterThan(0);
    const { result: planResult } = await api.executePlan(plan);
    expect(planResult.results.length).toBe(plan.actions.length);
    // The planned create_memory action stored a memory (reconciled into the root).
    const memoryCountAfterPlan = api.listMemories().length;
    expect(memoryCountAfterPlan).toBeGreaterThanOrEqual(2);

    // 7. Job: run the background digest job (gather → record → digest memory).
    api.registerJob({
      id: "bg-daily-digest",
      name: "Digest",
      trigger: "manual",
      createdAt: NOW,
    });
    const jobSummary = await api.runJob("bg-daily-digest", NOW);
    expect(jobSummary.completed).toBeGreaterThanOrEqual(1);
    expect(jobSummary.failed).toBe(0);
    // The background digest job records a memory; snapshot the count so the
    // restart-recovery assertion only accounts for the workflow's memory.
    const memoryCountAfterJob = api.listMemories().length;

    // 8. Digest: build + publish.
    const digest = await api.buildDigest("morning", { userId: USER, now: NOW });
    expect(digest.statistics.itemCount).toBeGreaterThan(0);
    api.publishDigest(digest.id, NOW);
    expect(api.getDigest(digest.id).metadata.status).toBe("published");

    // 9. Workflow: digest-triggered workflow with an action step.
    // The action step uses an explicit, distinctly-named create_memory
    // request: action ids are deterministic and derive from name/type/trigger/
    // priority/timestamps (not content), so re-planning a default-named
    // create_memory at the same `now` as the earlier pipeline plan would
    // collide with the already-stored action.
    const workflow = api.registerWorkflow({
      name: "On digest published",
      trigger: { kind: "digest", digestId: digest.id, event: "published" },
      steps: [
        createWorkflowStep({
          id: "s1",
          name: "Remember digest",
          action: {
            kind: "action",
            intent: "remember the morning digest was published",
            requests: [
              {
                type: "create_memory",
                name: "Remember morning digest",
                input: {
                  title: "Morning digest published",
                  content: "The morning digest was published",
                },
              },
            ],
          },
        }),
      ],
      createdAt: NOW,
    });
    const triggered = await api.triggerWorkflow({
      kind: "digest",
      digestId: digest.id,
      event: "published",
      now: NOW,
    });
    expect(triggered.total).toBe(1);
    expect(triggered.completed).toBe(1);
    expect(api.getWorkflow(workflow.id).status).toBe("completed");

    // 10. Delivery: format + dispatch through a channel publisher.
    const markdown = formatDigest(digest, "markdown") as string;
    expect(markdown.startsWith("# ")).toBe(true);
    const json = JSON.parse(formatDigest(digest, "json") as string);
    expect(json.id).toBe(digest.id);

    const sender = new RecordingSender("email");
    const publisher = createProductionChannelPublisher([sender]);
    const summary = await publisher.deliver(
      [createChannelRecipient({ channel: "email", address: "ops@example.com" })],
      digest,
    );
    expect(summary.total).toBe(1);
    expect(summary.ok).toBe(1);
    expect(sender.received).toHaveLength(1);
    expect(sender.received[0]?.content).toContain("MEMORIES");

    // A channel without a sender yields a structured, non-throwing outcome.
    const missing = await publisher.deliver(
      [createChannelRecipient({ channel: "telegram", address: "chat-1" })],
      digest,
    );
    expect(missing.ok).toBe(0);
    expect(missing.outcomes[0]?.error?.code).toBe("channel_sender_missing");

    // 11. Persistence + restart recovery (fresh facade over the same store).
    const messageCount = api.getConversation("conv-1").messages.length;
    const { saved, errors } = await api.saveAll(USER);
    expect(saved).toHaveLength(6);
    expect(errors).toHaveLength(0);

    const second = freshApi(store);
    expect(second.listMemories()).toHaveLength(0);
    const { errors: loadErrors } = await second.loadAll(USER);
    expect(loadErrors).toHaveLength(0);
    expect(second.listMemories().length).toBe(memoryCountAfterJob + 1);
    expect(second.listConversations()).toHaveLength(1);
    expect(second.getConversation("conv-1").messages.length).toBe(messageCount);
    expect(second.listDigests()).toHaveLength(1);
    expect(second.getDigest(digest.id).id).toBe(digest.id);
    expect(second.listWorkflows()).toHaveLength(1);
    expect(second.getWorkflow(workflow.id).status).toBe("completed");
  });

  it("propagates application events into automatic workflow triggering", async () => {
    const api = freshApi();
    api.startConversation({ id: "conv-1", createdAt: NOW });

    // Register the conversation-triggered workflow first, then wire the bus
    // to the *current* workflow engine via a live getter (rebuild-safe).
    api.registerWorkflow({
      name: "On conversation updated",
      trigger: { kind: "conversation", conversationId: "conv-1", event: "updated" },
      steps: [
        createWorkflowStep({
          id: "s1",
          name: "Remember",
          action: { kind: "action", intent: "remember the conversation was updated" },
        }),
      ],
      createdAt: NOW,
    });

    const bus = createProductionEventBus();
    const wiring = wireWorkflowTriggersDynamic(bus, () => api.engines.workflows);

    // A memory mutation rebuilds the engine root; the dynamic wiring still
    // fires through the current workflow engine.
    api.createMemory({ id: "mem-1", title: "T", content: "C", createdAt: NOW });
    const fired = await wiring.fire(eventBuilders.conversationUpdated("conv-1", NOW));
    expect(fired.skipped).toBeUndefined();
    expect(fired.error).toBeUndefined();
    expect(fired.summary?.completed).toBe(1);
    expect(api.listWorkflows()[0]?.status).toBe("completed");
    wiring.disconnect();
  });

  it("scales to 1000 memories and persists the full state", async () => {
    const store = new MemoryPersistenceStore();
    const api = freshApi(store);
    const added = api.bulkCreateMemories(bulkMemories(1000, "scale"));
    expect(added).toHaveLength(1000);
    expect(api.stateOverview().memory).toBe(1000);

    const digest = await api.buildDigest("morning", { userId: USER, now: NOW });
    expect(digest.statistics.itemCount).toBeGreaterThan(0);

    const { saved, errors } = await api.saveAll(USER);
    expect(saved).toHaveLength(6);
    expect(errors).toHaveLength(0);

    const second = freshApi(store);
    await second.loadAll(USER);
    expect(second.stateOverview().memory).toBe(1000);
    // Deterministic id stability across the round-trip.
    expect(second.listMemories()[0]?.id).toBe("mem-scale-0");
  });

  it("is deterministic: identical pipelines produce identical artifacts", async () => {
    const run = async () => {
      const api = freshApi();
      api.startConversation({ id: "conv-1", createdAt: NOW, title: "Same" });
      api.appendMessage("conv-1", {
        role: "user",
        content: "remember the standup",
        createdAt: NOW,
      });
      api.createMemory({ id: "mem-1", title: "Standup", content: "standup at 9", createdAt: NOW });
      const digest = await api.buildDigest("morning", { userId: USER, now: NOW });
      return { digestId: digest.id, prompt: await api.engines.context.buildPrompt({ retrievalQuery: { userId: USER, query: "x" }, tokenBudget: 500, userQuery: "x" }) };
    };

    const first = await run();
    const second = await run();
    expect(first.digestId).toBe(second.digestId);
    expect(first.prompt).toBe(second.prompt);
  });

  it("isolates failures: a failing workflow step does not stop independent steps", async () => {
    const api = freshApi();
    const workflow = createWorkflow({
      name: "Mixed outcome",
      steps: [
        createWorkflowStep({
          id: "bad",
          name: "Malformed digest step",
          // A digest step without a template makes the built-in digest
          // handler throw at runtime — a genuine step failure. (An unknown
          // job id would NOT fail: `runManual` skips unknown jobs.)
          action: { kind: "digest" },
        }),
        createWorkflowStep({
          id: "good",
          name: "Remember",
          action: { kind: "action", intent: "remember the independent step ran" },
        }),
      ],
      createdAt: NOW,
    });
    api.engines.registerWorkflow(workflow);
    const { result } = await api.engines.runWorkflow(workflow, { now: NOW });
    expect(result.failedStepIds).toContain("bad");
    // The independent action step still ran (failure isolation).
    expect(api.listMemories().some((m) => m.content.includes("independent"))).toBe(true);
    expect(api.engines.workflows.manager.find(workflow.id)?.status).toBe("failed");
  });

  it("isolates persistence failures per collection", async () => {
    const inner = new MemoryPersistenceStore();
    const store = new ThrowingStore(inner, "memory");
    const api = freshApi(store);
    api.createMemory({ id: "mem-1", title: "T", content: "C", createdAt: NOW });
    api.startConversation({ id: "conv-1", createdAt: NOW });

    const { saved, errors } = await api.saveAll(USER);
    // The memory write failed and is reported; the other five collections saved.
    expect(saved).toHaveLength(5);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("memory");
  });
});
