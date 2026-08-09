/**
 * Memory Engine — Context Engine integration.
 *
 * Bridges the deterministic Memory Engine into the existing Context Engine
 * without modifying it: `memoryToContext` / `memoryToContexts` convert
 * `Memory` objects into `Context` objects, and `MemoryContextSource` is a
 * `ContextSource` (built on the shared `ContextSourceBase`) that serves
 * ranked memories through the standard retrieval pipeline.
 *
 * The source reuses the Context Engine's own `MEMORY_SOURCE_ID` /
 * `MEMORY_SOURCE_PRIORITY` constants and the memory layer's `rankMemories`
 * scorer — no duplicated scoring or conversion logic.
 */

import { ContextSourceBase } from "@/lib/context/sources/contextSource";
import {
  DEFAULT_MEMORY_RELEVANCE,
  MEMORY_SOURCE_ID,
  MEMORY_SOURCE_PRIORITY,
} from "@/lib/context/sources/memorySource";
import type { Context, RetrievalQuery } from "@/lib/context/types";
import { rankMemories } from "./ranker";
import { MemoryRepository } from "./repository";
import { estimateMemoryTokens, type Memory } from "./types";

/** Default item cap when a retrieval query carries no `maxItems`. */
export const DEFAULT_MEMORY_CONTEXT_ITEMS = 10;

/** Clamp a relevance value into [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Convert a single memory into a `Context` item.
 *
 * The context follows the existing `MemorySource` shape: source `"memory"`,
 * `metadata.kind` `"memory"`, `entityId` set to the memory id, `importance`
 * carried over, and `metadata.raw` holding a shallow copy of the memory
 * (never sent to the LLM). `timestamp` is the memory's `updatedAt`;
 * `tokenEstimate` reuses `estimateMemoryTokens`. The default relevance is
 * `DEFAULT_MEMORY_RELEVANCE`; the input is never mutated and the returned
 * item is a new object.
 */
export function memoryToContext(memory: Memory, relevance: number = DEFAULT_MEMORY_RELEVANCE): Context {
  return {
    id: memory.id,
    source: MEMORY_SOURCE_ID,
    title: memory.metadata.title,
    content: memory.content,
    timestamp: memory.metadata.updatedAt,
    relevance: clamp01(relevance),
    tokenEstimate: estimateMemoryTokens(memory),
    truncated: false,
    compressed: false,
    metadata: {
      kind: "memory",
      entityId: memory.id,
      ...(memory.metadata.conversationId !== undefined
        ? { conversationId: memory.metadata.conversationId }
        : {}),
      importance: memory.metadata.importance,
      raw: { ...memory },
    },
    permissions: null,
  };
}

/**
 * Convert memories into `Context` items, preserving order.
 *
 * `relevance` is either a single score applied to every memory (default
 * `DEFAULT_MEMORY_RELEVANCE`) or a per-memory scoring function. The input
 * array and its objects are never mutated.
 */
export function memoryToContexts(
  memories: readonly Memory[],
  relevance: number | ((memory: Memory) => number) = DEFAULT_MEMORY_RELEVANCE,
): Context[] {
  return memories.map((memory) =>
    memoryToContext(memory, typeof relevance === "function" ? relevance(memory) : relevance),
  );
}

/**
 * A `ContextSource` that serves the memory repository through the standard
 * Context Engine pipeline.
 *
 * - `isAvailable` is always true — the engine is in-process and deterministic.
 * - `retrieve` ranks the repository's memories against the query with the
 *   memory ranker (`rankMemories`, which also ranks deterministically for an
 *   empty query) and converts the top `maxItems` results to `Context` items
 *   with their scores as relevance.
 * - Never throws; a non-positive `maxItems` yields `[]`.
 */
export class MemoryContextSource extends ContextSourceBase {
  private readonly repository: MemoryRepository;

  constructor(repository: MemoryRepository) {
    super(MEMORY_SOURCE_ID, MEMORY_SOURCE_PRIORITY);
    this.repository = repository;
  }

  /** Always available — the repository is in-process. */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /** Rank the repository's memories and convert the top items to `Context`. */
  async retrieve(query: RetrievalQuery): Promise<Context[]> {
    const limit = query.maxItems ?? DEFAULT_MEMORY_CONTEXT_ITEMS;
    if (limit <= 0) return [];
    const ranked = rankMemories(this.repository.list(), query.query);
    return ranked.slice(0, limit).map((result) => memoryToContext(result, result.score));
  }
}
