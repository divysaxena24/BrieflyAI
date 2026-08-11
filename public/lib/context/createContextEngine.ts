/**
 * Context Engine — production composition (pure factory).
 *
 * `createContextEngine` wires the entire pipeline dependency graph from
 * already-created services into a fully configured `ContextEngine`:
 *
 * ```text
 * ContextSourceRegistry → ContextBuilder → ContextRanker → ContextDeduplicator
 *   → ContextCompressor → ContextAssembler → PromptBuilder → ContextEngine
 * ```
 *
 * This module performs dependency composition only: no singletons, no
 * globals, no caching, no lazy initialization, no runtime side effects, and
 * no pipeline logic is invoked during construction. Every call returns a
 * fresh, fully independent instance graph.
 */

import { ContextEngine } from "./engine";
import { ContextBuilder } from "./contextBuilder";
import { ContextRanker } from "./contextRanker";
import { ContextDeduplicator } from "./contextDeduplicator";
import { ContextCompressor } from "./contextCompressor";
import { ContextAssembler } from "./contextAssembler";
import { PromptBuilder } from "./promptBuilder";
import { ContextSourceRegistry } from "./sourceRegistry";
import type { MemoryService } from "./sources/memorySource";
import type { GmailService } from "./sources/gmailSource";
import type { CalendarService } from "./sources/calendarSource";
import type { GitHubService } from "./sources/githubSource";
import type { DriveService } from "./sources/driveSource";

/** Options accepted by {@link createContextEngine}. */
interface CreateContextEngineOptions {
  /** Creates and wires a `MemorySource` when provided. */
  memoryService?: MemoryService;
  /** Creates and wires a `GmailSource` when provided. */
  gmailService?: GmailService;
  /** Creates and wires a `CalendarSource` when provided. */
  calendarService?: CalendarService;
  /** Creates and wires a `GitHubSource` when provided. */
  githubService?: GitHubService;
  /** Creates and wires a `DriveSource` when provided. */
  driveService?: DriveService;
}

/**
 * Construct the complete Context Engine dependency graph and return it.
 *
 * - The `ContextSourceRegistry` is created from `options` and its sources
 *   feed the `ContextBuilder`; the remaining pipeline components are
 *   constructed once each and injected into `ContextEngine`.
 * - Every component is created exactly once per call; instances are never
 *   reused across calls.
 * - No service, source, or pipeline method is invoked — construction only.
 */
export function createContextEngine(
  options: CreateContextEngineOptions = {},
): ContextEngine {
  const registry = new ContextSourceRegistry(options);
  const builder = new ContextBuilder(registry.getSources());
  const ranker = new ContextRanker();
  const deduplicator = new ContextDeduplicator();
  const compressor = new ContextCompressor();
  const assembler = new ContextAssembler();
  const promptBuilder = new PromptBuilder();

  return new ContextEngine(
    builder,
    ranker,
    deduplicator,
    compressor,
    assembler,
    promptBuilder,
  );
}
