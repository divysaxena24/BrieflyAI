/**
 * AI Tool layer — execution plans.
 *
 * A plan is a pure, immutable data structure: an ordered list of steps, each
 * naming a registered tool, its validated input, and the step ids it depends
 * on. Plans describe *what* to run and *when* it may run; they never execute
 * anything themselves.
 *
 * `createExecutionPlan` validates a candidate plan (unique step ids, known
 * dependencies, no self-dependency, no dependency cycles) and deep-freezes
 * the result so plans are immutable by construction.
 */

import type { ToolInput } from "./types";

/**
 * A single planned tool invocation.
 *
 * - `input` is the already-validated input for the tool (the executor
 *   re-validates defensively before running).
 * - `dependsOn` lists step ids that must complete *successfully* before this
 *   step may run; a step whose dependency fails is never executed.
 */
export interface ExecutionStep {
  /** Stable id unique within the plan, e.g. "step-1". */
  readonly stepId: string;
  /** Id of the registered tool to invoke. */
  readonly toolId: string;
  /** Validated input for the tool. */
  readonly input: ToolInput;
  /** Step ids this step depends on (execution order constraint). */
  readonly dependsOn: readonly string[];
}

/**
 * An immutable multi-step execution plan.
 *
 * `steps` are in declared order — the deterministic tie-break when multiple
 * steps are ready to run at the same time. Execution is parallel whenever
 * dependencies allow, sequential when they require it.
 */
export interface ExecutionPlan {
  /** Stable plan id, provided by the planner. */
  readonly id: string;
  /** Steps in declared execution order. */
  readonly steps: readonly ExecutionStep[];
}

/** Options accepted by {@link createExecutionPlan}. */
export interface ExecutionPlanInput {
  /** Stable plan id, provided by the planner. */
  id: string;
  /** Candidate steps; validated and deep-frozen before returning. */
  steps: readonly ExecutionStep[];
}

/**
 * Validate a candidate step list: unique step ids, dependencies referencing
 * existing steps (not themselves), and an acyclic dependency graph.
 */
function assertValidPlan(steps: readonly ExecutionStep[]): void {
  // Pass 1: collect every step id first so dependencies may reference steps
  // declared later in the list.
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.stepId)) {
      throw new Error(`Execution plan contains duplicate step id "${step.stepId}"`);
    }
    stepIds.add(step.stepId);
  }

  // Pass 2: validate self- and cross-references against the full id set.
  for (const step of steps) {
    if (step.dependsOn.includes(step.stepId)) {
      throw new Error(`Execution step "${step.stepId}" depends on itself`);
    }
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        throw new Error(`Execution step "${step.stepId}" depends on unknown step "${dependency}"`);
      }
    }
  }

  // Cycle detection via Kahn's algorithm (deterministic; order-independent).
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
    throw new Error("Execution plan contains a dependency cycle");
  }
}

/**
 * Build an immutable `ExecutionPlan` from candidate steps.
 *
 * Validates the plan and returns it deep-frozen: the plan, its step array,
 * each step, its `dependsOn` array, and the step `input` object are all
 * `Object.freeze`d, so mutation attempts throw in strict mode. Duplicate
 * entries in `dependsOn` are collapsed to a single dependency.
 */
export function createExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
  assertValidPlan(input.steps);

  const steps = input.steps.map((step) =>
    Object.freeze({
      ...step,
      input: Object.freeze({ ...step.input }),
      dependsOn: Object.freeze([...new Set(step.dependsOn)]),
    }),
  );

  return Object.freeze({ id: input.id, steps: Object.freeze(steps) });
}
