/**
 * Phase 5J STEP 7 — background pipeline handler tests.
 */
import { describe, expect, it } from "vitest";
import { createPipelineDigestHandler, PIPELINE_MEMORY_TITLE, PIPELINE_USER_ID } from "@/lib/background/pipeline";
import { createProductionDigestEngine } from "@/lib/digest/production";
import { createProductionActionEngine } from "@/lib/actions/production";
import { createProductionWorkflowEngine, type WorkflowEngine } from "@/lib/workflows/production";
import { WorkflowManager } from "@/lib/workflows/manager";
import { createWorkflow, createWorkflowStep } from "@/lib/workflows/types";
import type { JobExecutionContext } from "@/lib/jobs/types";

const NOW = "2026-08-10T08:00:00.000Z";

/** A context shaped like the job executor's handler context. */
function handlerContext(now = NOW): JobExecutionContext {
  return {
    job: {
      id: "bg-pipeline-digest",
      name: "Pipeline",
      status: "running",
      priority: "normal",
      trigger: "recurring",
      attempts: 1,
      maxAttempts: 1,
      createdAt: now,
      scheduledAt: now,
      archived: false,
      metadata: { tags: [] },
      executions: [],
    },
    attempt: 1,
    now,
  };
}

/** A workflow engine with one digest-triggered workflow stored and pending. */
function engineWithDigestWorkflow(): WorkflowEngine {
  const engine = createProductionWorkflowEngine();
  const step = createWorkflowStep({ id: "step-1", name: "Run", action: { kind: "job", jobId: "bg-daily-digest" } });
  const workflow = createWorkflow({
    id: "wf-on-digest",
    name: "On digest",
    trigger: { kind: "digest", event: "published" },
    steps: [step],
    createdAt: NOW,
    scheduledAt: NOW,
  });
  const { repository } = engine.manager.repository.add(workflow);
  return createProductionWorkflowEngine({ manager: new WorkflowManager(repository) });
}

describe("createPipelineDigestHandler", () => {
  it("runs the full pipeline: digest → action → workflow", async () => {
    const digestEngine = createProductionDigestEngine();
    const actionEngine = createProductionActionEngine();
    const workflowEngine = engineWithDigestWorkflow();

    const handler = createPipelineDigestHandler({ digestEngine, actionEngine, workflowEngine });
    const result = await handler(handlerContext());

    // 1. Digest Engine — a morning digest was built and stored.
    expect(result.digest.metadata.kind).toBe("morning");
    expect(digestEngine.findDigest(result.digest.id)).toBeDefined();

    // 2. Action Engine — the memory action planned and completed.
    expect(result.actions).toBeDefined();
    expect(result.actions?.results).toHaveLength(1);
    expect(result.actions?.results[0]?.status).toBe("completed");
    expect(actionEngine.listActions()).toHaveLength(1);
    expect(actionEngine.listStoredMemories()).toHaveLength(1);
    expect(actionEngine.listStoredMemories()[0]?.content).toContain(
      result.digest.metadata.kind.toUpperCase(),
    );

    // 3. Workflow Engine — the digest event triggered the workflow.
    expect(result.workflows.total).toBe(1);
    expect(result.workflows.completed).toBe(1);
    expect(workflowEngine.findWorkflow("wf-on-digest")?.status).toBe("completed");

    expect(result.error).toBeUndefined();
  });

  it("plans a single deterministic create_memory action", async () => {
    const actionEngine = createProductionActionEngine();
    const handler = createPipelineDigestHandler({
      digestEngine: createProductionDigestEngine(),
      actionEngine,
      workflowEngine: createProductionWorkflowEngine(),
    });
    const result = await handler(handlerContext());
    expect(result.actions?.results[0]?.actionId).toBeDefined();
    const action = actionEngine.findAction(result.actions!.results[0]!.actionId);
    expect(action?.type).toBe("create_memory");
    expect(action?.name).toBe(PIPELINE_MEMORY_TITLE);
  });

  it("isolates a failing action stage and still fires workflows", async () => {
    const workflowEngine = engineWithDigestWorkflow();
    // An action engine whose executePlan always fails (e.g. duplicate plan).
    const failingActionEngine = createProductionActionEngine();
    const spy = (failingActionEngine as unknown as { executePlan: unknown }).executePlan;
    (failingActionEngine as { executePlan: (...args: unknown[]) => Promise<never> }).executePlan = async () => {
      throw new Error("action boom");
    };

    const handler = createPipelineDigestHandler({
      digestEngine: createProductionDigestEngine(),
      actionEngine: failingActionEngine,
      workflowEngine,
    });
    const result = await handler(handlerContext());

    expect(result.error?.code).toBe("action_stage_failed");
    expect(result.error?.message).toBe("action boom");
    // The workflow stage still ran.
    expect(result.workflows.total).toBe(1);
    expect(workflowEngine.findWorkflow("wf-on-digest")?.status).toBe("completed");

    // Restore the spy for hygiene (not strictly necessary in tests).
    (failingActionEngine as { executePlan: unknown }).executePlan = spy;
  });

  it("isolates a failing workflow stage", async () => {
    const actionEngine = createProductionActionEngine();
    const failingWorkflow = createProductionWorkflowEngine();
    const original = (failingWorkflow as { triggerWorkflow: unknown }).triggerWorkflow;
    (failingWorkflow as { triggerWorkflow: (...args: unknown[]) => Promise<never> }).triggerWorkflow = async () => {
      throw new Error("workflow boom");
    };

    const handler = createPipelineDigestHandler({
      digestEngine: createProductionDigestEngine(),
      actionEngine,
      workflowEngine: failingWorkflow,
    });
    const result = await handler(handlerContext());

    expect(result.error?.code).toBe("workflow_stage_failed");
    expect(result.workflows.total).toBe(0);
    // The action stage still completed.
    expect(result.actions?.results[0]?.status).toBe("completed");

    (failingWorkflow as { triggerWorkflow: unknown }).triggerWorkflow = original;
  });

  it("is deterministic for identical inputs", async () => {
    const run = async () => {
      const handler = createPipelineDigestHandler({
        digestEngine: createProductionDigestEngine(),
        actionEngine: createProductionActionEngine(),
        workflowEngine: createProductionWorkflowEngine(),
      });
      return handler(handlerContext());
    };
    const first = await run();
    const second = await run();
    expect(first.digest.id).toBe(second.digest.id);
    expect(first.digest.summary).toBe(second.digest.summary);
    expect(first.actions?.results[0]?.actionId).toBe(second.actions?.results[0]?.actionId);
    expect(first.workflows.total).toBe(second.workflows.total);
  });

  it("uses the pipeline user id for every stage", async () => {
    const digestEngine = createProductionDigestEngine();
    const capturedUserIds: string[] = [];
    const original = digestEngine.buildMorningDigest.bind(digestEngine);
    digestEngine.buildMorningDigest = async (options) => {
      capturedUserIds.push(options.userId);
      return original(options);
    };

    const actionEngine = createProductionActionEngine();
    const handler = createPipelineDigestHandler({
      digestEngine,
      actionEngine,
      workflowEngine: createProductionWorkflowEngine(),
    });
    await handler(handlerContext());

    expect(capturedUserIds).toEqual([PIPELINE_USER_ID]);
    // The planned action plan carries the pipeline user id too.
    const stored = actionEngine.listActions()[0];
    expect(stored?.createdAt).toBe(NOW);
  });
});
