/**
 * Context Engine — token budget allocation.
 *
 * Pure, deterministic helpers that divide a model's context window into
 * per-source budgets. No AI, no LLM, no retrieval — math only.
 */

import type { TokenBudget } from "./types";

/**
 * Fraction of the context window reserved for the system prompt, user query,
 * conversation history, tool definitions, and the model's response.
 */
export const DEFAULT_RESERVED_RATIO = 0.15;

/**
 * Default relative weight of each source when distributing the available
 * context budget. The "reserved" entry is informational only — it is never
 * allocated by `calculateBudget()`.
 */
export const DEFAULT_SOURCE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  memory: 0.25,
  github: 0.2,
  gmail: 0.2,
  messaging: 0.2,
  calendar: 0.05,
  drive: 0.05,
  reserved: 0.05,
});

/**
 * Sources that actually receive a budget allocation (excludes "reserved").
 */
const ALLOCATABLE_SOURCES = [
  "memory",
  "github",
  "gmail",
  "messaging",
  "calendar",
  "drive",
] as const;

/**
 * Development heuristic token estimate: 1 token per 4 characters, rounded up.
 * Never negative; the empty string yields 0.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split a model's context window into a `TokenBudget`.
 *
 * - `reservedBudget` = floor(window × `DEFAULT_RESERVED_RATIO`)
 * - `availableBudget` = window − reservedBudget
 * - `perSourceBudget` distributes the entire `availableBudget` across the
 *   allocatable sources proportionally to `DEFAULT_SOURCE_WEIGHTS`
 *   (weights normalized over the allocatable set, so nothing is left over).
 * - Tokens lost to `Math.floor()` are added to `memory`.
 */
export function calculateBudget(contextWindow: number): TokenBudget {
  const reservedBudget = Math.floor(contextWindow * DEFAULT_RESERVED_RATIO);
  const availableBudget = contextWindow - reservedBudget;

  const allocatableWeight = ALLOCATABLE_SOURCES.reduce(
    (sum, source) => sum + DEFAULT_SOURCE_WEIGHTS[source],
    0,
  );

  const perSourceBudget: Record<string, number> = {};
  let allocated = 0;

  for (const source of ALLOCATABLE_SOURCES) {
    const share = Math.floor(
      availableBudget * (DEFAULT_SOURCE_WEIGHTS[source] / allocatableWeight),
    );
    perSourceBudget[source] = share;
    allocated += share;
  }

  // Flooring loses tokens — give the remainder to memory (highest weight).
  perSourceBudget.memory += availableBudget - allocated;

  return {
    totalBudget: contextWindow,
    reservedBudget,
    availableBudget,
    perSourceBudget,
  };
}

/**
 * Re-allocate a budget across only the connected sources.
 *
 * - Only connected sources receive an allocation.
 * - Disconnected sources donate their previous allocation; the whole pool is
 *   redistributed proportionally to `DEFAULT_SOURCE_WEIGHTS`.
 * - When no known source is connected, every allocation is zero.
 * - The input budget is never mutated — a new `TokenBudget` is returned.
 * - The flooring remainder goes to `memory` when connected, else to the first
 *   connected source.
 */
export function reallocateBudget(
  budget: TokenBudget,
  connectedSources: string[],
): TokenBudget {
  const pool = Object.values(budget.perSourceBudget).reduce(
    (sum, value) => sum + value,
    0,
  );

  const connectedSet = new Set(connectedSources);

  const perSourceBudget: Record<string, number> = {};
  for (const source of Object.keys(budget.perSourceBudget)) {
    perSourceBudget[source] = 0;
  }

  const connectedWeight = [...connectedSet].reduce(
    (sum, source) => sum + (DEFAULT_SOURCE_WEIGHTS[source] ?? 0),
    0,
  );

  if (connectedWeight > 0) {
    let allocated = 0;
    for (const source of connectedSet) {
      const weight = DEFAULT_SOURCE_WEIGHTS[source] ?? 0;
      const share = Math.floor(pool * (weight / connectedWeight));
      perSourceBudget[source] = share;
      allocated += share;
    }

    const remainder = pool - allocated;
    if (remainder > 0) {
      // connectedWeight > 0 guarantees connectedSources is non-empty here.
      const target = connectedSet.has("memory") ? "memory" : connectedSources[0];
      perSourceBudget[target] += remainder;
    }
  }

  return {
    totalBudget: budget.totalBudget,
    reservedBudget: budget.reservedBudget,
    availableBudget: budget.availableBudget,
    perSourceBudget,
  };
}

/**
 * Return the longest prefix of `items` whose cumulative `tokenEstimate` does
 * not exceed `budget`. Pure — the input array is not modified.
 */
export function trimToBudget(
  items: { tokenEstimate: number }[],
  budget: number,
): { tokenEstimate: number }[] {
  let used = 0;
  const prefix: { tokenEstimate: number }[] = [];
  for (const item of items) {
    if (used + item.tokenEstimate > budget) break;
    prefix.push(item);
    used += item.tokenEstimate;
  }
  return prefix;
}
