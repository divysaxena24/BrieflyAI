/**
 * Conversation layer — context restoration (conversation → Context Engine).
 *
 * Bridges the conversation layer and the Context Engine (Phase 5A): converts
 * restored conversations into `Context` objects (kind `"conversation"`) that
 * the existing `ContextEngine` pipeline can consume, and provides a
 * `ContextSource` that feeds them into the engine's retrieval stage.
 *
 * This module does not modify `ContextBuilder`, `ContextEngine`,
 * `PromptBuilder`, the ranker, the compressor, or the assembler — it only
 * produces standard `Context` objects and a standard `ContextSource` that plug
 * into the existing pipeline. Conversion is pure and deterministic.
 *
 * Content layout: one transcript line per message, `role: content`, oldest
 * first. An empty conversation renders an empty content string.
 */

import type { Context, ContextMetadata, ContextSource, RetrievalQuery } from "@/lib/context/types";
import { estimateTokens } from "@/lib/context/tokenBudget";
import { ContextSourceBase } from "@/lib/context/sources/contextSource";
import type { Conversation } from "./types";

/** Source id used by conversation contexts and the conversation source. */
export const CONVERSATION_SOURCE_ID = "conversation";

/** Default priority of the conversation source relative to other sources. */
export const CONVERSATION_SOURCE_PRIORITY = 100;

/** Default relevance used when a conversation carries no explicit relevance. */
export const DEFAULT_CONVERSATION_RELEVANCE = 0.5;

/** Fallback context title when a conversation has no title. */
function titleFor(conversation: Conversation): string {
  return conversation.metadata.title ?? `Conversation ${conversation.id}`;
}

/** Render the transcript as one `role: content` line per message. */
function renderTranscript(conversation: Conversation, maxMessages?: number): string {
  // slice(-0) is the whole array, so a non-positive cap must yield no messages
  // (mirrors restoreRecentMessages/summarizeWindow).
  const messages =
    maxMessages === undefined
      ? conversation.messages
      : maxMessages > 0
        ? conversation.messages.slice(-maxMessages)
        : [];
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

/** Options accepted by {@link conversationToContext} / {@link conversationToContexts}. */
export interface ConversationContextOptions {
  /** Cap the transcript to the `maxMessages` most recent messages. */
  readonly maxMessages?: number;
  /** Importance used during ranking (`metadata.importance`). */
  readonly importance?: ContextMetadata["importance"];
  /** Deep link back to the conversation in the app. */
  readonly url?: string;
  /** Relevance score in [0, 1]; 0.5 is assumed when missing. */
  readonly relevance?: number;
}

/**
 * Convert a conversation into a single `Context` object (kind
 * `"conversation"`).
 *
 * - `id` is the conversation id, `source` is `"conversation"`, `title` is the
 *   conversation title (falling back to `Conversation <id>`), `timestamp` is
 *   the conversation's `updatedAt`, `relevance` defaults to 0.5,
 *   `tokenEstimate` uses the shared `estimateTokens(content)` heuristic, and
 *   `permissions` is `null`.
 * - `metadata.entityId` and `metadata.conversationId` are the conversation
 *   id; `metadata.kind` is `"conversation"`.
 * - The transcript is one `role: content` line per message (oldest first),
 *   optionally capped to the most recent `maxMessages` messages.
 * - The conversation is never mutated; the returned object is new and shares
 *   no references with the input (message strings are copied by the join).
 */
export function conversationToContext(
  conversation: Conversation,
  options: ConversationContextOptions = {},
): Context {
  const content = renderTranscript(conversation, options.maxMessages);

  const metadata: ContextMetadata = {
    kind: "conversation",
    entityId: conversation.id,
    conversationId: conversation.id,
    ...(options.importance !== undefined ? { importance: options.importance } : {}),
    ...(options.url !== undefined ? { url: options.url } : {}),
  };

  return {
    id: conversation.id,
    source: CONVERSATION_SOURCE_ID,
    title: titleFor(conversation),
    content,
    timestamp: conversation.metadata.updatedAt,
    relevance: options.relevance ?? DEFAULT_CONVERSATION_RELEVANCE,
    tokenEstimate: estimateTokens(content),
    truncated: false,
    compressed: false,
    metadata,
    permissions: null,
  };
}

/**
 * Convert every conversation to a `Context` object, preserving input order.
 * Empty input yields `[]`. Pure and deterministic.
 */
export function conversationToContexts(
  conversations: readonly Conversation[],
  options: ConversationContextOptions = {},
): Context[] {
  return conversations.map((conversation) => conversationToContext(conversation, options));
}

/** Signature of the restore function consumed by `ConversationContextSource`. */
export type ConversationRestoreFn = (query: RetrievalQuery) => readonly Conversation[];

/**
 * A `ContextSource` that serves restored conversations as context items.
 *
 * `isAvailable` is always true — a conversation session exists even when it
 * holds no messages yet (the restore function then yields an empty list and
 * retrieval returns `[]`). `retrieve` maps the restore function's output to
 * `Context` objects in order.
 */
export class ConversationContextSource extends ContextSourceBase implements ContextSource {
  private readonly restore: ConversationRestoreFn;

  /**
   * Build a conversation source from a restore function. The function is
   * snapshotted at construction time and invoked on every `retrieve`; it may
   * close over the exact conversations to restore.
   */
  constructor(
    restore: ConversationRestoreFn,
    priority: number = CONVERSATION_SOURCE_PRIORITY,
  ) {
    super(CONVERSATION_SOURCE_ID, priority);
    this.restore = restore;
  }

  /**
   * Retrieve the restored conversations as context items, preserving order.
   * The query is forwarded to the restore function; the conversations are
   * never mutated. Never throws.
   */
  async retrieve(query: RetrievalQuery): Promise<Context[]> {
    return conversationToContexts(this.restore(query));
  }
}
