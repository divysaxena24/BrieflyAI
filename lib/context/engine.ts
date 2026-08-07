/**
 * Context Engine — pipeline facade (pure orchestration).
 *
 * Wires together every component built in Phase 5A into a single entry point:
 *
 * ```text
 * ContextBuilder → ContextRanker → ContextDeduplicator → ContextCompressor
 *   → ContextAssembler → PromptBuilder → final prompt
 * ```
 *
 * This module performs no retrieval, ranking, deduplication, compression,
 * assembly, prompt building, or AI calls itself — it only coordinates the
 * injected components, passing each stage's output directly to the next.
 * Stage failures propagate naturally (no retries, no logging, no fallbacks).
 */

import type { ContextBuilder } from "./contextBuilder";
import type { ContextRanker } from "./contextRanker";
import type { ContextDeduplicator } from "./contextDeduplicator";
import type { ContextCompressor } from "./contextCompressor";
import type { ContextAssembler } from "./contextAssembler";
import type { PromptBuilder } from "./promptBuilder";
import type { RetrievalQuery } from "./types";

/** Options accepted by {@link ContextEngine.buildPrompt}. */
interface ContextEngineOptions {
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
 * Orchestrates the full Phase 5A pipeline.
 *
 * All six pipeline components are injected through the constructor; nothing is
 * instantiated internally. Every stage runs exactly once, in the fixed order
 * above, with outputs forwarded directly (never mutated).
 */
export class ContextEngine {
  private readonly builder: ContextBuilder;
  private readonly ranker: ContextRanker;
  private readonly deduplicator: ContextDeduplicator;
  private readonly compressor: ContextCompressor;
  private readonly assembler: ContextAssembler;
  private readonly promptBuilder: PromptBuilder;

  constructor(
    builder: ContextBuilder,
    ranker: ContextRanker,
    deduplicator: ContextDeduplicator,
    compressor: ContextCompressor,
    assembler: ContextAssembler,
    promptBuilder: PromptBuilder,
  ) {
    this.builder = builder;
    this.ranker = ranker;
    this.deduplicator = deduplicator;
    this.compressor = compressor;
    this.assembler = assembler;
    this.promptBuilder = promptBuilder;
  }

  /**
   * Build the final prompt for a retrieval query and user query.
   *
   * Pipeline (in this exact order, each stage executed exactly once):
   * 1. `builder.build(retrievalQuery)` → `Context[]`
   * 2. `ranker.rank(contexts, retrievalQuery)` → `RankedContext[]`
   * 3. `deduplicator.deduplicate(ranked)` → `RankedContext[]`
   * 4. `compressor.compress(deduplicated, tokenBudget)` → `CompressionResult`
   * 5. `assembler.assemble(compression.contexts)` → `string`
   * 6. `promptBuilder.build({ systemPrompt, context, userQuery, history })`
   *
   * The options object, `retrievalQuery`, and `history` are never mutated.
   * Errors from any stage propagate to the caller unchanged.
   */
  async buildPrompt(options: ContextEngineOptions): Promise<string> {
    const contexts = await this.builder.build(options.retrievalQuery);
    const ranked = this.ranker.rank(contexts, options.retrievalQuery);
    const deduplicated = this.deduplicator.deduplicate(ranked);
    const compression = this.compressor.compress(deduplicated, options.tokenBudget);
    const assembled = this.assembler.assemble(compression.contexts);
    return this.promptBuilder.build({
      systemPrompt: options.systemPrompt,
      context: assembled,
      userQuery: options.userQuery,
      history: options.history,
    });
  }
}

export default ContextEngine;
