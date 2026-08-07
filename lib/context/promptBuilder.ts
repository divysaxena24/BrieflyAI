/**
 * Context Engine — prompt building (pure string construction).
 *
 * Builds the final deterministic prompt string that is passed to the LLM from
 * the assembled context (see `ContextAssembler`), the user query, optional
 * conversation history, and optional system instructions.
 *
 * This module performs no retrieval, ranking, deduplication, compression,
 * token estimation, or AI calls — it only constructs the prompt string below:
 *
 * ```text
 * ================ SYSTEM ================
 *
 * <system prompt>
 *
 * ================ HISTORY ================
 *
 * <conversation history>
 *
 * ================ CONTEXT ================
 *
 * <context block>
 *
 * ================ USER ================
 *
 * <user query>
 *
 * ================ ASSISTANT ================
 * ```
 */

/** Section headers. */
const SYSTEM_HEADER = "================ SYSTEM ================";
const HISTORY_HEADER = "================ HISTORY ================";
const CONTEXT_HEADER = "================ CONTEXT ================";
const USER_HEADER = "================ USER ================";
const ASSISTANT_HEADER = "================ ASSISTANT ================";

/** Placeholder rendered when no conversation history is provided. */
const NO_HISTORY = "(No conversation history)";

/** Placeholder rendered when the context block is empty. */
const NO_CONTEXT = "(No context)";

/**
 * Default system instructions used when `systemPrompt` is omitted or
 * `undefined` (an explicitly provided empty string is preserved).
 */
const DEFAULT_SYSTEM_PROMPT = [
  "You are BrieflyAI, an intelligent AI assistant.",
  "Answer only using the provided context whenever possible.",
  "If the context is insufficient, clearly say so instead of inventing information.",
].join("\n");

/** Options accepted by {@link PromptBuilder.build}. */
interface PromptBuilderOptions {
  /** Custom system instructions; defaults to the BrieflyAI system prompt. */
  systemPrompt?: string;
  /** The assembled context block, exactly as produced by `ContextAssembler`. */
  context: string;
  /** The user's query, appended verbatim. */
  userQuery: string;
  /** Optional conversation history; each entry rendered on its own line. */
  history?: string[];
}

/**
 * Pure builder that constructs the final LLM prompt.
 *
 * The prompt always contains the SYSTEM, HISTORY, CONTEXT, USER, and
 * ASSISTANT sections in that fixed order, with exactly one blank line
 * between sections, and ends immediately after the ASSISTANT header (no
 * trailing whitespace or blank line).
 */
export class PromptBuilder {
  /**
   * Build the final prompt string.
   *
   * - A missing `systemPrompt` uses the default BrieflyAI instructions.
   * - Omitted or empty `history` renders the `(No conversation history)`
   *   placeholder; otherwise entries are joined in original order, each on
   *   its own line, without modification or trimming. A non-empty history
   *   array is always treated as provided — even one holding only empty
   *   strings, which renders an empty content line (see the empty-query note
   *   below).
   * - An empty `context` renders the `(No context)` placeholder; otherwise
   *   the block is inserted verbatim (blank lines and all).
   * - `userQuery` is appended verbatim. An empty query still renders the USER
   *   section; its empty content line appears between the header and the
   *   ASSISTANT header, i.e. the USER and ASSISTANT headers are separated by
   *   an extra blank line compared to a non-empty query.
   *
   * The options object, the history array, and every string are never
   * mutated; only a string is returned.
   */
  build(options: PromptBuilderOptions): string {
    const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const history =
      options.history !== undefined && options.history.length > 0
        ? options.history.join("\n")
        : NO_HISTORY;
    const context = options.context === "" ? NO_CONTEXT : options.context;

    const sections = [
      `${SYSTEM_HEADER}\n\n${systemPrompt}`,
      `${HISTORY_HEADER}\n\n${history}`,
      `${CONTEXT_HEADER}\n\n${context}`,
      `${USER_HEADER}\n\n${options.userQuery}`,
    ];

    return `${sections.join("\n\n")}\n\n${ASSISTANT_HEADER}`;
  }
}
