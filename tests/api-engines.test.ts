/**
 * Engine API — `ApplicationEngines` composition-root tests (Phase 5J STEP 4).
 *
 * Verifies the application-level engine root: successor application,
 * bottom-up graph rebuild, digest sources wired to the app engines, the
 * memory/conversation reconcile after execution paths, determinism, and
 * `replaceAll` (persistence restore).
 */

import { describe, expect, it } from "vitest";
import { ApplicationEngines, createApplicationEngines } from "@/lib/api/engines";
import { createProductionMemoryEngine } from "@/lib/memory/production";
import { createProductionConversationEngine } from "@/lib/conversation/production";
import { getProductionContextEngine } from "@/lib/context/production";
import { JobEngine } from "@/lib/jobs/production";
import { createWorkflow, createWorkflowStep } from "@/lib/workflows/types";
import { createAction } from "@/lib/actions/types";
import { createExecutionPlan } from "@/lib/tools/plan";

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

describe("ApplicationEngines", () => {
  it("seeds all six engines and rebuilds the composition graph", () => {
    const engines = freshEngines();
    expect(engines.memory).toBeDefined();
    expect(engines.conversation).toBeDefined();
    expect(engines.digest).toBeDefined();
    expect(engines.jobs).toBeDefined();
    expect(engines.actions).toBeDefined();
    expect(engines.workflows).toBeDefined();
    expect(engines.context).toBeDefined();
    // Fresh root: empty collections, no seeded digest job.
    expect(engines.listMemories()).toHaveLength(0);
    expect(engines.listConversations()).toHaveLength(0);
    expect(engines.listJobs()).toHaveLength(0);
    expect(engines.listDigests()).toHaveLength(0);
    expect(engines.listActions()).toHaveLength(0);
    expect(engines.listWorkflows()).toHaveLength(0);
  });

  it("applies the memory successor and rebuilds the graph", () => {
    const engines = freshEngines();
    const memory = engines.createMemory({
      id: "mem-1",
      title: "Quarterly report",
      content: "The quarterly report is due Friday",
      createdAt: NOW,
    });
    expect(memory.id).toBe("mem-1");
    expect(engines.listMemories()).toHaveLength(1);
    // Graph consistency: the job root's memory engine observes the new memory.
    expect(engines.jobs.memoryEngine.listMemories()).toHaveLength(1);
    expect(engines.actions.memoryEngine.listMemories()).toHaveLength(1);
  });

  it("wires the digest sources to the app engines (memories appear in digests)", async () => {
    const engines = freshEngines();
    const empty = await engines.digest.buildMorningDigest({ userId: "u1", now: NOW });
    expect(empty.metadata.kind).toBe("morning");
    expect(empty.statistics.itemCount).toBe(0);

    engines.createMemory({
      id: "mem-2",
      title: "Standup",
      content: "Standup at 9am — prepare the demo",
      createdAt: NOW,
    });
    // A later timestamp avoids the deterministic id collision with the empty digest.
    const digest = await engines.digest.buildMorningDigest({
      userId: "u1",
      now: "2026-08-10T01:00:00.000Z",
    });
    expect(digest.statistics.itemCount).toBeGreaterThanOrEqual(1);
    expect(
      digest.sections.some((section) => section.category === "memories" && section.items.length > 0),
    ).toBe(true);
  });

  it("supports the full memory lifecycle through the root", () => {
    const engines = freshEngines();
    engines.createMemory({ id: "mem-3", title: "T", content: "C", createdAt: NOW });
    const updated = engines.updateMemory("mem-3", { content: "C2" });
    expect(updated.content).toBe("C2");
    engines.archiveMemory("mem-3");
    expect(engines.findMemory("mem-3")?.metadata.state).toBe("archived");
    engines.restoreMemory("mem-3");
    expect(engines.findMemory("mem-3")?.metadata.state).toBe("active");
    engines.deleteMemory("mem-3");
    expect(engines.findMemory("mem-3")).toBeUndefined();
  });

  it("supports the conversation lifecycle through the root", () => {
    const engines = freshEngines();
    engines.startConversation({ id: "conv-1", createdAt: NOW, title: "Planning" });
    const message = engines.appendMessage("conv-1", {
      role: "user",
      content: "Let's plan the sprint",
      createdAt: NOW,
    });
    expect(message.role).toBe("user");
    engines.renameConversation("conv-1", "Sprint planning");
    expect(engines.getConversation("conv-1")?.metadata.title).toBe("Sprint planning");
    engines.archiveConversation("conv-1");
    expect(engines.getConversation("conv-1")?.metadata.state).toBe("archived");
    engines.restoreConversation("conv-1");
    engines.closeConversation("conv-1");
    expect(engines.getConversation("conv-1")?.metadata.state).toBe("deleted");
    engines.deleteConversation("conv-1");
    expect(engines.getConversation("conv-1")).toBeUndefined();
  });

  it("runs a registered background job and reconciles stored memories into the app root", async () => {
    const engines = freshEngines();
    const job = engines.registerJob({
      id: "bg-daily-digest",
      name: "Digest",
      trigger: "manual",
      createdAt: NOW,
    });
    expect(engines.findJob(job.id)).toBeDefined();

    const summary = await engines.runJob(job.id, NOW);
    expect(summary.completed).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);
    // The digest handler stored a derived memory through the job root; the
    // reconcile step merged it into the app-level memory engine.
    const stored = engines.listMemories();
    expect(stored.some((memory) => memory.metadata.title === "Background digest")).toBe(true);
  });

  it("runs an action and reconciles the stored memory into the app root", async () => {
    const engines = freshEngines();
    const action = createAction({
      name: "Remember answer",
      type: "create_memory",
      input: { title: "Answer", content: "The answer is 42" },
      createdAt: NOW,
    });
    const { result } = await engines.runAction(action);
    expect(result.status).toBe("completed");
    expect(engines.listMemories().some((memory) => memory.content === "The answer is 42")).toBe(true);
  });

  it("plans an intent deterministically", () => {
    const engines = freshEngines();
    const intent = {
      text: "please remember to book the meeting",
      userId: "u1",
      now: NOW,
    };
    const first = engines.plan(intent);
    const second = engines.plan(intent);
    expect(first.actions.length).toBeGreaterThan(0);
    expect(first.id).toBe(second.id);
    expect(first.actions.map((action) => action.id)).toEqual(
      second.actions.map((action) => action.id),
    );
  });

  it("registers and runs a workflow with a job step", async () => {
    const engines = freshEngines();
    const workflow = createWorkflow({
      name: "Nightly digest",
      steps: [
        createWorkflowStep({
          id: "s1",
          name: "Run digest job",
          action: { kind: "job", jobId: "bg-daily-digest" },
        }),
      ],
      createdAt: NOW,
    });
    const registered = engines.registerWorkflow(workflow);
    expect(registered.id).toBe(workflow.id);

    const { result } = await engines.runWorkflow(registered, { now: NOW });
    expect(result).toBeDefined();
    expect(engines.workflows.manager.find(workflow.id)?.status).toBe("completed");

    engines.disableWorkflow(workflow.id);
    expect(engines.workflows.manager.find(workflow.id)?.enabled).toBe(false);
    engines.enableWorkflow(workflow.id);
    expect(engines.workflows.manager.find(workflow.id)?.enabled).toBe(true);
    engines.deleteWorkflow(workflow.id);
    expect(engines.workflows.manager.find(workflow.id)).toBeUndefined();
  });

  it("supports digest manager operations through the root", async () => {
    const engines = freshEngines();
    const digest = await engines.digest.buildMorningDigest({ userId: "u1", now: NOW });
    engines.publishDigest(digest.id, NOW);
    expect(engines.findDigest(digest.id)?.metadata.status).toBe("published");
    engines.markDigestRead(digest.id, NOW);
    expect(engines.findDigest(digest.id)?.metadata.read).toBe(true);
    engines.archiveDigest(digest.id, NOW);
    expect(engines.findDigest(digest.id)?.metadata.status).toBe("archived");
    // `deleteDigest` is a soft delete (status "deleted"; still stored).
    engines.deleteDigest(digest.id, NOW);
    expect(engines.findDigest(digest.id)?.metadata.status).toBe("deleted");
  });

  it("is deterministic: identical inputs produce identical workflow ids and digests", async () => {
    const first = freshEngines();
    const second = freshEngines();
    const input = {
      name: "Deterministic workflow",
      steps: [
        createWorkflowStep({
          id: "s1",
          name: "Step",
          action: {
            kind: "tool" as const,
            plan: createExecutionPlan({
              id: "plan-tool-1",
              steps: [{ stepId: "step-1", toolId: "tool-1", input: {}, dependsOn: [] }],
            }),
          },
        }),
      ],
      createdAt: NOW,
    };
    const a = first.registerWorkflow(createWorkflow(input));
    const b = second.registerWorkflow(createWorkflow(input));
    expect(a.id).toBe(b.id);

    const da = await first.digest.buildMorningDigest({ userId: "u1", now: NOW });
    const db = await second.digest.buildMorningDigest({ userId: "u1", now: NOW });
    expect(da.id).toBe(db.id);
  });

  it("replaceAll swaps every engine and re-wires the graph (restart recovery)", async () => {
    const source = freshEngines();
    source.createMemory({ id: "mem-9", title: "Restored", content: "content", createdAt: NOW });
    source.startConversation({ id: "conv-9", createdAt: NOW });

    const target = freshEngines();
    expect(target.listMemories()).toHaveLength(0);
    expect(target.listConversations()).toHaveLength(0);
    target.replaceAll(source.engines());
    expect(target.listMemories()).toHaveLength(1);
    expect(target.listConversations()).toHaveLength(1);
    // Graph re-wired over the swapped engines.
    expect(target.jobs.memoryEngine.listMemories()).toHaveLength(1);
  });
});
