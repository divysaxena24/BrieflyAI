/**
 * Conversation layer — production composition point.
 *
 * The single place the application composes the conversation engine. The
 * pipeline is wired from the existing conversation components and the
 * existing Context Engine components — nothing is reimplemented:
 *
 * ```text
 * ConversationRepository → ConversationManager → ConversationRestorer
 *   → ConversationSummarizer → ConversationContextSource → ContextEngine
 *   → PromptBuilder → final prompt
 * ```
 *
 * The Context Engine used here is a standard `ContextEngine` whose
 * `ContextBuilder` is wired with a single `ConversationContextSource` that
 * serves the restored (and deterministically summarized) conversation. The
 * existing ranker, deduplicator, compressor, assembler, and prompt builder
 * run unchanged; none of them is modified.
 *
 * - `createProductionConversationEngine()` is a pure factory: it only wires
 *   the dependency graph (optionally seeded with an initial repository for
 *   dependency injection); no pipeline method is invoked during construction.
 * - `getProductionConversationEngine()` returns the application's single
 *   engine instance (module-level singleton).
 * - `buildConversationPrompt()` is the entry point the AI request flow uses
 *   to turn a user query into the final LLM prompt through the conversation
 *   engine.
 *
 * No LLM integration, provider SDK, database, or storage lives here — the
 * conversation engine is pure in-memory orchestration.
 */

import { ConversationRepository } from "./repository";
import { ConversationManager } from "./conversationManager";
import { ConversationRestorer } from "./restorer";
import { truncateIfNeeded } from "./summarizer";
import { ConversationContextSource } from "./contextRestorer";
import type { Conversation } from "./types";
import type { CreateConversationInput, CreateMessageInput, ConversationMessage } from "./types";
import { ContextEngine } from "@/lib/context/engine";
import { ContextBuilder } from "@/lib/context/contextBuilder";
import { ContextRanker } from "@/lib/context/contextRanker";
import { ContextDeduplicator } from "@/lib/context/contextDeduplicator";
import { ContextCompressor } from "@/lib/context/contextCompressor";
import { ContextAssembler } from "@/lib/context/contextAssembler";
import { PromptBuilder } from "@/lib/context/promptBuilder";

/** Options accepted by {@link ConversationEngine.buildPrompt}. */
export interface ConversationPromptOptions {
  /** Application-level user id the prompt is built for. */
  readonly userId: string;
  /**
   * Conversation to restore into the prompt. When omitted, the engine
   * produces a prompt for a new conversation (no conversation context).
   */
  readonly conversationId?: string;
  /** The user's query, appended verbatim by the prompt builder. */
  readonly userQuery: string;
  /** Token budget forwarded to the compression stage and the summarizer. */
  readonly tokenBudget: number;
  /** Optional system instructions forwarded to the prompt builder. */
  readonly systemPrompt?: string;
  /** Optional prior turns forwarded to the prompt builder and retrieval. */
  readonly history?: string[];
}

/**
 * The conversation engine — pure in-memory composition of the conversation
 * layer and the Context Engine.
 *
 * Conversation operations (start, append, rename, archive, restore, close,
 * delete) are delegated to an immutable `ConversationManager`; every mutation
 * returns the successor engine. `buildPrompt` runs the full pipeline:
 * restore → summarize → context conversion → Context Engine → prompt.
 */
export class ConversationEngine {
  /** The backing immutable manager; replaced only via successor construction. */
  private manager: ConversationManager;

  /**
   * Build an engine over a repository (empty by default). The repository is
   * injected, so callers may seed conversations (dependency injection).
   */
  constructor(initialRepository: ConversationRepository = new ConversationRepository()) {
    this.manager = new ConversationManager(initialRepository);
  }

  /** Return a detached clone of the stored conversation, or `undefined`. */
  getConversation(conversationId: string): Conversation | undefined {
    return this.manager.getConversation(conversationId);
  }

  /** Return detached clones of every stored conversation, in insertion order. */
  listConversations(): Conversation[] {
    return this.manager.listConversations();
  }

  /** Whether a conversation with the given id is stored. */
  hasConversation(conversationId: string): boolean {
    return this.manager.hasConversation(conversationId);
  }

  /** Number of stored conversations. */
  count(): number {
    return this.manager.count();
  }

  /** Start a conversation; returns it plus the successor engine. */
  startConversation(input: CreateConversationInput): {
    engine: ConversationEngine;
    conversation: Conversation;
  } {
    const { manager, conversation } = this.manager.startConversation(input);
    return { engine: ConversationEngine.withManager(manager), conversation };
  }

  /** Append a message; returns it plus the successor engine. */
  appendMessage(
    conversationId: string,
    input: CreateMessageInput,
  ): { engine: ConversationEngine; message: ConversationMessage } {
    const { manager, message } = this.manager.appendMessage(conversationId, input);
    return { engine: ConversationEngine.withManager(manager), message };
  }

  /** Return the successor engine with the conversation renamed. */
  renameConversation(conversationId: string, title: string): ConversationEngine {
    return ConversationEngine.withManager(this.manager.renameConversation(conversationId, title));
  }

  /** Return the successor engine with the conversation archived. */
  archiveConversation(conversationId: string): ConversationEngine {
    return ConversationEngine.withManager(this.manager.archiveConversation(conversationId));
  }

  /** Return the successor engine with the conversation set back to active. */
  restoreConversation(conversationId: string): ConversationEngine {
    return ConversationEngine.withManager(this.manager.restoreConversation(conversationId));
  }

  /** Return the successor engine with the conversation soft-deleted. */
  closeConversation(conversationId: string): ConversationEngine {
    return ConversationEngine.withManager(this.manager.closeConversation(conversationId));
  }

  /** Return the successor engine with the conversation removed entirely. */
  deleteConversation(conversationId: string): ConversationEngine {
    return ConversationEngine.withManager(this.manager.deleteConversation(conversationId));
  }

  /**
   * Build the final LLM prompt for a user query.
   *
   * Pipeline (in this exact order):
   * 1. Restore the conversation (`ConversationRestorer`) — when
   *    `conversationId` is omitted, no conversation context is produced.
   * 2. Summarize deterministically (`truncateIfNeeded`) to the token budget.
   * 3. Convert the summarized conversation to a `Context` object
   *    (`ConversationContextSource`).
   * 4. Run the Context Engine (`retrieve → rank → deduplicate → compress →
   *    assemble → prompt`) with the conversation source.
   *
   * The engine's state is never mutated; an unknown `conversationId` simply
   * yields an empty conversation context (no throw).
   */
  async buildPrompt(options: ConversationPromptOptions): Promise<string> {
    let conversation: Conversation | undefined;
    if (options.conversationId !== undefined) {
      const restorer = new ConversationRestorer(this.manager.repository);
      conversation = restorer.restoreConversation(options.conversationId);
    }

    const trimmed =
      conversation === undefined ? undefined : truncateIfNeeded(conversation, options.tokenBudget);
    const source = new ConversationContextSource(() =>
      trimmed === undefined ? [] : [trimmed],
    );

    const contextEngine = new ContextEngine(
      new ContextBuilder([source]),
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
      },
      tokenBudget: options.tokenBudget,
      userQuery: options.userQuery,
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.history !== undefined ? { history: options.history } : {}),
    });
  }

  /** Return a fresh successor engine over `manager`. */
  private static withManager(manager: ConversationManager): ConversationEngine {
    const engine = new ConversationEngine();
    engine.manager = manager;
    return engine;
  }
}

/**
 * Build a fresh production conversation engine.
 *
 * Optional `initialRepository` seeds the engine's conversations (dependency
 * injection); when omitted, the engine starts empty. Pure — construction
 * only; no pipeline method is invoked.
 */
export function createProductionConversationEngine(
  initialRepository?: ConversationRepository,
): ConversationEngine {
  return new ConversationEngine(initialRepository ?? new ConversationRepository());
}

/**
 * The application's single production conversation engine instance.
 * Created once at module load.
 */
const productionConversationEngine = createProductionConversationEngine();

/** Return the application's single production conversation engine instance. */
export function getProductionConversationEngine(): ConversationEngine {
  return productionConversationEngine;
}

/**
 * Build the final LLM prompt for a user query through the production
 * conversation engine (see {@link ConversationEngine.buildPrompt}).
 */
export function buildConversationPrompt(options: ConversationPromptOptions): Promise<string> {
  return getProductionConversationEngine().buildPrompt(options);
}
