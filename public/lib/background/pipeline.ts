/**
 * Background pipeline — the Phase 5J background digest handler (STEP 7).
 *
 * Upgrades the Phase 5F background digest path: instead of the minimal
 * one-line `BackgroundDigest`, the pipeline job drives the *real* engines:
 *
 * ```text
 * Background Job
 *   → Digest Engine  (build the morning digest)
 *   → Action Engine  (plan + execute a deterministic memory action)
 *   → Workflow Engine (fire the digest event → trigger workflows)
 * ```
 *
 * The handler is a thin composition — it never reimplements orchestration;
 * every stage delegates to an injected engine. No LLM, no side effects
 * beyond the engines' own in-memory transitions. The handler never throws:
 * every failure is isolated into the structured `PipelineDigestResult`.
 *
 * The legacy `bg-daily-digest` handler in `lib/jobs/production.ts` is left
 * untouched (frozen per phase rules); this is the Phase 5J integration path.
 */

import type { Digest } from "@/lib/digest/types";
import { formatDigestAsPlain } from "@/lib/digest/delivery";
import type { DigestEngine } from "@/lib/digest/production";
import type { ActionEngine } from "@/lib/actions/production";
import type { ActionExecutionResult } from "@/lib/actions/executor";
import type { WorkflowEngine } from "@/lib/workflows/production";
import type { TriggerSummary } from "@/lib/workflows/production";
import type { JobHandler } from "@/lib/jobs/executor";

/** User id the pipeline gathers state for. */
export const PIPELINE_USER_ID = "background-pipeline";

/** Name of the pipeline's planned memory action. */
export const PIPELINE_MEMORY_TITLE = "Background AI digest";

/** The structured, deterministic result of one pipeline run. */
export interface PipelineDigestResult {
  /** The digest built by the Digest Engine. */
  readonly digest: Digest;
  /** The Action Engine result when a plan executed (undefined when none). */
  readonly actions?: ActionExecutionResult;
  /** The Workflow Engine trigger summary for the digest event. */
  readonly workflows: TriggerSummary;
  /** Structured failure detail when a stage failed (isolated). */
  readonly error?: { readonly code: string; readonly message: string };
}

/** Dependencies injected into the pipeline digest handler. */
export interface PipelineDigestDependencies {
  /** The Digest Engine used to build the morning digest. */
  readonly digestEngine: DigestEngine;
  /** The Action Engine used to plan + execute the memory action. */
  readonly actionEngine: ActionEngine;
  /** The Workflow Engine fired with the digest event. */
  readonly workflowEngine: WorkflowEngine;
}

/**
 * Build the background pipeline digest handler.
 *
 * Pipeline (deterministic given `now`):
 * 1. Build a morning digest through the Digest Engine.
 * 2. Plan a `create_memory` action carrying the digest summary and execute it
 *    through the Action Engine (the planner's content dedupe guarantees a
 *    fresh memory per run).
 * 3. Fire the `digest_published` event through the Workflow Engine's
 *    `triggerWorkflow` (STEP 6 semantics — no polling).
 *
 * Never throws: each stage failure is isolated into the result's `error`.
 */
export function createPipelineDigestHandler(
  deps: PipelineDigestDependencies,
): JobHandler {
  return async (context): Promise<PipelineDigestResult> => {
    const now = context.now;
    const userId = PIPELINE_USER_ID;

    // 1. Digest Engine — build the morning digest.
    const digest = await deps.digestEngine.buildMorningDigest({ userId, now });
    // The digest's plain-text rendering is its deterministic summary (the
    // existing delivery-layer formatter is reused — never reimplemented).
    const summary = formatDigestAsPlain(digest);

    // 2. Action Engine — plan + execute the memory action (deterministic).
    const plan = deps.actionEngine.planner.plan({
      text: `${PIPELINE_MEMORY_TITLE} ${now}`,
      userId,
      now,
      requests: [
        {
          type: "create_memory",
          name: PIPELINE_MEMORY_TITLE,
          input: { title: PIPELINE_MEMORY_TITLE, content: summary },
        },
      ],
    });

    let actions: ActionExecutionResult | undefined;
    let error: { code: string; message: string } | undefined;
    if (plan.actions.length > 0) {
      try {
        ({ result: actions } = await deps.actionEngine.executePlan(plan, {
          now,
          signal: context.signal,
        }));
      } catch (err) {
        error = {
          code: "action_stage_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // 3. Workflow Engine — fire the digest event.
    let workflows: TriggerSummary;
    try {
      workflows = await deps.workflowEngine.triggerWorkflow(
        {
          kind: "digest",
          digestId: digest.id,
          event: "published",
          now,
        },
        { signal: context.signal },
      );
    } catch (err) {
      workflows = {
        triggered: [],
        total: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      };
      if (error === undefined) {
        error = {
          code: "workflow_stage_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      digest,
      ...(actions !== undefined ? { actions } : {}),
      workflows,
      ...(error !== undefined ? { error } : {}),
    };
  };
}
