/**
 * AI Actions — action executor.
 *
 * Executes immutable `ActionPlan`s with dependency-injected behavior,
 * mirroring the `ToolExecutor` wave-scheduling conventions over the action
 * model:
 *
 * - **Deterministic wave scheduling**: at each wave, every action whose
 *   dependencies have completed successfully runs concurrently
 *   (`Promise.all`); the next wave starts only when the current one settles.
 *   Ready actions run in declared plan order, so execution is deterministic.
 * - **Dependencies gate execution**: an action runs only after every action
 *   in its `dependsOn` succeeded. A failed action cascades: every dependent
 *   action is never executed and reports `failed` with code
 *   `dependency_failed`.
 * - **Failure isolation**: a throwing/timing-out handler never fails the
 *   caller — it produces a structured `ActionStepResult` while independent
 *   actions continue.
 * - **Timeout**: an optional per-attempt timeout aborts a hanging handler
 *   (`failed` with code `timeout`).
 * - **Cancellation**: an optional whole-plan `AbortSignal` cancels pending
 *   and in-flight actions (`cancelled` status).
 * - **Retries**: retries run only when configured (`maxAttempts > 1`); the
 *   delay between attempts is `metadata.retryDelayMs` (default 0) performed
 *   through an injected `sleep` so tests stay deterministic.
 * - **Handler registry**: handlers are resolved by action *type* from an
 *   immutable `ActionHandlerRegistry` (injected); an unknown type fails
 *   structurally with code `unknown_action` — it never throws.
 * - **No logging** — execution only.
 *
 * The executor mirrors the `JobExecutor` conventions: wall-clock durations
 * use `Date.now()` (matching the existing tool/job layers), while every
 * *time* value handed to handlers (`context.now`) is injected.
 */

import type { ActionPlan } from "./planner";
import type {
  Action,
  ActionContext,
  ActionError,
  ActionType,
} from "./types";

/** An action handler: performs the action's work and returns its output. */
export type ActionHandler = (context: ActionContext) => Promise<unknown>;

/** A registered handler entry (type + handler pair). */
export interface ActionHandlerEntry {
  readonly type: ActionType;
  readonly handler: ActionHandler;
}

/** Outcome of executing one action (final attempt settles the status). */
export interface ActionStepResult {
  readonly actionId: string;
  readonly type: ActionType;
  /** The attempt number that settled the action. */
  readonly attempt: number;
  /** Total attempts made before settling. */
  readonly attemptsMade: number;
  readonly status: "completed" | "failed" | "cancelled";
  /** The handler's output on success. */
  readonly output?: unknown;
  /** Failure/cancellation detail when not completed. */
  readonly error?: ActionError;
  /** Wall-clock duration of the whole run in milliseconds. */
  readonly durationMs: number;
}

/** Outcome of executing an entire action plan. */
export interface ActionExecutionResult {
  /** The plan id that was executed. */
  readonly planId: string;
  /** One result per planned action, in declared plan order. */
  readonly results: readonly ActionStepResult[];
  readonly completedActionIds: readonly string[];
  readonly failedActionIds: readonly string[];
  readonly cancelledActionIds: readonly string[];
}

/** Options accepted by {@link ActionExecutor.execute} / {@link ActionExecutor.executePlan}. */
export interface ActionExecuteOptions {
  /** Whole-plan cancellation signal. */
  readonly signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds (overrides the action's metadata). */
  readonly timeoutMs?: number;
  /** Injected current time passed to handlers (deterministic). */
  readonly now?: string;
  /** Application-level user id forwarded to handlers (from the plan). */
  readonly userId?: string;
}

/** Options accepted by the {@link ActionExecutor} constructor. */
export interface ActionExecutorOptions {
  /** Retry-delay sleeper; defaults to a `setTimeout`-based wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Default injected current time; defaults to the wall clock. */
  readonly now?: () => string;
}

/** Error thrown internally when an attempt exceeds its timeout. */
export class ActionTimeoutError extends Error {
  constructor(message = "Action execution timed out") {
    super(message);
    this.name = "ActionTimeoutError";
  }
}

/** Error thrown internally when an attempt is cancelled via the run signal. */
export class ActionCancelledError extends Error {
  constructor(message = "Action execution cancelled") {
    super(message);
    this.name = "ActionCancelledError";
  }
}

/**
 * Immutable collection of registered action handlers.
 *
 * `register` and `unregister` return a *new* registry rather than mutating
 * the current one, and `list()` exposes a snapshot — mirroring the
 * `JobHandlerRegistry` conventions.
 */
export class ActionHandlerRegistry {
  private readonly entries: ReadonlyMap<ActionType, ActionHandler>;

  constructor(handlers: readonly ActionHandlerEntry[] = []) {
    const map = new Map<ActionType, ActionHandler>();
    for (const entry of handlers) {
      if (map.has(entry.type)) {
        throw new Error(`Action handler registry already contains handler "${entry.type}"`);
      }
      map.set(entry.type, entry.handler);
    }
    this.entries = map;
  }

  /** Return a new registry with `handler` registered under `type`. */
  register(type: ActionType, handler: ActionHandler): ActionHandlerRegistry {
    if (this.entries.has(type)) {
      throw new Error(`Action handler registry already contains handler "${type}"`);
    }
    return new ActionHandlerRegistry([
      ...[...this.entries.entries()].map(([key, value]) => ({ type: key, handler: value })),
      { type, handler },
    ]);
  }

  /**
   * Register many handlers at once (functional update; first duplicate
   * throws). Returns a new registry — the receiver is never mutated.
   */
  registerMany(handlers: readonly ActionHandlerEntry[]): ActionHandlerRegistry {
    const merged = new Map<ActionType, ActionHandler>(this.entries);
    for (const entry of handlers) {
      if (merged.has(entry.type)) {
        throw new Error(
          `Action handler registry already contains handler "${entry.type}"`,
        );
      }
      merged.set(entry.type, entry.handler);
    }
    return new ActionHandlerRegistry(
      [...merged.entries()].map(([type, handler]) => ({ type, handler })),
    );
  }

  /** Return a new registry without the handler `type` (no-op when absent). */
  unregister(type: ActionType): ActionHandlerRegistry {
    if (!this.entries.has(type)) return this;
    return new ActionHandlerRegistry(
      [...this.entries.entries()]
        .filter(([key]) => key !== type)
        .map(([key, value]) => ({ type: key, handler: value })),
    );
  }

  /** Look up a handler by type; `undefined` when not registered. */
  get(type: ActionType): ActionHandler | undefined {
    return this.entries.get(type);
  }

  /** Whether a handler for `type` is registered. */
  has(type: ActionType): boolean {
    return this.entries.has(type);
  }

  /** Snapshot of the registered handlers in registration order. */
  list(): readonly ActionHandlerEntry[] {
    return [...this.entries.entries()].map(([type, handler]) => ({ type, handler }));
  }
}

/** The default retry-delay sleeper (real time — overridable in tests). */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Executes action plans with timeout, cancellation, and retry support.
 */
export class ActionExecutor {
  private readonly registry: ActionHandlerRegistry;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(registry: ActionHandlerRegistry, options: ActionExecutorOptions = {}) {
    this.registry = registry;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Execute `plan` and return one structured result per action.
   *
   * Actions run in waves: independent actions run concurrently, dependent
   * actions wait for their dependencies. Failing actions cascade to their
   * dependents (reported as `dependency_failed`, never executed). A cancelled
   * plan marks every not-yet-executed action as `cancelled`.
   *
   * The plan is never mutated; each execution is independent and
   * deterministic for identical plans, handlers, and injected time.
   */
  async executePlan(
    plan: ActionPlan,
    options: ActionExecuteOptions = {},
  ): Promise<ActionExecutionResult> {
    const byId = new Map(plan.actions.map((action) => [action.id, action]));
    const dependents = new Map<string, string[]>();
    for (const action of plan.actions) {
      for (const dependency of action.dependsOn) {
        const list = dependents.get(dependency) ?? [];
        list.push(action.id);
        dependents.set(dependency, list);
      }
    }

    const results = new Map<string, ActionStepResult>();
    const executed = new Set<string>();
    const failed = new Set<string>();
    const cancelled = new Set<string>();

    let frontier = plan.actions.filter((action) => action.dependsOn.length === 0);

    while (frontier.length > 0) {
      if (options.signal?.aborted) {
        for (const action of plan.actions) {
          if (results.has(action.id)) continue;
          const result = this.cancelledResult(action, "Plan was cancelled");
          results.set(action.id, result);
          cancelled.add(action.id);
        }
        break;
      }

      const wave = await Promise.all(
        frontier.map((action) => this.execute(action, options)),
      );
      const newlyFailed: string[] = [];

      for (let index = 0; index < frontier.length; index += 1) {
        const action = frontier[index];
        const result = wave[index];
        results.set(action.id, result);
        executed.add(action.id);
        if (result.status === "failed") {
          failed.add(action.id);
          newlyFailed.push(action.id);
        } else if (result.status === "cancelled") {
          cancelled.add(action.id);
        }
      }

      // Cascade: dependents of failed actions can never run.
      const cascadeQueue = [...newlyFailed];
      while (cascadeQueue.length > 0) {
        const failedActionId = cascadeQueue.shift() ?? "";
        for (const dependentId of dependents.get(failedActionId) ?? []) {
          if (results.has(dependentId)) continue;
          const dependent = byId.get(dependentId);
          if (!dependent) continue;
          const result = this.dependencyFailureResult(dependent, failedActionId);
          results.set(dependentId, result);
          failed.add(dependentId);
          cascadeQueue.push(dependentId);
        }
      }

      frontier = plan.actions.filter(
        (action) =>
          !results.has(action.id) &&
          action.dependsOn.every(
            (dependency) =>
              executed.has(dependency) || failed.has(dependency) || cancelled.has(dependency),
          ),
      );
    }

    const orderedResults = plan.actions.map(
      (action) =>
        results.get(action.id) ?? this.cancelledResult(action, "Action was not reached"),
    );
    return {
      planId: plan.id,
      results: orderedResults,
      completedActionIds: orderedResults
        .filter((result) => result.status === "completed")
        .map((result) => result.actionId),
      failedActionIds: orderedResults
        .filter((result) => result.status === "failed")
        .map((result) => result.actionId),
      cancelledActionIds: orderedResults
        .filter((result) => result.status === "cancelled")
        .map((result) => result.actionId),
    };
  }

  /**
   * Execute a single `action` and return one structured outcome.
   *
   * - Resolves the handler by `action.type`; an unknown type yields a
   *   `failed` outcome with code `unknown_action`.
   * - Runs up to `action.maxAttempts` attempts (no retries unless
   *   configured). A failed attempt retries after
   *   `metadata.retryDelayMs` (via the injected `sleep`); a cancelled run
   *   stops immediately.
   * - The action is never mutated; each execution is independent and
   *   deterministic for identical actions, handlers, and injected time.
   */
  async execute(action: Action, options: ActionExecuteOptions = {}): Promise<ActionStepResult> {
    const startedAt = Date.now();
    const handler = this.registry.get(action.type);
    if (handler === undefined) {
      return {
        actionId: action.id,
        type: action.type,
        attempt: 1,
        attemptsMade: 1,
        status: "failed",
        error: {
          code: "unknown_action",
          message: `No handler registered for action type "${action.type}"`,
        },
        durationMs: Date.now() - startedAt,
      };
    }

    if (options.signal?.aborted) {
      return {
        actionId: action.id,
        type: action.type,
        attempt: 1,
        attemptsMade: 0,
        status: "cancelled",
        error: { code: "cancelled", message: "Action was cancelled before execution" },
        durationMs: Date.now() - startedAt,
      };
    }

    const maxAttempts = Math.max(1, action.maxAttempts);
    const timeoutMs = options.timeoutMs ?? action.metadata.timeoutMs;
    const retryDelayMs = action.metadata.retryDelayMs ?? 0;
    const now = options.now ?? this.now();

    let lastError: ActionError | undefined;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) {
        return {
          actionId: action.id,
          type: action.type,
          attempt,
          attemptsMade,
          status: "cancelled",
          error: { code: "cancelled", message: "Action was cancelled" },
          durationMs: Date.now() - startedAt,
        };
      }

      attemptsMade = attempt;
      const running = { ...action, status: "running" as const };
      const context: ActionContext = {
        action: running,
        attempt,
        signal: options.signal,
        now,
        ...(options.userId !== undefined ? { userId: options.userId } : {}),
      };

      try {
        const output = await this.runAttempt(handler, context, timeoutMs, options.signal);
        return {
          actionId: action.id,
          type: action.type,
          attempt,
          attemptsMade,
          status: "completed",
          output,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        if (err instanceof ActionCancelledError) {
          return {
            actionId: action.id,
            type: action.type,
            attempt,
            attemptsMade,
            status: "cancelled",
            error: { code: "cancelled", message: err.message },
            durationMs: Date.now() - startedAt,
          };
        }
        lastError =
          err instanceof ActionTimeoutError
            ? { code: "timeout", message: `Action timed out after ${timeoutMs ?? 0}ms` }
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
      actionId: action.id,
      type: action.type,
      attempt: maxAttempts,
      attemptsMade,
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
    handler: ActionHandler,
    context: ActionContext,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const execution = Promise.resolve().then(() => handler(context));

    if (timeoutMs === undefined && signal === undefined) return execution;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectOutcome: (reason: ActionTimeoutError | ActionCancelledError) => void = () => undefined;
    const outcome = new Promise<never>((_, reject) => {
      rejectOutcome = reject;
    });

    const onExternalAbort = (): void => rejectOutcome(new ActionCancelledError());
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => rejectOutcome(new ActionTimeoutError()), timeoutMs);
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

  private cancelledResult(action: Action, message: string, startedAt?: number): ActionStepResult {
    return {
      actionId: action.id,
      type: action.type,
      attempt: 1,
      attemptsMade: 0,
      status: "cancelled",
      error: { code: "cancelled", message },
      // An in-flight action that was cancelled carries its elapsed time;
      // actions cancelled before starting (or never reached) report 0ms.
      durationMs: startedAt === undefined ? 0 : Date.now() - startedAt,
    };
  }

  private dependencyFailureResult(action: Action, failedDependencyId: string): ActionStepResult {
    return {
      actionId: action.id,
      type: action.type,
      attempt: 1,
      attemptsMade: 0,
      status: "failed",
      error: {
        code: "dependency_failed",
        message: `Dependency action "${failedDependencyId}" failed`,
      },
      durationMs: 0,
    };
  }
}
