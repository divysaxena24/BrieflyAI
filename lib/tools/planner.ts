/**
 * AI Tool layer — planner contracts.
 *
 * The planner turns a user request into an immutable `ExecutionPlan`. Only
 * the contract is defined here — no AI planning, no reasoning, no
 * autonomous behavior. Any future planner (OpenAI, Claude, Gemini, a local
 * model, or a deterministic rule engine) implements `Planner` and the rest
 * of the tool layer is unaffected: provider-agnostic by construction.
 */

import type { ExecutionPlan } from "./plan";

/** Input handed to a planner for a single user request. */
export interface PlannerContext {
  /** Application-level user id the request is performed for. */
  readonly userId: string;
  /** The user's request text. */
  readonly query: string;
  /** Prior conversation turns that may inform planning, newest last. */
  readonly history?: readonly string[];
  /** Ids of the tools the planner may choose from. */
  readonly availableToolIds: readonly string[];
}

/**
 * Contract every planner satisfies.
 *
 * Implementations decide *what* to run (and in what order) for a request and
 * return an immutable, validated `ExecutionPlan`. The plan is pure data: it
 * is executed later by a `ToolExecutor`, never by the planner itself.
 */
export interface Planner {
  /**
   * Produce an execution plan for a user request.
   *
   * May be synchronous (rule engines) or asynchronous (model-backed
   * planners). The returned plan must be valid — see
   * `createExecutionPlan` — and its steps must reference registered tools.
   */
  plan(context: PlannerContext): Promise<ExecutionPlan> | ExecutionPlan;
}
