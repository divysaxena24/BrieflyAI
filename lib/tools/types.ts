/**
 * AI Tool layer — core types.
 *
 * The provider-agnostic contract every AI tool satisfies. Tools are pure
 * capabilities: metadata for planners (id, description, schemas) plus an
 * `execute` that performs the tool's work. No LLM, no reasoning, no
 * planning lives here.
 */

import type { z } from "zod";

/**
 * Plain JSON-ish input a planner supplies for a tool step. Structured by the
 * tool's `inputSchema` and validated by the executor before `execute`.
 */
export type ToolInput = Record<string, unknown>;

/**
 * Runtime context handed to a tool at execution time (extensible).
 *
 * Carries the executor's cancellation signal so a cooperative tool can stop
 * early when the surrounding plan is cancelled.
 */
export interface ToolContext {
  /** Abort signal observed by the executor; tools may honor it to cancel early. */
  readonly signal?: AbortSignal;
}

/**
 * Generic contract every AI tool satisfies.
 *
 * - `id` / `description` — planner-facing metadata used for tool selection.
 * - `inputSchema` — Zod schema the executor validates step input against
 *   before `execute` (a step whose input fails the schema never runs).
 * - `outputSchema` — optional discovery metadata describing the result
 *   shape (informational for planners; outputs are not re-validated).
 * - `execute` — performs the tool's work and returns its output. May throw:
 *   the executor isolates per-step failures into structured results.
 *
 * The interface is intentionally non-generic (`unknown` input/output): the
 * executor hands each tool the schema-validated input, and concrete tools
 * narrow their `execute` signature to their own parsed input type.
 */
export interface Tool {
  /** Stable unique id, e.g. "search.gmail". */
  readonly id: string;
  /** Human-readable one-line description for planners. */
  readonly description: string;
  /** Zod schema describing the accepted input parameters. */
  readonly inputSchema: z.ZodType<unknown>;
  /** Optional Zod schema describing the result shape (discovery metadata). */
  readonly outputSchema?: z.ZodType<unknown>;
  /**
   * Execute the tool with schema-validated input.
   *
   * @param input   The validated step input (narrowed by concrete tools).
   * @param context Optional runtime context (e.g. the cancellation signal).
   */
  execute(input: unknown, context?: ToolContext): Promise<unknown>;
}
