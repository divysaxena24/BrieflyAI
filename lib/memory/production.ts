/**
 * Memory Engine — production composition point.
 *
 * The single place the application composes the memory engine. The pipeline
 * is wired from the existing memory components and the existing Context
 * Engine components — nothing is reimplemented:
 *
 * ```text
 * MemoryRepository → MemoryManager → MemoryContextSource → ContextEngine
 *   → PromptBuilder → final prompt
 * ```
 *
 * The Context Engine used here is a standard `ContextEngine` whose
 * `ContextBuilder` is wired with a single `MemoryContextSource` that serves
 * the ranked memories (and, optionally, a `ConversationContextSource` for
 * restored conversation context). The existing ranker, deduplicator,
 * compressor, assembler, and prompt builder run unchanged; none of them is
 * modified.
 *
 * - `createProductionMemoryEngine()` is a pure factory: it only wires the
 *   dependency graph (optionally seeded with an initial repository for
 *   dependency injection); no pipeline method is invoked during construction.
 * - `getProductionMemoryEngine()` returns the application's single engine
 *   instance (module-level singleton).
 * - `buildMemoryPrompt()` is the entry point the AI request flow uses to turn
 *   a user query into the final LLM prompt through the memory engine.
 * - `MemoryEngineService` satisfies the Context Engine's existing
 *   `MemoryService` contract (see `lib/context/sources/memorySource.ts`) over
 *   an immutable `MemoryRepository`, so the standard `createContextEngine`
 *   / `ContextSourceRegistry` wiring can now receive a real memory service.
 *
 * Stop condition (documented, per architecture rules): no database or storage
 * exists for memories anywhere in the codebase — like the conversation
 * engine, memory is pure in-memory state per process. Persistence is
 * deliberately excluded from this layer.
 */

import { ContextEngine } from "@/lib/context/engine";
import { ContextBuilder } from "@/lib/context/contextBuilder";
import { ContextRanker } from "@/lib/context/contextRanker";
import { ContextDeduplicator } from "@/lib/context/contextDeduplicator";
import { ContextCompressor } from "@/lib/context/contextCompressor";
import { ContextAssembler } from "@/lib/context/contextAssembler";
import { PromptBuilder } from "@/lib/context/promptBuilder";
import type { ContextSource } from "@/lib/context/types";
import { DEFAULT_MEMORY_CONTEXT_ITEMS, MemoryContextSource } from "./context";
import { ConversationContextSource } from "@/lib/conversation/contextRestorer";
import type { ConversationRestoreFn } from "@/lib/conversation/contextRestorer";
import { MemoryManager } from "./manager";
import { MemoryRepository, type MemoryPatch } from "./repository";
import { MemoryRetriever } from "./retrieval";
import { rankMemories } from "./ranker";
import { MemoryStore } from "./stores";
import type {
  CreateMemoryInput,
  Memory,
  MemorySearchResult,
} from "./types";
import type { MemoryItem, MemoryService } from "@/lib/context/sources/memorySource";

/** Options accepted by {@link MemoryEngine.buildPrompt}. */
export interface MemoryPromptOptions {
  /** Application-level user id the prompt is built for. */
  readonly userId: string;
  /** The user's query, appended verbatim by the prompt builder. */
  readonly userQuery: string;
  /** Token budget forwarded to the compression stage. */
  readonly tokenBudget: number;
  /** Optional system instructions forwarded to the prompt builder. */
  readonly systemPrompt?: string;
  /** Optional prior turns forwarded to the prompt builder and retrieval. */
  readonly history?: string[];
  /** Hard cap on the number of memory context items served. */
  readonly maxItems?: number;
  /**
   * Optional restore function (see `ConversationContextSource`) that feeds
   * restored conversation context into the same prompt, alongside memory.
   */
  readonly restoreConversation?: ConversationRestoreFn;
}

/**
 * The memory engine — pure in-memory composition of the memory layer and the
 * Context Engine.
 *
 * Memory operations (remember, forget, update, touch, archive, restore,
 * delete, bulk) are delegated to an immutable `MemoryManager`; every mutation
 * returns the successor engine. `buildPrompt` runs the full pipeline:
 * rank → context conversion → Context Engine → prompt.
 */
export class MemoryEngine {
  /** The backing immutable manager; replaced only via successor construction. */
  private manager: MemoryManager;

  /**
   * Build an engine over a repository (empty by default). The repository is
   * injected, so callers may seed memories (dependency injection).
   */
  constructor(initialRepository: MemoryRepository = new MemoryRepository()) {
    this.manager = new MemoryManager(initialRepository);
  }

  /** Return a detached clone of the stored memory, or `undefined`. */
  getMemory(memoryId: string): Memory | undefined {
    return this.manager.find(memoryId);
  }

  /** Return detached clones of every stored memory, in insertion order. */
  listMemories(): Memory[] {
    return this.manager.list();
  }

  /** Whether a memory with the given id is stored. */
  hasMemory(memoryId: string): boolean {
    return this.manager.has(memoryId);
  }

  /** Number of stored memories. */
  count(): number {
    return this.manager.count();
  }

  /** The short-term store over the engine's repository. */
  shortTerm(): MemoryStore {
    return new MemoryStore(this.manager.repository, "short-term");
  }

  /** The long-term store over the engine's repository. */
  longTerm(): MemoryStore {
    return new MemoryStore(this.manager.repository, "long-term");
  }

  /** A deterministic retriever over the engine's repository. */
  retriever(): MemoryRetriever {
    return new MemoryRetriever(this.manager.repository);
  }

  /** Remember a memory; returns it plus the successor engine. */
  remember(input: CreateMemoryInput): { engine: MemoryEngine; memory: Memory } {
    const { manager, memory } = this.manager.remember(input);
    return { engine: MemoryEngine.withManager(manager), memory };
  }

  /** Return the successor engine with the memory soft-deleted. */
  forget(memoryId: string): MemoryEngine {
    return MemoryEngine.withManager(this.manager.forget(memoryId));
  }

  /** Update a memory; returns it plus the successor engine. */
  updateMemory(
    memoryId: string,
    changes: MemoryPatch,
  ): { engine: MemoryEngine; memory: Memory } {
    const { manager, memory } = this.manager.updateMemory(memoryId, changes);
    return { engine: MemoryEngine.withManager(manager), memory };
  }

  /** Record an access; returns the touched memory plus the successor engine. */
  touchMemory(
    memoryId: string,
    at: string,
  ): { engine: MemoryEngine; memory: Memory } {
    const { manager, memory } = this.manager.touchMemory(memoryId, at);
    return { engine: MemoryEngine.withManager(manager), memory };
  }

  /** Return the successor engine with the memory archived. */
  archiveMemory(memoryId: string): MemoryEngine {
    return MemoryEngine.withManager(this.manager.archiveMemory(memoryId));
  }

  /** Return the successor engine with the memory set back to active. */
  restoreMemory(memoryId: string): MemoryEngine {
    return MemoryEngine.withManager(this.manager.restoreMemory(memoryId));
  }

  /** Return the successor engine with the memory removed entirely. */
  deleteMemory(memoryId: string): MemoryEngine {
    return MemoryEngine.withManager(this.manager.deleteMemory(memoryId));
  }

  /** Remember many memories; returns them plus the successor engine. */
  bulkRemember(inputs: readonly CreateMemoryInput[]): {
    engine: MemoryEngine;
    added: Memory[];
  } {
    const { manager, added } = this.manager.bulkRemember(inputs);
    return { engine: MemoryEngine.withManager(manager), added };
  }

  /** Return the successor engine with many memories soft-deleted. */
  bulkForget(ids: readonly string[]): MemoryEngine {
    return MemoryEngine.withManager(this.manager.bulkForget(ids));
  }

  /**
   * Build the final LLM prompt for a user query.
   *
   * Pipeline (in this exact order):
   * 1. Rank the engine's memories against the query (`rankMemories`, through
   *    `MemoryContextSource`).
   * 2. Convert the ranked memories to `Context` objects (`memoryToContext`).
   * 3. Optionally restore conversation context through `restoreConversation`.
   * 4. Run the Context Engine (`retrieve → rank → deduplicate → compress →
   *    assemble → prompt`) with the memory (and conversation) sources.
   *
   * The engine's state is never mutated; an empty repository simply yields
   * a prompt without memory context (no throw).
   */
  async buildPrompt(options: MemoryPromptOptions): Promise<string> {
    const sources: ContextSource[] = [
      new MemoryContextSource(this.manager.repository),
    ];
    if (options.restoreConversation !== undefined) {
      sources.push(new ConversationContextSource(options.restoreConversation));
    }

    const contextEngine = new ContextEngine(
      new ContextBuilder(sources),
      new ContextRanker(),
      new ContextDeduplicator(),
      new ContextCompressor(),
      new ContextAssembler(),
      new PromptBuilder(),
    );

    return contextEngine.buildPrompt({
      retrievalQuery: {
        userId: options.userId,
        query: options.userQuery,
        ...(options.history !== undefined ? { history: options.history } : {}),
        ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
      },
      tokenBudget: options.tokenBudget,
      userQuery: options.userQuery,
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.history !== undefined ? { history: options.history } : {}),
    });
  }

  /** Return a fresh successor engine over `manager`. */
  private static withManager(manager: MemoryManager): MemoryEngine {
    const engine = new MemoryEngine();
    engine.manager = manager;
    return engine;
  }
}

/**
 * Build a fresh production memory engine.
 *
 * Optional `initialRepository` seeds the engine's memories (dependency
 * injection); when omitted, the engine starts empty. Pure — construction
 * only; no pipeline method is invoked.
 */
export function createProductionMemoryEngine(
  initialRepository?: MemoryRepository,
): MemoryEngine {
  return new MemoryEngine(initialRepository ?? new MemoryRepository());
}

/**
 * The application's single production memory engine instance.
 * Created once at module load.
 */
const productionMemoryEngine = createProductionMemoryEngine();

/** Return the application's single production memory engine instance. */
export function getProductionMemoryEngine(): MemoryEngine {
  return productionMemoryEngine;
}

/**
 * Build the final LLM prompt for a user query through the production memory
 * engine (see {@link MemoryEngine.buildPrompt}).
 */
export function buildMemoryPrompt(options: MemoryPromptOptions): Promise<string> {
  return getProductionMemoryEngine().buildPrompt(options);
}

/** Map a ranked memory to the `MemoryItem` shape of the `MemoryService` contract. */
function toMemoryItem(result: MemorySearchResult): MemoryItem {
  return {
    id: result.id,
    title: result.metadata.title,
    content: result.content,
    timestamp: result.metadata.updatedAt,
    relevance: result.score,
    importance: result.metadata.importance,
  };
}

/**
 * A `MemoryService` implementation over an immutable `MemoryRepository`.
 *
 * Satisfies the Context Engine's existing `MemoryService` contract (see
 * `lib/context/sources/memorySource.ts`), so `createContextEngine` /
 * `ContextSourceRegistry` can now wire a real, deterministic memory source —
 * closing the previously documented "no production `MemoryService`" gap.
 *
 * - `isAvailable` is always true — the repository is in-process.
 * - `retrieveRelevantMemory` ranks the repository's memories against the
 *   query (`rankMemories`) and returns the top `maxItems` as `MemoryItem`s
 *   (defaulting to `DEFAULT_MEMORY_CONTEXT_ITEMS`), carrying their scores as
 *   `relevance`. `history` is accepted for contract compatibility but does
 *   not influence the deterministic ranking.
 */
export class MemoryEngineService implements MemoryService {
  private readonly repository: MemoryRepository;

  constructor(repository: MemoryRepository = new MemoryRepository()) {
    this.repository = repository;
  }

  /** Always available — the repository is in-process. */
  async isAvailable(userId: string): Promise<boolean> {
    // The service is in-process and user-agnostic; `userId` is part of the
    // contract but does not gate availability.
    void userId;
    return true;
  }

  /** Rank the repository's memories and return the top items as `MemoryItem`s. */
  async retrieveRelevantMemory(args: {
    userId: string;
    query: string;
    history?: string[];
    maxItems?: number;
  }): Promise<MemoryItem[]> {
    void args.history;
    const limit = args.maxItems ?? DEFAULT_MEMORY_CONTEXT_ITEMS;
    if (limit <= 0) return [];
    return rankMemories(this.repository.list(), args.query)
      .slice(0, limit)
      .map(toMemoryItem);
  }
}
