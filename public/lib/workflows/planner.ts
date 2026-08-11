/**
 * Workflow Engine — workflow planner (pure, deterministic).
 *
 * Converts an immutable `Workflow` into an immutable `WorkflowPlan` of
 * executable steps. No LLM and no reasoning live here — the planner is a
 * deterministic orchestrator that *reuses* the existing planners rather than
 * reimplementing any planning logic:
 *
 * - **Action Planner reuse**: `"action"` steps delegate to the injected
 *   `ActionPlanner` (the Phase 5H planner) — the workflow planner only feeds
 *   it a `PlanIntent` and embeds the resulting `ActionPlan` in the planned
 *   step. No action planning logic is duplicated.
 * - **Tool Planner reuse**: `"tool"` steps carry an already-built
 *   `ExecutionPlan` (produced by the tool layer's `createExecutionPlan`).
 * - **Conditions**: each step's `WorkflowCondition` is evaluated against the
 *   injected signal object; a failing condition skips the step, and every
 *   transitive dependent of a skipped step is skipped too.
 * - **Dependencies**: step ordering constraints are preserved (validated
 *   acyclic by `createWorkflow`); steps are emitted in deterministic
 *   topological order (declared order breaks ties).
 * - **Parallel branches**: the plan computes deterministic wave/branch
 *   groups — steps in the same wave are mutually independent and may run
 *   concurrently.
 * - **Failure isolation**: a throwing Action Planner call for one step marks
 *   that step failed-to-plan (carrying a structured `WorkflowError`) without
 *   taking down the plan.
 * - **Deep freeze**: the returned plan and every nested step/action/branch
 *   are `Object.freeze`d.
 *
 * The planner never mutates the workflow and never executes anything.
 */

import { ActionPlanner, type ActionPlan, type PlanIntent } from "@/lib/actions/planner";
import {
  evaluateCondition,
  hashWorkflow,
  type Workflow,
  type WorkflowActionKind,
  type WorkflowError,
  type WorkflowPriority,
  type WorkflowStep,
} from "./types";

/** A workflow step resolved into an executable plan step. */
export interface PlannedWorkflowStep {
  /** The workflow step's id. */
  readonly stepId: string;
  /** Human-readable step name. */
  readonly name: string;
  readonly kind: WorkflowActionKind;
  /** Step ids this step depends on (execution-order constraint). */
  readonly dependsOn: readonly string[];
  readonly priority: WorkflowPriority;
  /** Effective attempt budget (step override, else workflow default). */
  readonly maxAttempts: number;
  /** Effective per-attempt execution timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Effective retry delay in milliseconds. */
  readonly retryDelayMs?: number;
  /** The step's action, resolved for execution. */
  readonly action: PlannedWorkflowAction;
  /** For `"action"` steps: the ActionPlan produced by the Action Planner. */
  readonly actionPlan?: ActionPlan;
  /** Structured planning failure (failure isolation) when planning failed. */
  readonly error?: WorkflowError;
}

/** The step action with the `"action"` intent/requests materialized. */
export interface PlannedWorkflowAction {
  readonly kind: WorkflowActionKind;
  /** `"action"`: the intent text (may be the step name). */
  readonly intent?: string;
  /** `"job"`: the id of the background job to run. */
  readonly jobId?: string;
  /** `"tool"`: the immutable execution plan to execute. */
  readonly plan?: import("@/lib/tools/plan").ExecutionPlan;
  /** `"digest"`: the digest template to build. */
  readonly template?: import("@/lib/digest/types").DigestTemplate;
  /** `"digest"`: free-text query forwarded to the digest builder. */
  readonly query?: string;
}

/**
 * An immutable plan of executable steps derived from a workflow.
 *
 * `steps` are in deterministic topological order; `branches` group the steps
 * into parallel waves (index 0 runs first); `skippedSteps` lists the steps
 * excluded by conditions (full step shape, so the executor can report their
 * kinds); `summary` is a deterministic one-line description. Deep-frozen by
 * construction.
 */
export interface WorkflowPlan {
  /** Stable plan id; deterministic when derived from workflow + now. */
  readonly id: string;
  /** The workflow this plan was derived from. */
  readonly workflowId: string;
  /** Human-readable workflow name. */
  readonly name: string;
  /** ISO-8601 UTC timestamp of the planning. */
  readonly now: string;
  /** The executable steps, in deterministic topological order. */
  readonly steps: readonly PlannedWorkflowStep[];
  /** Parallel waves: each entry is a set of mutually independent step ids. */
  readonly branches: readonly (readonly string[])[];
  /** Steps excluded from execution (condition-failed), full shape. */
  readonly skippedSteps: readonly PlannedWorkflowStep[];
  /** Deterministic one-line summary of the plan. */
  readonly summary: string;
}

/** Options accepted by {@link WorkflowPlanner.plan}. */
export interface PlanWorkflowOptions {
  /** ISO-8601 UTC timestamp of the planning. */
  readonly now: string;
  /** Application-level user id forwarded to the Action Planner. */
  readonly userId?: string;
  /** The signal object conditions are evaluated against. */
  readonly signal?: Readonly<Record<string, unknown>>;
}

/**
 * The deterministic workflow planner — a pure orchestrator over the existing
 * Action Planner.
 */
export class WorkflowPlanner {
  /**
   * Build a planner over an optional Action Planner (dependency injection).
   * When omitted, a fresh plain `ActionPlanner` is used.
   */
  constructor(private readonly actionPlanner: ActionPlanner = new ActionPlanner()) {}

  /**
   * Plan a workflow into an immutable `WorkflowPlan`.
   *
   * Pipeline (deterministic):
   * 1. Evaluate each step's condition against `options.signal`; collect the
   *    condition-skipped step ids.
   * 2. Compute the transitive closure of skipped steps (a step whose
   *    dependency is skipped is skipped too).
   * 3. Plan every step (condition-skipped steps are planned without invoking
   *    the Action Planner); `"action"` steps go through the Action Planner
   *    (failure isolation: a throwing call marks the step failed-to-plan).
   * 4. Order the executable steps topologically (declared order breaks
   *    ties).
   * 5. Compute the parallel branches (waves) over the executable steps.
   * 6. Validate + deep-freeze via `createWorkflowPlan`.
   *
   * Never throws for planning decisions: unknown steps, failing conditions,
   * and Action Planner failures are isolated. The workflow is never mutated.
   */
  plan(workflow: Workflow, options: PlanWorkflowOptions): WorkflowPlan {
    const signal = options.signal ?? {};
    const skipped = new Set<string>(
      workflow.steps
        .filter(
          (step) =>
            step.condition !== undefined && !evaluateCondition(step.condition, signal),
        )
        .map((step) => step.id),
    );

    // Transitive closure: a step whose dependency is skipped is skipped.
    // After the fixpoint, every executable step's `dependsOn` references only
    // executable steps — so planned `dependsOn` never needs re-filtering
    // (createWorkflowPlan's validation would throw otherwise).
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of workflow.steps) {
        if (skipped.has(step.id)) continue;
        if (step.dependsOn.some((dependency) => skipped.has(dependency))) {
          skipped.add(step.id);
          changed = true;
        }
      }
    }

    const planned: PlannedWorkflowStep[] = workflow.steps.map((step) =>
      this.planStep(step, workflow, options, skipped.has(step.id)),
    );
    const executable = planned.filter((step) => !skipped.has(step.stepId));
    const skippedSteps = planned.filter((step) => skipped.has(step.stepId));
    const ordered = topologicalOrder(executable);

    return createWorkflowPlan({
      workflowId: workflow.id,
      name: workflow.name,
      now: options.now,
      steps: ordered,
      branches: computeBranches(ordered),
      skippedSteps,
    });
  }

  /**
   * Plan a single workflow step into a `PlannedWorkflowStep`.
   *
   * When `skipPlanning` is true (condition-skipped step), the Action Planner
   * is never invoked — the step's shape is still resolved so the executor can
   * report its kind.
   */
  private planStep(
    step: WorkflowStep,
    workflow: Workflow,
    options: PlanWorkflowOptions,
    skipPlanning: boolean,
  ): PlannedWorkflowStep {
    const action = step.action;
    let actionPlan: ActionPlan | undefined;
    let error: WorkflowError | undefined;

    if (action.kind === "action" && !skipPlanning) {
      try {
        const intent: PlanIntent = {
          text: action.intent ?? step.name,
          userId: options.userId ?? "",
          now: options.now,
          ...(action.requests !== undefined && action.requests.length > 0
            ? { requests: action.requests }
            : {}),
        };
        actionPlan = this.actionPlanner.plan(intent);
      } catch (err) {
        error = {
          code: "plan_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      stepId: step.id,
      name: step.name,
      kind: action.kind,
      dependsOn: [...step.dependsOn],
      priority: step.priority,
      maxAttempts: step.maxAttempts ?? workflow.maxAttempts,
      ...(step.timeoutMs !== undefined
        ? { timeoutMs: step.timeoutMs }
        : workflow.metadata.timeoutMs !== undefined
          ? { timeoutMs: workflow.metadata.timeoutMs }
          : {}),
      ...(step.retryDelayMs !== undefined
        ? { retryDelayMs: step.retryDelayMs }
        : workflow.metadata.retryDelayMs !== undefined
          ? { retryDelayMs: workflow.metadata.retryDelayMs }
          : {}),
      action: {
        kind: action.kind,
        ...(action.intent !== undefined ? { intent: action.intent } : {}),
        ...(action.jobId !== undefined ? { jobId: action.jobId } : {}),
        ...(action.plan !== undefined ? { plan: action.plan } : {}),
        ...(action.template !== undefined ? { template: action.template } : {}),
        ...(action.query !== undefined ? { query: action.query } : {}),
      },
      ...(actionPlan !== undefined ? { actionPlan } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
}

/** Options accepted by {@link createWorkflowPlan}. */
export interface CreateWorkflowPlanInput {
  /** Explicit plan id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly workflowId: string;
  readonly name: string;
  readonly now: string;
  /** The executable steps (already ordered and dependency-resolved). */
  readonly steps: readonly PlannedWorkflowStep[];
  /** Parallel waves of step ids over the executable steps. */
  readonly branches: readonly (readonly string[])[];
  /** Steps excluded from execution (condition-failed), full shape. */
  readonly skippedSteps: readonly PlannedWorkflowStep[];
}

/**
 * Build an immutable `WorkflowPlan` from planned steps.
 *
 * Validates the candidate steps (unique step ids, dependencies referencing
 * existing steps, no self-dependency, no cycles, no id collisions with the
 * skipped steps) and returns the plan deep-frozen: the plan, its steps array,
 * each step, each step's `dependsOn`, and each step's action are
 * `Object.freeze`d.
 */
export function createWorkflowPlan(input: CreateWorkflowPlanInput): WorkflowPlan {
  const stepIds = new Set(input.steps.map((step) => step.stepId));
  for (const step of input.steps) {
    if (step.dependsOn.includes(step.stepId)) {
      throw new Error(`Workflow plan step "${step.stepId}" depends on itself`);
    }
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        throw new Error(
          `Workflow plan step "${step.stepId}" depends on unknown step "${dependency}"`,
        );
      }
    }
  }
  for (const skipped of input.skippedSteps) {
    if (stepIds.has(skipped.stepId)) {
      throw new Error(
        `Workflow plan contains skipped step "${skipped.stepId}" also present in the executable steps`,
      );
    }
  }
  assertAcyclic(input.steps);

  const id =
    input.id ??
    `plan-${hashWorkflow(`${input.workflowId}:${input.now}:${input.steps.map((s) => s.stepId).join(",")}`)}`;
  const summary =
    `${input.steps.length} step(s) across ${input.branches.length} branch(es)` +
    (input.skippedSteps.length > 0 ? ` (${input.skippedSteps.length} skipped)` : "") +
    `: ${input.steps.map((step) => step.kind).join(", ")}`;

  const freezeStep = (step: PlannedWorkflowStep): PlannedWorkflowStep =>
    Object.freeze({
      ...step,
      dependsOn: Object.freeze([...step.dependsOn]),
      action: Object.freeze({ ...step.action }),
    });

  return Object.freeze({
    id,
    workflowId: input.workflowId,
    name: input.name,
    now: input.now,
    steps: Object.freeze(input.steps.map(freezeStep)),
    branches: Object.freeze(input.branches.map((branch) => Object.freeze([...branch]))),
    skippedSteps: Object.freeze(input.skippedSteps.map(freezeStep)),
    summary,
  });
}

/**
 * Order steps in deterministic topological order (dependencies first).
 * Declared order breaks ties, so the result is stable for a fixed input.
 */
function topologicalOrder(steps: readonly PlannedWorkflowStep[]): PlannedWorkflowStep[] {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.stepId, 0);
    dependents.set(step.stepId, []);
  }
  for (const step of steps) {
    for (const dependency of new Set(step.dependsOn)) {
      const list = dependents.get(dependency) ?? [];
      list.push(step.stepId);
      dependents.set(dependency, list);
      indegree.set(step.stepId, (indegree.get(step.stepId) ?? 0) + 1);
    }
  }
  // Ready queue in declared order → deterministic wave membership.
  const ready = steps.filter((step) => (indegree.get(step.stepId) ?? 0) === 0);
  const ordered: PlannedWorkflowStep[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as PlannedWorkflowStep;
    ordered.push(current);
    for (const next of dependents.get(current.stepId) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) {
        const step = byId.get(next);
        if (step !== undefined) ready.push(step);
      }
    }
  }
  return ordered;
}

/**
 * Compute deterministic parallel branches (waves) over the executable steps:
 * branch 0 is the set of steps with no dependencies; each later branch is the
 * set of steps whose dependencies are all satisfied by earlier branches.
 * Steps are emitted in planned order within each branch.
 */
function computeBranches(steps: readonly PlannedWorkflowStep[]): readonly (readonly string[])[] {
  const branches: string[][] = [];
  const placed = new Set<string>();
  let remaining = [...steps];
  while (remaining.length > 0) {
    const wave = remaining.filter((step) =>
      step.dependsOn.every((dependency) => placed.has(dependency)),
    );
    if (wave.length === 0) break; // unreachable with valid (acyclic) plans
    const waveIds = wave.map((step) => step.stepId);
    for (const id of waveIds) placed.add(id);
    branches.push(waveIds);
    remaining = remaining.filter((step) => !placed.has(step.stepId));
  }
  return branches;
}

/** Cycle check over planned steps via Kahn's algorithm. */
function assertAcyclic(steps: readonly PlannedWorkflowStep[]): void {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.stepId, 0);
    adjacency.set(step.stepId, []);
  }
  for (const step of steps) {
    for (const dependency of new Set(step.dependsOn)) {
      adjacency.get(dependency)?.push(step.stepId);
      indegree.set(step.stepId, (indegree.get(step.stepId) ?? 0) + 1);
    }
  }
  const ready: string[] = steps
    .filter((step) => (indegree.get(step.stepId) ?? 0) === 0)
    .map((step) => step.stepId);
  let processed = 0;
  while (ready.length > 0) {
    const current = ready.shift() ?? "";
    processed += 1;
    for (const next of adjacency.get(current) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) ready.push(next);
    }
  }
  if (processed !== steps.length) {
    throw new Error("Workflow plan contains a dependency cycle");
  }
}
