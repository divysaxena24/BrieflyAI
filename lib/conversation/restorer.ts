/**
 * Conversation layer — conversation restorer (pure retrieval).
 *
 * The read-side projection of the conversation layer: restores conversations
 * and message windows from a `ConversationRepository` without any
 * summarization, ranking, compression, storage changes, or AI.
 *
 * Guarantees:
 * - **Pure retrieval**: every method reads through the repository's detached
 *   clones; nothing is ever mutated, archived, deleted, or rewritten.
 * - **State-agnostic**: stored conversations are retrievable regardless of
 *   their `state` (active, archived, or soft-deleted), because the repository
 *   only removes conversations via `deleteConversation`.
 * - **Ordering**: messages are always returned oldest first, in insertion
 *   order; "recent" windows are tails of that order.
 * - **Determinism**: identical inputs produce deep-equal outputs.
 */

import { ConversationRepository } from "./repository";
import type { Conversation, ConversationMessage } from "./types";

/**
 * A bounded tail window of a conversation's messages.
 *
 * `messages` are the `maxMessages` most recent messages (oldest first),
 * `startIndex` is the index of the first window message within the full
 * transcript, `total` is the full transcript length, and `trimmed` is how
 * many of the oldest messages were cut from the front.
 */
export interface RestoredWindow {
  /** The windowed messages, oldest first. */
  readonly messages: readonly ConversationMessage[];
  /** Index of the first window message within the full transcript. */
  readonly startIndex: number;
  /** Number of messages in the full transcript. */
  readonly total: number;
  /** Number of messages cut from the front of the transcript. */
  readonly trimmed: number;
}

/**
 * Pure read-side access to a repository's conversations.
 *
 * The repository is captured at construction time; because repositories are
 * immutable, a restorer is always consistent with the exact repository it
 * was built from.
 */
export class ConversationRestorer {
  private readonly repository: ConversationRepository;

  constructor(repository: ConversationRepository) {
    this.repository = repository;
  }

  /**
   * Return a detached clone of the stored conversation, or `undefined` when
   * the id is unknown. The conversation is returned regardless of its
   * `state` (active, archived, or soft-deleted). Pure retrieval — the
   * repository is never changed.
   */
  restoreConversation(conversationId: string): Conversation | undefined {
    return this.repository.getConversation(conversationId);
  }

  /**
   * Return every message of a conversation, oldest first, as a fresh array.
   * Returns `[]` for an unknown conversation (never throws).
   */
  restoreMessages(conversationId: string): ConversationMessage[] {
    const conversation = this.restoreConversation(conversationId);
    return conversation === undefined ? [] : [...conversation.messages];
  }

  /**
   * Return the `count` most recent messages, oldest first. A non-positive
   * `count` yields `[]`; a `count` larger than the transcript returns all
   * messages. Returns `[]` for an unknown conversation (never throws).
   */
  restoreRecentMessages(conversationId: string, count: number): ConversationMessage[] {
    const messages = this.restoreMessages(conversationId);
    if (count <= 0) return [];
    return messages.slice(-count);
  }

  /**
   * Return a bounded tail window of the conversation: the `maxMessages` most
   * recent messages plus the window metadata (see `RestoredWindow`).
   *
   * - A non-positive `maxMessages` yields an empty window with
   *   `startIndex === total` and `trimmed === total`.
   * - A `maxMessages` at least as large as the transcript yields the full
   *   transcript with `startIndex === 0` and `trimmed === 0`.
   * - An unknown conversation yields an empty window (`total === 0`).
   */
  restoreWindow(conversationId: string, maxMessages: number): RestoredWindow {
    const messages = this.restoreMessages(conversationId);
    const total = messages.length;

    if (maxMessages <= 0) {
      return { messages: [], startIndex: total, total, trimmed: total };
    }

    const startIndex = Math.max(0, total - maxMessages);
    return {
      messages: messages.slice(startIndex),
      startIndex,
      total,
      trimmed: startIndex,
    };
  }

  /**
   * Return the most recent message with role `"assistant"`, or `undefined`
   * when the conversation is unknown or holds no assistant message.
   */
  restoreLastAssistantMessage(conversationId: string): ConversationMessage | undefined {
    const messages = this.restoreMessages(conversationId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return messages[index];
    }
    return undefined;
  }
}
