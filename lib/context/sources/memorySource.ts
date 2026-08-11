/**
 * Context Engine — long-term memory source.
 *
 * `MemorySource` is the first real `ContextSource`: it retrieves long-term
 * user memory from a memory service and converts each memory into a `Context`
 * object consumed by the pipeline. It is the highest-priority source
 * (`priority = 100`).
 *
 * Note: a production `MemoryService` does not exist in the codebase yet. This
 * module defines the minimal structural contract it must satisfy
 * (`MemoryService` / `MemoryItem`) so `MemorySource` is fully typed and
 * testable with mocks; the future service only needs to satisfy the shape.
 */

import type { Context, ContextMetadata, RetrievalQuery } from "@/lib/context/types";
import { estimateTokens } from "@/lib/context/tokenBudget";
import { ContextSourceBase } from "./contextSource";

/** Source id used by `MemorySource`. */
export const MEMORY_SOURCE_ID = "memory";

/** Default priority of `MemorySource` relative to other sources. */
export const MEMORY_SOURCE_PRIORITY = 100;

/** Default relevance used when a memory carries no relevance score. */
export const DEFAULT_MEMORY_RELEVANCE = 0.5;

/**
 * A single long-term memory item returned by a `MemoryService`.
 */
export interface MemoryItem extends Record<string, unknown> {
  /** Stable provider-side id of the memory. */
  id: string;
  /** Short human-readable title for the memory. */
  title: string;
  /** The memory text that will be sent to the LLM. */
  content: string;
  /** ISO timestamp of the memory, or null/undefined when unknown. */
  timestamp?: string | null;
  /** Relevance score in [0, 1]; 0.5 is assumed when missing. */
  relevance?: number;
  /** Importance used during ranking. */
  importance?: ContextMetadata["importance"];
}

/**
 * Contract for the long-term memory service consumed by `MemorySource`.
 *
 * The service decides how memory is stored, embedded, and searched. `MemorySource`
 * only depends on this surface.
 */
export interface MemoryService {
  /** Whether memory is available for the user right now. */
  isAvailable(userId: string): Promise<boolean>;
  /**
   * Return the memories most relevant to a query, in relevance order
   * (best first). Implementations may use the query, conversation history,
   * and an item cap.
   */
  retrieveRelevantMemory(args: {
    userId: string;
    query: string;
    history?: string[];
    maxItems?: number;
  }): Promise<MemoryItem[]>;
}

/**
 * First real context source: retrieves long-term memory and maps it to
 * `Context` items. Highest priority of all sources.
 */
export class MemorySource extends ContextSourceBase {
  private readonly memoryService: MemoryService;

  constructor(memoryService: MemoryService) {
    super(MEMORY_SOURCE_ID, MEMORY_SOURCE_PRIORITY);
    this.memoryService = memoryService;
  }

  /**
   * Whether memory is available for the user — delegated to the service.
   */
  async isAvailable(userId: string): Promise<boolean> {
    return this.memoryService.isAvailable(userId);
  }

  /**
   * Retrieve relevant memories and map them to `Context` items.
   *
   * - The service is called with `userId`, `query`, `history`, and `maxItems`
   *   from the retrieval query (missing optional fields forwarded as
   *   `undefined`).
   * - Every returned memory is mapped to a new `Context` with `source`
   *   `"memory"`, `metadata.kind` `"memory"`, `metadata.entityId` set to the
   *   memory id, `metadata.raw` set to the original memory object, and
   *   `permissions` `null`. `tokenEstimate` uses `estimateTokens(content)`;
   *   a missing timestamp maps to `null` and a missing relevance to 0.5.
   *   Note: `metadata.raw` holds a live reference to the service's memory
   *   object — safe only because neither this source nor the context
   *   pipeline mutates it.
   * - Input order is preserved.
   * - A throwing service yields `[]` (never throws, no logging, no retries).
   * - Inputs are never mutated; each returned item is a new object.
   */
  async retrieve(query: RetrievalQuery): Promise<Context[]> {
    let memories: MemoryItem[];
    try {
      memories = await this.memoryService.retrieveRelevantMemory({
        userId: query.userId,
        query: query.query,
        history: query.history,
        maxItems: query.maxItems,
      });
    } catch {
      return [];
    }
    return memories.map((memory) => this.toContext(memory));
  }

  /** Map a memory item to a `Context` object (new object, no mutation). */
  private toContext(memory: MemoryItem): Context {
    return {
      id: memory.id,
      source: MEMORY_SOURCE_ID,
      title: memory.title,
      content: memory.content,
      timestamp: memory.timestamp ?? null,
      relevance: memory.relevance ?? DEFAULT_MEMORY_RELEVANCE,
      tokenEstimate: estimateTokens(memory.content),
      truncated: false,
      compressed: false,
      metadata: {
        kind: "memory",
        entityId: memory.id,
        importance: memory.importance,
        raw: memory,
      },
      permissions: null,
    };
  }
}
