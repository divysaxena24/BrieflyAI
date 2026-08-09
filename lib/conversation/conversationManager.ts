/**
 * Conversation layer — conversation manager (pure orchestration).
 *
 * The operation-facing facade over `ConversationRepository`. Every mutation is
 * an immutable step: the receiver is never changed, and each operation returns
 * the successor manager (with the successor repository) plus any artifact it
 * produced (created conversation, appended message).
 *
 * Guarantees:
 * - **Uses only `ConversationRepository`**: no AI, no context engine, no
 *   prompt builder, no memory, no database, no storage — pure orchestration
 *   of the repository's immutable transitions.
 * - **Immutability**: reads delegate to the backing repository (detached
 *   clones); mutations return a NEW manager, never touching `this`.
 * - **Determinism**: identical operation sequences produce deep-equal
 *   manager states.
 *
 * Lifecycle: `startConversation` → `appendMessage` (repeatedly) →
 * `renameConversation` / `archiveConversation` / `restoreConversation` /
 * `closeConversation` / `deleteConversation`.
 */

import { ConversationNotFoundError, ConversationRepository } from "./repository";
import {
  createMessage,
  type Conversation,
  type ConversationMessage,
  type CreateConversationInput,
  type CreateMessageInput,
} from "./types";

/**
 * Pure in-memory orchestration over a `ConversationRepository`.
 *
 * The backing repository is exposed as a public readonly field so downstream
 * composition (e.g. the restorer in the production wiring) can read the exact
 * state this manager operates on.
 */
export class ConversationManager {
  /** The backing immutable repository (never replaced in place). */
  readonly repository: ConversationRepository;

  /**
   * Build a manager over a repository. When omitted, an empty repository is
   * used. The repository is snapshotted by reference — the manager performs
   * no further copying because the repository is already immutable.
   */
  constructor(repository: ConversationRepository = new ConversationRepository()) {
    this.repository = repository;
  }

  /**
   * Return a detached clone of the stored conversation, or `undefined` when
   * the id is unknown. Delegates to the backing repository.
   */
  getConversation(conversationId: string): Conversation | undefined {
    return this.repository.getConversation(conversationId);
  }

  /** Return detached clones of every stored conversation, in insertion order. */
  listConversations(): Conversation[] {
    return this.repository.listConversations();
  }

  /** Whether a conversation with the given id is stored. */
  hasConversation(conversationId: string): boolean {
    return this.repository.hasConversation(conversationId);
  }

  /** Number of stored conversations. */
  count(): number {
    return this.repository.count();
  }

  /**
   * Build and store a new conversation and return it plus the successor
   * manager (appended at the end, preserving insertion order).
   * Throws `ConversationDuplicateError` for an already-stored id.
   */
  startConversation(input: CreateConversationInput): {
    manager: ConversationManager;
    conversation: Conversation;
  } {
    const { conversation, repository } = this.repository.createConversation(input);
    return { manager: new ConversationManager(repository), conversation };
  }

  /**
   * Append a message to a conversation and return the created message plus
   * the successor manager.
   *
   * - `metadata.updatedAt` becomes the latest of the stored `updatedAt` and
   *   the new message's `createdAt` (compared by `Date.parse`).
   * - All other metadata (title, tags, state) is preserved.
   * - Throws `ConversationNotFoundError` for unknown ids.
   */
  appendMessage(
    conversationId: string,
    input: CreateMessageInput,
  ): { manager: ConversationManager; message: ConversationMessage } {
    const current = this.requireConversation(conversationId);
    const message = createMessage(input);

    const updatedAt =
      Date.parse(message.createdAt) > Date.parse(current.metadata.updatedAt)
        ? message.createdAt
        : current.metadata.updatedAt;

    const updated: Conversation = {
      id: current.id,
      metadata: { ...current.metadata, updatedAt },
      messages: [...current.messages, message],
    };

    return {
      manager: new ConversationManager(this.repository.updateConversation(updated)),
      message,
    };
  }

  /**
   * Return the successor manager with the conversation's title replaced by
   * `title`. All other fields are preserved. Throws
   * `ConversationNotFoundError` for unknown ids.
   */
  renameConversation(conversationId: string, title: string): ConversationManager {
    const current = this.requireConversation(conversationId);
    const updated: Conversation = {
      id: current.id,
      metadata: { ...current.metadata, title },
      messages: current.messages,
    };
    return new ConversationManager(this.repository.updateConversation(updated));
  }

  /**
   * Return the successor manager with the conversation's state set to
   * `"archived"`. Throws `ConversationNotFoundError` for unknown ids.
   */
  archiveConversation(conversationId: string): ConversationManager {
    return new ConversationManager(this.repository.archiveConversation(conversationId));
  }

  /**
   * Return the successor manager with the conversation's state set to
   * `"active"` — the inverse of both `archiveConversation` and
   * `closeConversation`. Throws `ConversationNotFoundError` for unknown ids.
   */
  restoreConversation(conversationId: string): ConversationManager {
    return new ConversationManager(this.repository.restoreConversation(conversationId));
  }

  /**
   * Return the successor manager with the conversation's state set to
   * `"deleted"` — a soft delete: the conversation stays stored and is
   * recoverable via `restoreConversation`. Distinct from `deleteConversation`,
   * which removes the conversation entirely. Throws
   * `ConversationNotFoundError` for unknown ids.
   */
  closeConversation(conversationId: string): ConversationManager {
    const current = this.requireConversation(conversationId);
    const updated: Conversation = {
      id: current.id,
      metadata: { ...current.metadata, state: "deleted" },
      messages: current.messages,
    };
    return new ConversationManager(this.repository.updateConversation(updated));
  }

  /**
   * Return the successor manager with the conversation removed entirely
   * (hard delete). Throws `ConversationNotFoundError` for unknown ids.
   */
  deleteConversation(conversationId: string): ConversationManager {
    return new ConversationManager(this.repository.deleteConversation(conversationId));
  }

  /** Return a detached clone of the stored conversation or throw. */
  private requireConversation(conversationId: string): Conversation {
    const conversation = this.repository.getConversation(conversationId);
    if (conversation === undefined) {
      throw new ConversationNotFoundError(conversationId);
    }
    return conversation;
  }
}
