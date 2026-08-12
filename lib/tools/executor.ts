/**
 * AI Tool layer — tool executor.
 *
 * Executes an immutable `ExecutionPlan` against a `ToolRegistry`:
 *
 * - Deterministic wave scheduling: at each wave, every step whose
 *   dependencies have completed successfully runs concurrently
 *   (`Promise.all`); the next wave starts only when the current one settles.
 *   Ready steps run in declared plan order, so execution is deterministic.
 * - Dependencies gate execution: a step runs only after every step in its
 *   `dependsOn` succeeded. A failed step cascades: every dependent step is
 *   never executed and reports `failure` with code `dependency_failed`.
 * - Error isolation: a throwing/failing step never fails the plan — it
 *   produces a structured `failure` result while independent steps continue.
 * - Timeout: an optional per-step `timeoutMs` aborts a step's execution.
 * - Cancellation: an optional whole-plan `AbortSignal` cancels pending and
 *   in-flight steps (`cancelled` status).
 * - No retries, no logging — execution only.
 *
 * Results are returned in declared plan order (one per step), so callers can
 * map outputs deterministically.
 */

import { AppError } from "@/lib/errors";
import type { ExecutionPlan, ExecutionStep } from "./plan";
import type { ToolRegistry } from "./registry";
import type { ToolContext } from "./types";

/** Outcome of a single planned step. */
export type ToolStepStatus = "success" | "failure" | "cancelled";

/** Structured error attached to a failed or cancelled step. */
export interface ToolError {
  /** Stable machine-readable code, e.g. "timeout", "unknown_tool". */
  readonly code: string;
  /** Human-readable detail. */
  readonly message: string;
  /**
   * HTTP status when the underlying failure was an AppError (e.g. 404 for a
   * missing repository, 401 for an expired integration session). Absent for
   * executor-internal failures (timeout, cancellation, …).
   */
  readonly status?: number;
}

/** Result of executing one planned step. */
export interface StepResult {
  /** The step id this result belongs to. */
  readonly stepId: string;
  /** The tool id the step invoked. */
  readonly toolId: string;
  readonly status: ToolStepStatus;
  /** Tool output on success. */
  readonly output?: unknown;
  /** Failure/cancellation detail when not successful. */
  readonly error?: ToolError;
  /** Wall-clock duration of the step in milliseconds. */
  readonly durationMs: number;
}

/** Outcome of executing an entire plan. */
export interface ExecutionResult {
  /** The plan id that was executed. */
  readonly planId: string;
  /** One result per plan step, in declared plan order. */
  readonly results: readonly StepResult[];
  readonly succeededStepIds: readonly string[];
  readonly failedStepIds: readonly string[];
  readonly cancelledStepIds: readonly string[];
}

/** Options accepted by {@link ToolExecutor.execute}. */
export interface ExecutorOptions {
  /** Per-step execution timeout in milliseconds (none when omitted). */
  readonly timeoutMs?: number;
  /** Whole-plan cancellation signal. */
  readonly signal?: AbortSignal;
}

/** Error thrown internally when a step exceeds its timeout. */
export class ToolTimeoutError extends Error {
  constructor(message = "Tool execution timed out") {
    super(message);
    this.name = "ToolTimeoutError";
  }
}

/** Error thrown internally when a step is cancelled via the plan signal. */
export class ToolCancelledError extends Error {
  constructor(message = "Tool execution cancelled") {
    super(message);
    this.name = "ToolCancelledError";
  }
}

/**
 * Executes immutable execution plans against a tool registry.
 */
export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  /**
   * Execute `plan` and return one structured result per step.
   *
   * Steps run in waves: independent steps run concurrently, dependent steps
   * wait for their dependencies. Failing steps cascade to their dependents
   * (reported as `dependency_failed`, never executed). A cancelled plan marks
   * every not-yet-executed step as `cancelled`.
   *
   * The plan is never mutated; each execution is independent and
   * deterministic for identical plans and tool behavior.
   *
   * Plans are expected to come from `createExecutionPlan` (validated and
   * acyclic). A structurally-invalid hand-built plan degrades gracefully:
   * steps that can never become ready are reported as `cancelled` rather
   * than executed.
   */
  async execute(plan: ExecutionPlan, options: ExecutorOptions = {}): Promise<ExecutionResult> {
    const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
    const dependents = new Map<string, string[]>();
    for (const step of plan.steps) {
      for (const dependency of step.dependsOn) {
        const list = dependents.get(dependency) ?? [];
        list.push(step.stepId);
        dependents.set(dependency, list);
      }
    }

    const results = new Map<string, StepResult>();
    const executed = new Set<string>();
    const failed = new Set<string>();
    const cancelled = new Set<string>();

    let frontier = plan.steps.filter((step) => step.dependsOn.length === 0);

    while (frontier.length > 0) {
      if (options.signal?.aborted) {
        for (const step of plan.steps) {
          if (results.has(step.stepId)) continue;
          const result = this.cancelledResult(step, "Plan was cancelled");
          results.set(step.stepId, result);
          cancelled.add(step.stepId);
        }
        break;
      }

      const wave = await Promise.all(frontier.map((step) => this.runStep(step, options)));
      const newlyFailed: string[] = [];

      for (let index = 0; index < frontier.length; index += 1) {
        const step = frontier[index];
        const result = wave[index];
        results.set(step.stepId, result);
        executed.add(step.stepId);
        if (result.status === "failure") {
          failed.add(step.stepId);
          newlyFailed.push(step.stepId);
        } else if (result.status === "cancelled") {
          cancelled.add(step.stepId);
        }
      }

      // Cascade: dependents of failed steps can never run.
      const cascadeQueue = [...newlyFailed];
      while (cascadeQueue.length > 0) {
        const failedStepId = cascadeQueue.shift() ?? "";
        for (const dependentId of dependents.get(failedStepId) ?? []) {
          if (results.has(dependentId)) continue;
          const dependent = byId.get(dependentId);
          if (!dependent) continue;
          const result = this.dependencyFailureResult(dependent, failedStepId);
          results.set(dependentId, result);
          failed.add(dependentId);
          cascadeQueue.push(dependentId);
        }
      }

      frontier = plan.steps.filter(
        (step) =>
          !results.has(step.stepId) &&
          step.dependsOn.every(
            (dependency) =>
              executed.has(dependency) || failed.has(dependency) || cancelled.has(dependency),
          ),
      );
    }

    const orderedResults = plan.steps.map((step) => results.get(step.stepId) ?? this.cancelledResult(step, "Step was not reached"));
    return {
      planId: plan.id,
      results: orderedResults,
      succeededStepIds: orderedResults.filter((r) => r.status === "success").map((r) => r.stepId),
      failedStepIds: orderedResults.filter((r) => r.status === "failure").map((r) => r.stepId),
      cancelledStepIds: orderedResults.filter((r) => r.status === "cancelled").map((r) => r.stepId),
    };
  }

  /**
   * Run a single step: check cancellation, resolve the tool, validate the
   * input against the tool's schema, then execute with deadline support.
   * Always returns a `StepResult` — never throws.
   */
  private async runStep(step: ExecutionStep, options: ExecutorOptions): Promise<StepResult> {
    const startedAt = Date.now();

    if (options.signal?.aborted) {
      return this.cancelledResult(step, "Plan was cancelled before this step started");
    }

    const tool = this.registry.get(step.toolId);
    if (!tool) {
      return this.failureResult(step, "unknown_tool", `No tool registered with id "${step.toolId}"`, startedAt);
    }

    const parsed = tool.inputSchema.safeParse(step.input);
    if (!parsed.success) {
      return this.failureResult(step, "invalid_input", "Step input does not match the tool's input schema", startedAt);
    }

    const toolContext: ToolContext = { signal: options.signal };

    try {
      // A tool that throws synchronously (instead of returning a rejected
      // promise) is caught here and isolated like any other failure.
      const execution = Promise.resolve(tool.execute(parsed.data, toolContext));
      const output = await this.withDeadline(execution, options);
      return {
        stepId: step.stepId,
        toolId: step.toolId,
        status: "success",
        output,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (err instanceof ToolTimeoutError) {
        return this.failureResult(step, "timeout", `Step timed out after ${options.timeoutMs ?? 0}ms`, startedAt);
      }
      if (err instanceof ToolCancelledError) {
        return this.cancelledResult(step, "Step was cancelled", startedAt);
      }
      // Preserve AppError code + status so auth/not-found failures surface
      // cleanly through the orchestrator (e.g. a Discord session that needs
      // reconnecting, a GitHub repo that was not found).
      if (err instanceof AppError) {
        return this.failureResult(step, err.code ?? "execution_error", err.message, startedAt, err.status);
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.failureResult(step, "execution_error", message, startedAt);
    }
  }

  /**
   * Race a tool execution against the per-step timeout and the plan's
   * cancellation signal. When neither is configured, await directly.
   */
  private withDeadline<T>(promise: Promise<T>, options: ExecutorOptions): Promise<T> {
    const { timeoutMs, signal } = options;
    if (timeoutMs === undefined && signal === undefined) return promise;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectOutcome: (reason: ToolTimeoutError | ToolCancelledError) => void = () => undefined;
    const outcome = new Promise<never>((_, reject) => {
      rejectOutcome = reject;
    });

    const onExternalAbort = () => rejectOutcome(new ToolCancelledError());
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => rejectOutcome(new ToolTimeoutError()), timeoutMs);
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onExternalAbort();
      } else {
        signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    return Promise.race([promise, outcome]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    });
  }

  private failureResult(step: ExecutionStep, code: string, message: string, startedAt: number, status?: number): StepResult {
    return {
      stepId: step.stepId,
      toolId: step.toolId,
      status: "failure",
      error: { code, message, ...(status !== undefined ? { status } : {}) },
      durationMs: Date.now() - startedAt,
    };
  }

  private cancelledResult(step: ExecutionStep, message: string, startedAt?: number): StepResult {
    return {
      stepId: step.stepId,
      toolId: step.toolId,
      status: "cancelled",
      error: { code: "cancelled", message },
      // An in-flight step that was cancelled carries its elapsed time; steps
      // cancelled before starting (or never reached) report 0ms.
      durationMs: startedAt === undefined ? 0 : Date.now() - startedAt,
    };
  }

  private dependencyFailureResult(step: ExecutionStep, failedDependencyId: string): StepResult {
    return {
      stepId: step.stepId,
      toolId: step.toolId,
      status: "failure",
      error: { code: "dependency_failed", message: `Dependency step "${failedDependencyId}" failed` },
      durationMs: 0,
    };
  }
}
