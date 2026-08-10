/**
 * Workflow Engine — workflow executor.
 *
 * Executes immutable `WorkflowPlan`s with dependency-injected behavior,
 * mirroring the `ToolExecutor`/`ActionExecutor` wave-scheduling conventions:
 *
 * - **Deterministic wave scheduling**: at each wave, every step whose
 *   dependencies have completed successfully runs concurrently
 *   (`Promise.all`); the next wave starts only when the current one settles.
 *   Ready steps run in planned order, so execution is deterministic.
 * - **Dependencies gate execution**: a step runs only after every step in its
 *   `dependsOn` succeeded. A failed step cascades: every dependent step is
 *   never executed and reports `failed` with code `dependency_failed`.
 * - **Failure isolation**: a throwing/timing-out step handler never fails the
 *   caller — it produces a structured `WorkflowStepResult` while independent
 *   steps continue. A step whose planning failed (`step.error`) is reported
 *   as `failed` without invoking its handler, and cascades to its dependents.
 * - **Timeout**: an optional per-step timeout aborts a hanging handler
 *   (`failed` with code `timeout`).
 * - **Cancellation**: an optional whole-plan `AbortSignal` cancels pending
 *   and in-flight steps (`cancelled` status).
 * - **Retries**: retries run only when configured (`maxAttempts > 1`); the
 *   delay between attempts is `retryDelayMs` (default 0) performed through an
 *   injected `sleep` so tests stay deterministic.
 * - **Step handler registry**: handlers are resolved by action *kind* from an
 *   immutable `WorkflowStepHandlerRegistry` (injected); an unknown kind fails
 *   structurally with code `unknown_step_kind` — it never throws.
 * - **No logging** — execution only.
 *
 * The executor mirrors the job/action executor conventions: wall-clock
 * durations use `Date.now()` (matching the existing layers), while every
 * *time* value handed to handlers (`context.now`) is injected.
 */

import type { WorkflowPlan, PlannedWorkflowStep } from "./planner";
import type {
  WorkflowActionKind,
  WorkflowError,
} from "./types";

/** A workflow step handler: performs the step's work and returns its output. */
export type WorkflowStepHandler = (context: WorkflowStepContext) => Promise<unknown>;

/** A registered handler entry (kind + handler pair). */
export interface WorkflowHandlerEntry {
  readonly kind: WorkflowActionKind;
  readonly handler: WorkflowStepHandler;
}

/** Runtime context handed to a step handler. */
export interface WorkflowStepContext {
  /** The plan being executed. */
  readonly plan: WorkflowPlan;
  /** The step being executed. */
  readonly step: PlannedWorkflowStep;
  /** 1-based attempt number within the step's run. */
  readonly attempt: number;
  /** Abort signal observed by the executor; handlers may honor it. */
  readonly signal?: AbortSignal;
  /** ISO-8601 UTC timestamp of the run start (injected, deterministic). */
  readonly now: string;
  /** Application-level user id, when known from the surrounding plan. */
  readonly userId?: string;
}

/** Outcome of executing one planned step. */
export interface WorkflowStepResult {
  /** The step id this result belongs to. */
  readonly stepId: string;
  readonly kind: WorkflowActionKind;
  readonly status: "completed" | "failed" | "skipped" | "cancelled";
  /** The handler's output on success. */
  readonly output?: unknown;
  /** Failure/cancellation detail when not completed. */
  readonly error?: WorkflowError;
  /** Wall-clock duration of the step's run in milliseconds. */
  readonly durationMs: number;
}

/** Outcome of executing an entire workflow plan. */
export interface WorkflowExecutionResult {
  /** The plan id that was executed. */
  readonly planId: string;
  /** One result per plan step, in declared plan order (skipped included). */
  readonly results: readonly WorkflowStepResult[];
  readonly completedStepIds: readonly string[];
  readonly failedStepIds: readonly string[];
  readonly skippedStepIds: readonly string[];
  readonly cancelledStepIds: readonly string[];
}

/** Options accepted by {@link WorkflowExecutor.executePlan}. */
export interface WorkflowExecuteOptions {
  /** Whole-plan cancellation signal. */
  readonly signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds (overrides the step's). */
  readonly timeoutMs?: number;
  /** Injected current time passed to handlers (deterministic). */
  readonly now?: string;
  /** Application-level user id forwarded to handlers. */
  readonly userId?: string;
}

/** Options accepted by the {@link WorkflowExecutor} constructor. */
export interface WorkflowExecutorOptions {
  /** Retry-delay sleeper; defaults to a `setTimeout`-based wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Default injected current time; defaults to the wall clock. */
  readonly now?: () => string;
}

/** Error thrown internally when an attempt exceeds its timeout. */
export class WorkflowTimeoutError extends Error {
  constructor(message = "Workflow step execution timed out") {
    super(message);
    this.name = "WorkflowTimeoutError";
  }
}

/** Error thrown internally when an attempt is cancelled via the run signal. */
export class WorkflowCancelledError extends Error {
  constructor(message = "Workflow step execution cancelled") {
    super(message);
    this.name = "WorkflowCancelledError";
  }
}

/**
 * Immutable collection of registered workflow step handlers.
 *
 * `register` and `unregister` return a *new* registry rather than mutating
 * the current one, and `list()` exposes a snapshot — mirroring the
 * `ActionHandlerRegistry`/`JobHandlerRegistry` conventions.
 */
export class WorkflowStepHandlerRegistry {
  private readonly entries: ReadonlyMap<WorkflowActionKind, WorkflowStepHandler>;

  constructor(handlers: readonly WorkflowHandlerEntry[] = []) {
    const map = new Map<WorkflowActionKind, WorkflowStepHandler>();
    for (const entry of handlers) {
      if (map.has(entry.kind)) {
        throw new Error(`Workflow handler registry already contains handler "${entry.kind}"`);
      }
      map.set(entry.kind, entry.handler);
    }
    this.entries = map;
  }

  /** Return a new registry with `handler` registered under `kind`. */
  register(kind: WorkflowActionKind, handler: WorkflowStepHandler): WorkflowStepHandlerRegistry {
    if (this.entries.has(kind)) {
      throw new Error(`Workflow handler registry already contains handler "${kind}"`);
    }
    return new WorkflowStepHandlerRegistry([
      ...[...this.entries.entries()].map(([key, value]) => ({ kind: key, handler: value })),
      { kind, handler },
    ]);
  }

  /**
   * Register many handlers at once (functional update; first duplicate
   * throws). Returns a new registry — the receiver is never mutated.
   */
  registerMany(handlers: readonly WorkflowHandlerEntry[]): WorkflowStepHandlerRegistry {
    const merged = new Map<WorkflowActionKind, WorkflowStepHandler>(this.entries);
    for (const entry of handlers) {
      if (merged.has(entry.kind)) {
        throw new Error(`Workflow handler registry already contains handler "${entry.kind}"`);
      }
      merged.set(entry.kind, entry.handler);
    }
    return new WorkflowStepHandlerRegistry(
      [...merged.entries()].map(([kind, handler]) => ({ kind, handler })),
    );
  }

  /** Return a new registry without the handler `kind` (no-op when absent). */
  unregister(kind: WorkflowActionKind): WorkflowStepHandlerRegistry {
    if (!this.entries.has(kind)) return this;
    return new WorkflowStepHandlerRegistry(
      [...this.entries.entries()]
        .filter(([key]) => key !== kind)
        .map(([key, value]) => ({ kind: key, handler: value })),
    );
  }

  /** Look up a handler by kind; `undefined` when not registered. */
  get(kind: WorkflowActionKind): WorkflowStepHandler | undefined {
    return this.entries.get(kind);
  }

  /** Whether a handler for `kind` is registered. */
  has(kind: WorkflowActionKind): boolean {
    return this.entries.has(kind);
  }

  /** Snapshot of the registered handlers in registration order. */
  list(): readonly WorkflowHandlerEntry[] {
    return [...this.entries.entries()].map(([kind, handler]) => ({ kind, handler }));
  }
}

/** The default retry-delay sleeper (real time — overridable in tests). */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Executes workflow plans with timeout, cancellation, and retry support.
 */
export class WorkflowExecutor {
  private readonly registry: WorkflowStepHandlerRegistry;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(registry: WorkflowStepHandlerRegistry, options: WorkflowExecutorOptions = {}) {
    this.registry = registry;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Execute `plan` and return one structured result per step.
   *
   * Steps run in waves: independent steps run concurrently, dependent steps
   * wait for their dependencies. Failing steps cascade to their dependents
   * (reported as `dependency_failed`, never executed). A cancelled plan marks
   * every not-yet-executed step as `cancelled`. Steps excluded by planning
   * (`plan.skippedStepIds`) are reported as `skipped` without running.
   *
   * The plan is never mutated; each execution is independent and
   * deterministic for identical plans, handlers, and injected time.
   */
  async executePlan(
    plan: WorkflowPlan,
    options: WorkflowExecuteOptions = {},
  ): Promise<WorkflowExecutionResult> {
    const skippedResults: WorkflowStepResult[] = plan.skippedSteps.map((step) => ({
      stepId: step.stepId,
      kind: step.kind,
      status: "skipped",
      durationMs: 0,
    }));

    const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
    const dependents = new Map<string, string[]>();
    for (const step of plan.steps) {
      for (const dependency of step.dependsOn) {
        const list = dependents.get(dependency) ?? [];
        list.push(step.stepId);
        dependents.set(dependency, list);
      }
    }

    const results = new Map<string, WorkflowStepResult>();
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

      const wave = await Promise.all(frontier.map((step) => this.runStep(step, plan, options)));
      const newlyFailed: string[] = [];

      for (let index = 0; index < frontier.length; index += 1) {
        const step = frontier[index];
        const result = wave[index];
        results.set(step.stepId, result);
        executed.add(step.stepId);
        if (result.status === "failed") {
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

    const orderedResults = plan.steps.map(
      (step) => results.get(step.stepId) ?? this.cancelledResult(step, "Step was not reached"),
    );
    return {
      planId: plan.id,
      results: [...orderedResults, ...skippedResults],
      completedStepIds: orderedResults
        .filter((result) => result.status === "completed")
        .map((result) => result.stepId),
      failedStepIds: orderedResults
        .filter((result) => result.status === "failed")
        .map((result) => result.stepId),
      skippedStepIds: plan.skippedSteps.map((step) => step.stepId),
      cancelledStepIds: orderedResults
        .filter((result) => result.status === "cancelled")
        .map((result) => result.stepId),
    };
  }

  /**
   * Execute a single planned step and return one structured outcome.
   *
   * - A step whose planning failed (`step.error`) is reported as `failed`
   *   with that error — its handler is never invoked.
   * - Resolves the handler by `step.kind`; an unknown kind yields a `failed`
   *   outcome with code `unknown_step_kind`.
   * - Runs up to `step.maxAttempts` attempts (no retries unless configured).
   *   A failed attempt retries after `retryDelayMs` (via the injected
   *   `sleep`); a cancelled run stops immediately.
   * - The plan is never mutated; each execution is independent and
   *   deterministic for identical plans, handlers, and injected time.
   */
  private async runStep(
    step: PlannedWorkflowStep,
    plan: WorkflowPlan,
    options: WorkflowExecuteOptions,
  ): Promise<WorkflowStepResult> {
    const startedAt = Date.now();

    if (step.error !== undefined) {
      return {
        stepId: step.stepId,
        kind: step.kind,
        status: "failed",
        error: step.error,
        durationMs: Date.now() - startedAt,
      };
    }

    const handler = this.registry.get(step.kind);
    if (handler === undefined) {
      return {
        stepId: step.stepId,
        kind: step.kind,
        status: "failed",
        error: {
          code: "unknown_step_kind",
          message: `No handler registered for workflow step kind "${step.kind}"`,
        },
        durationMs: Date.now() - startedAt,
      };
    }

    if (options.signal?.aborted) {
      return {
        stepId: step.stepId,
        kind: step.kind,
        status: "cancelled",
        error: { code: "cancelled", message: "Workflow was cancelled before execution" },
        durationMs: Date.now() - startedAt,
      };
    }

    const maxAttempts = Math.max(1, step.maxAttempts);
    const timeoutMs = options.timeoutMs ?? step.timeoutMs;
    const retryDelayMs = step.retryDelayMs ?? 0;
    const now = options.now ?? this.now();

    let lastError: WorkflowError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) {
        return {
          stepId: step.stepId,
          kind: step.kind,
          status: "cancelled",
          error: { code: "cancelled", message: "Workflow was cancelled" },
          durationMs: Date.now() - startedAt,
        };
      }

      const context: WorkflowStepContext = {
        plan,
        step,
        attempt,
        signal: options.signal,
        now,
        ...(options.userId !== undefined ? { userId: options.userId } : {}),
      };

      try {
        const output = await this.runAttempt(handler, context, timeoutMs, options.signal);
        return {
          stepId: step.stepId,
          kind: step.kind,
          status: "completed",
          output,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        if (err instanceof WorkflowCancelledError) {
          return {
            stepId: step.stepId,
            kind: step.kind,
            status: "cancelled",
            error: { code: "cancelled", message: err.message },
            durationMs: Date.now() - startedAt,
          };
        }
        lastError =
          err instanceof WorkflowTimeoutError
            ? { code: "timeout", message: `Step timed out after ${timeoutMs ?? 0}ms` }
            : {
                code: "handler_error",
                message: err instanceof Error ? err.message : String(err),
              };
        if (attempt < maxAttempts) {
          await this.sleep(retryDelayMs);
        }
      }
    }

    return {
      stepId: step.stepId,
      kind: step.kind,
      status: "failed",
      error: lastError,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Run a single attempt, racing the handler against the per-attempt timeout
   * and the run's cancellation signal. When neither is configured, await
   * directly. A handler that throws synchronously is caught here and
   * isolated like any other failure.
   */
  private async runAttempt(
    handler: WorkflowStepHandler,
    context: WorkflowStepContext,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const execution = Promise.resolve().then(() => handler(context));

    if (timeoutMs === undefined && signal === undefined) return execution;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectOutcome: (reason: WorkflowTimeoutError | WorkflowCancelledError) => void = () => undefined;
    const outcome = new Promise<never>((_, reject) => {
      rejectOutcome = reject;
    });

    const onExternalAbort = (): void => rejectOutcome(new WorkflowCancelledError());
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => rejectOutcome(new WorkflowTimeoutError()), timeoutMs);
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onExternalAbort();
      } else {
        signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    return Promise.race([execution, outcome]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    });
  }

  private cancelledResult(step: PlannedWorkflowStep, message: string): WorkflowStepResult {
    return {
      stepId: step.stepId,
      kind: step.kind,
      status: "cancelled",
      error: { code: "cancelled", message },
      durationMs: 0,
    };
  }

  private dependencyFailureResult(
    step: PlannedWorkflowStep,
    failedDependencyId: string,
  ): WorkflowStepResult {
    return {
      stepId: step.stepId,
      kind: step.kind,
      status: "failed",
      error: {
        code: "dependency_failed",
        message: `Dependency step "${failedDependencyId}" failed`,
      },
      durationMs: 0,
    };
  }
}
