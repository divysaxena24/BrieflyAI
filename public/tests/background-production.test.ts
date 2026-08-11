/**
 * Phase 5J STEP 7 — background pipeline production tests.
 */
import { describe, expect, it } from "vitest";
import {
  PIPELINE_JOB_ID,
  PIPELINE_JOB_NAME,
  createPipelineJobInput,
  createProductionPipelineJobEngine,
  getProductionPipelineJobEngine,
  pipelineJob,
  runPipelineJobs,
} from "@/lib/background/production";
import { createProductionDigestEngine } from "@/lib/digest/production";
import { createProductionActionEngine } from "@/lib/actions/production";
import { createProductionWorkflowEngine } from "@/lib/workflows/production";
import { WorkflowManager } from "@/lib/workflows/manager";
import { createWorkflow, createWorkflowStep } from "@/lib/workflows/types";

const NOW = "2026-08-10T08:00:00.000Z";

describe("createPipelineJobInput", () => {
  it("builds a deterministic recurring job with the stable id", () => {
    const input = createPipelineJobInput(NOW);
    expect(input.id).toBe(PIPELINE_JOB_ID);
    expect(input.name).toBe(PIPELINE_JOB_NAME);
    expect(input.trigger).toBe("recurring");
    expect(input.schedule?.everyMs).toBe(3_600_000);
    expect(input.createdAt).toBe(NOW);
    expect(input.scheduledAt).toBe(NOW);
  });
});

describe("createProductionPipelineJobEngine", () => {
  it("seeds the pipeline job and exposes it", () => {
    const engine = createProductionPipelineJobEngine({ now: () => NOW });
    expect(engine.manager.has(PIPELINE_JOB_ID)).toBe(true);
    expect(pipelineJob(engine)?.status).toBe("pending");
  });

  it("does not seed the legacy digest job", () => {
    const engine = createProductionPipelineJobEngine({ now: () => NOW });
    expect(engine.manager.has("bg-daily-digest")).toBe(false);
  });

  it("runs the pipeline job through the runner (recurring re-arms)", async () => {
    const engine = createProductionPipelineJobEngine({ now: () => NOW });
    const summary = await engine.runScheduled(NOW);
    expect(summary.total).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    // Recurring completion re-arms to the next occurrence.
    expect(pipelineJob(engine)?.status).toBe("pending");
    expect(pipelineJob(engine)?.scheduledAt).not.toBe(NOW);
  });

  it("executes the full pipeline inside the job handler", async () => {
    const digestEngine = createProductionDigestEngine();
    const actionEngine = createProductionActionEngine();
    const workflowEngine = createProductionWorkflowEngine();
    const step = createWorkflowStep({ id: "step-1", name: "Run", action: { kind: "job", jobId: PIPELINE_JOB_ID } });
    const workflow = createWorkflow({
      id: "wf-pipeline",
      name: "On pipeline digest",
      trigger: { kind: "digest", event: "published" },
      steps: [step],
      createdAt: NOW,
      scheduledAt: NOW,
    });
    const { repository } = workflowEngine.manager.repository.add(workflow);
    const workflowSeeded = createProductionWorkflowEngine({ manager: new WorkflowManager(repository) });

    const engine = createProductionPipelineJobEngine({
      now: () => NOW,
      digestEngine,
      actionEngine,
      workflowEngine: workflowSeeded,
    });
    const summary = await engine.runScheduled(NOW);

    expect(summary.completed).toBe(1);
    // The digest stage stored a digest.
    expect(digestEngine.count()).toBe(1);
    // The action stage stored a memory.
    expect(actionEngine.listStoredMemories().length).toBe(1);
    // The workflow stage ran the workflow.
    expect(workflowSeeded.findWorkflow("wf-pipeline")?.status).toBe("completed");
  });

  it("never throws on a failing handler (job executor isolates)", async () => {
    const failingDigest = createProductionDigestEngine();
    const original = (failingDigest as { buildMorningDigest: unknown }).buildMorningDigest;
    (failingDigest as { buildMorningDigest: (...args: unknown[]) => Promise<never> }).buildMorningDigest = async () => {
      throw new Error("digest boom");
    };
    const engine = createProductionPipelineJobEngine({
      now: () => NOW,
      digestEngine: failingDigest,
    });
    const summary = await engine.runScheduled(NOW);
    expect(summary.total).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(0);
    expect(pipelineJob(engine)?.status).toBe("failed");
    (failingDigest as { buildMorningDigest: unknown }).buildMorningDigest = original;
  });
});

describe("runPipelineJobs / singleton", () => {
  it("is a stable singleton", () => {
    expect(getProductionPipelineJobEngine()).toBe(getProductionPipelineJobEngine());
  });

  it("runPipelineJobs returns a run summary (never throws)", async () => {
    const summary = await runPipelineJobs({ now: NOW });
    expect(typeof summary.total).toBe("number");
    expect(summary.completed + summary.failed + summary.cancelled).toBe(summary.total);
  });

  it("completed pipeline runs are re-armed (no duplicate execution on re-run at the same time)", async () => {
    const engine = createProductionPipelineJobEngine({ now: () => NOW });
    await engine.runScheduled(NOW);
    await engine.runScheduled(NOW);
    // The re-armed job is due strictly after NOW, so the second pass runs nothing.
    const second = await engine.runScheduled(NOW);
    expect(second.total).toBe(0);
  });
});
