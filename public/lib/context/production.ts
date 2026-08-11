/**
 * Context Engine — production composition point.
 *
 * The single place the application composes the production `ContextEngine`.
 * The four production service adapters (`GmailServiceAdapter`,
 * `CalendarServiceAdapter`, `DriveServiceAdapter`, `GitHubServiceAdapter`)
 * are wired through `createContextEngine`:
 *
 * ```text
 * ContextSourceRegistry → ContextBuilder → ContextRanker → ContextDeduplicator
 *   → ContextCompressor → ContextAssembler → PromptBuilder → ContextEngine
 * ```
 *
 * - `createProductionContextEngine()` is a pure factory (like
 *   `createContextEngine`): it only wires the dependency graph; no service,
 *   source, or pipeline method is invoked during construction.
 * - `getProductionContextEngine()` returns the application's single engine
 *   instance (module-level singleton) — services are never instantiated in
 *   more than one place.
 * - `buildProductionPrompt()` is the entry point the AI request flow uses to
 *   turn a user request into the final LLM prompt through the engine, with
 *   optional `CONTEXT_DEBUG=true` timing/source logging (see `./debug`).
 *
 * The production engine wires the four connected-platform adapters. No
 * memory source is wired: a production `MemoryService` does not exist in the
 * codebase yet (see `lib/context/sources/memorySource.ts`).
 */

import { createContextEngine } from "./createContextEngine";
import type { ContextEngine } from "./engine";
import type { RetrievalQuery } from "./types";
import { GmailServiceAdapter } from "./adapters/gmailServiceAdapter";
import { CalendarServiceAdapter } from "./adapters/calendarServiceAdapter";
import { DriveServiceAdapter } from "./adapters/driveServiceAdapter";
import { GitHubServiceAdapter } from "./adapters/githubServiceAdapter";
import { GMAIL_SOURCE_ID } from "./sources/gmailSource";
import { CALENDAR_SOURCE_ID } from "./sources/calendarSource";
import { GITHUB_SOURCE_ID } from "./sources/githubSource";
import { DRIVE_SOURCE_ID } from "./sources/driveSource";
import { CONTEXT_PIPELINE_STAGES, logContextDebug } from "./debug";

/** Source ids wired by the production engine, in registry creation order. */
export const PRODUCTION_SOURCE_IDS: readonly string[] = [
  GMAIL_SOURCE_ID,
  CALENDAR_SOURCE_ID,
  GITHUB_SOURCE_ID,
  DRIVE_SOURCE_ID,
];

/** Options accepted by {@link buildProductionPrompt}. */
export interface ProductionPromptOptions {
  /** Query passed to the retrieval stage. */
  retrievalQuery: RetrievalQuery;
  /** Token budget forwarded to the compression stage. */
  tokenBudget: number;
  /** User query forwarded to the prompt builder. */
  userQuery: string;
  /** Optional conversation history forwarded to the prompt builder. */
  history?: string[];
  /** Optional system instructions forwarded to the prompt builder. */
  systemPrompt?: string;
}

/**
 * Build the production Context Engine: the four production service adapters
 * wired through `createContextEngine`. Pure — construction only; no service,
 * source, or pipeline method is invoked.
 *
 * This is the testable pure form of the production composition. Application
 * code should use the singleton exposed by {@link getProductionContextEngine}
 * (created once below) so services are never instantiated in more than one
 * place.
 */
export function createProductionContextEngine(): ContextEngine {
  return createContextEngine({
    gmailService: new GmailServiceAdapter(),
    calendarService: new CalendarServiceAdapter(),
    driveService: new DriveServiceAdapter(),
    githubService: new GitHubServiceAdapter(),
  });
}

/**
 * The application's single production Context Engine instance.
 *
 * Created once at module load; every `buildProductionPrompt` call and every
 * consumer that needs the production engine receives this instance. This is
 * the only place production services are instantiated.
 */
const productionContextEngine = createProductionContextEngine();

logContextDebug("context engine initialized", { sources: [...PRODUCTION_SOURCE_IDS] });

/** Return the application's single production Context Engine instance. */
export function getProductionContextEngine(): ContextEngine {
  return productionContextEngine;
}

/**
 * Build the final LLM prompt for a user request through the production
 * Context Engine.
 *
 * Runs the full pipeline (`retrieve → rank → deduplicate → compress →
 * assemble → prompt`) and returns the assembled prompt string. When
 * `CONTEXT_DEBUG=true`, logs the enabled source ids, the pipeline stages,
 * the completion duration, and the prompt length — never user content.
 *
 * This is the seam the AI request flow calls before invoking the LLM; the
 * actual model call is a separate concern owned by the AI service layer.
 */
export async function buildProductionPrompt(
  options: ProductionPromptOptions,
): Promise<string> {
  const engine = getProductionContextEngine();
  const startedAt = Date.now();

  logContextDebug("pipeline started", {
    sources: [...PRODUCTION_SOURCE_IDS],
    stages: [...CONTEXT_PIPELINE_STAGES],
    tokenBudget: options.tokenBudget,
  });

  const prompt = await engine.buildPrompt(options);

  logContextDebug("pipeline completed", {
    durationMs: Date.now() - startedAt,
    promptLength: prompt.length,
  });

  return prompt;
}
