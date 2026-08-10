/**
 * Background pipeline — production composition (Phase 5J STEP 7).
 *
 * `createProductionPipelineJobEngine` composes the Phase 5J background job:
 * a `JobEngine` (reused wholesale from Phase 5F) whose handler registry adds
 * the pipeline digest handler over the production Digest/Action/Workflow
 * engines, with the recurring `bg-pipeline-digest` job pre-seeded into the
 * manager.
 *
 * ```text
 * JobManager (pipeline job seeded)
 *   → JobRunner → JobExecutor
 *       → bg-pipeline-digest handler
 *           → Digest Engine → Action Engine → Workflow Engine
 * ```
 *
 * Entry point: `runPipelineJobs()` → `runScheduled` (the pipeline job is
 * recurring; completed runs are re-armed by the runner). Note: `JobEngine.run`
 * is intentionally not used here because it seeds the legacy digest job.
 */

import { getProductionDigestEngine } from "@/lib/digest/production";
import type { DigestEngine } from "@/lib/digest/production";
import { getProductionActionEngine } from "@/lib/actions/production";
import type { ActionEngine } from "@/lib/actions/production";
import { getProductionWorkflowEngine } from "@/lib/workflows/production";
import type { WorkflowEngine } from "@/lib/workflows/production";
import {
  createProductionJobEngine,
  DIGEST_SCHEDULE_INTERVAL_MS,
  type JobEngineOptions,
} from "@/lib/jobs/production";
import type { JobEngine } from "@/lib/jobs/production";
import { JobHandlerRegistry } from "@/lib/jobs/executor";
import { JobManager } from "@/lib/jobs/manager";
import { JobRepository } from "@/lib/jobs/repository";
import { createJob, type CreateJobInput, type Job } from "@/lib/jobs/types";
import { createPipelineDigestHandler, type PipelineDigestResult } from "./pipeline";
import type { RunSummary } from "@/lib/jobs/runner";

/** Id of the recurring background pipeline job registered by the engine. */
export const PIPELINE_JOB_ID = "bg-pipeline-digest";

/** Human-readable name of the pipeline job. */
export const PIPELINE_JOB_NAME = "Background AI Digest Pipeline";

/**
 * Build the recurring pipeline job's registration input at `now`
 * (deterministic given `now`; the id is the explicit stable `PIPELINE_JOB_ID`).
 */
export function createPipelineJobInput(now: string): CreateJobInput {
  return {
    id: PIPELINE_JOB_ID,
    name: PIPELINE_JOB_NAME,
    priority: "normal",
    trigger: "recurring",
    schedule: { everyMs: DIGEST_SCHEDULE_INTERVAL_MS },
    maxAttempts: 1,
    createdAt: now,
    scheduledAt: now,
    metadata: { tags: ["background", "digest", "pipeline"] },
  };
}

/** Options accepted by {@link createProductionPipelineJobEngine}. */
export interface PipelineJobEngineOptions {
  /** Initial job manager (dependency injection); the pipeline job is seeded. */
  readonly manager?: JobManager;
  /** Digest Engine reused by the pipeline handler (production singleton). */
  readonly digestEngine?: DigestEngine;
  /** Action Engine reused by the pipeline handler (production singleton). */
  readonly actionEngine?: ActionEngine;
  /** Workflow Engine reused by the pipeline handler (production singleton). */
  readonly workflowEngine?: WorkflowEngine;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
  /** Forwarded to the underlying JobEngine (memory/conversation/context). */
  readonly jobOptions?: Omit<JobEngineOptions, "manager" | "handlerRegistry" | "now" | "seedDigestJob">;
}

/**
 * Build a fresh production pipeline job engine.
 *
 * Wires the pipeline digest handler (over the injected — or production —
 * Digest/Action/Workflow engines) and pre-seeds the recurring
 * `bg-pipeline-digest` job. The underlying `JobEngine` is reused wholesale;
 * only its handler registry and manager are injected. The legacy digest job
 * is not seeded (`seedDigestJob: false`).
 *
 * Note on determinism: when no `now` clock is injected, the seeded job's
 * timestamps come from the wall clock; inject a fixed `now` for fully
 * deterministic tests.
 */
export function createProductionPipelineJobEngine(
  options: PipelineJobEngineOptions = {},
): JobEngine {
  const now = options.now ?? (() => new Date().toISOString());
  const digestEngine = options.digestEngine ?? getProductionDigestEngine();
  const actionEngine = options.actionEngine ?? getProductionActionEngine();
  const workflowEngine = options.workflowEngine ?? getProductionWorkflowEngine();

  const manager =
    options.manager ??
    new JobManager(
      new JobRepository().add(createJob(createPipelineJobInput(now()))).repository,
    );

  const handlerRegistry = new JobHandlerRegistry().register(
    PIPELINE_JOB_ID,
    createPipelineDigestHandler({ digestEngine, actionEngine, workflowEngine }),
  );

  return createProductionJobEngine({
    ...options.jobOptions,
    manager,
    handlerRegistry,
    now,
    seedDigestJob: false,
  });
}

/**
 * The application's single production pipeline job engine instance.
 * Created once at module load.
 */
const productionPipelineJobEngine = createProductionPipelineJobEngine();

/** Return the application's single production pipeline job engine instance. */
export function getProductionPipelineJobEngine(): JobEngine {
  return productionPipelineJobEngine;
}

/** The pipeline job stored by the engine, or `undefined` before seeding. */
export function pipelineJob(engine: JobEngine = getProductionPipelineJobEngine()): Job | undefined {
  return engine.manager.find(PIPELINE_JOB_ID);
}

/** Options accepted by {@link runPipelineJobs}. */
export interface RunPipelineJobsOptions {
  /** Injected current time (deterministic); defaults to the engine clock. */
  readonly now?: string;
}

/**
 * Run the background pipeline: the application's Phase 5J background-jobs
 * entry point. Runs everything due through `runScheduled` (the recurring
 * pipeline job; completed runs are re-armed to the future).
 */
export function runPipelineJobs(
  options: RunPipelineJobsOptions = {},
): Promise<RunSummary> {
  return getProductionPipelineJobEngine().runScheduled(options.now);
}

/** Re-export the pipeline result type for convenience. */
export type { PipelineDigestResult } from "./pipeline";
