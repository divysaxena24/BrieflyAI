/**
 * Conversation layer — immutable in-memory conversation repository.
 *
 * `ConversationRepository` is the storage facade of the conversation layer: a
 * private, immutable collection of `Conversation` objects held in insertion
 * order. Every mutation returns a NEW repository — the original is never
 * changed — so the repository is safe to share and trivial to reason about.
 *
 * Guarantees:
 * - **Constructor snapshot**: the initial conversations are copied on entry;
 *   later caller mutation of those objects never affects the repository.
 * - **Detached clones**: every stored conversation is deep-frozen internally,
 *   and every read returns a fresh detached clone, so callers can never reach
 *   (or corrupt) the internal collection.
 * - **Insertion order**: `listConversations()` returns conversations in the
 *   order they were created; `updateConversation` keeps a conversation's
 *   position; `deleteConversation` removes it.
 * - **No caching, no singleton, no storage, no database**: this is pure
 *   in-memory state with no side effects and no shared global instance.
 *
 * All operations are deterministic: identical operation sequences produce
 * deep-equal repository states.
 */

import { AppError } from "@/lib/errors";
import {
  cloneConversation,
  createConversation,
  freezeConversation,
  type Conversation,
  type ConversationState,
  type CreateConversationInput,
} from "./types";

/** Raised when an operation targets a conversation id that is not stored. */
export class ConversationNotFoundError extends AppError {
  constructor(conversationId: string) {
    super(`Conversation not found: ${conversationId}`, 404, "conversation_not_found");
  }
}

/** Raised when a conversation is created with an id that is already stored. */
export class ConversationDuplicateError extends AppError {
  constructor(conversationId: string) {
    super(`Conversation already exists: ${conversationId}`, 409, "conversation_duplicate_id");
  }
}

/**
 * Immutable in-memory collection of conversations.
 *
 * All methods are pure with respect to the repository: reads never mutate,
 * and mutations return the successor repository without touching `this`.
 */
export class ConversationRepository {
  /** The stored conversations, oldest first, deep-frozen. */
  private readonly conversations: readonly Conversation[];

  /**
   * Build a repository from an initial set of conversations.
   *
   * Every conversation is copied (detached from the caller) and deep-frozen;
   * the internal array itself is frozen. Insertion order of the input is
   * preserved.
   */
  constructor(initialConversations: readonly Conversation[] = []) {
    this.conversations = Object.freeze(
      initialConversations.map((conversation) =>
        freezeConversation(cloneConversation(conversation)),
      ),
    );
  }

  /**
   * Build and store a new conversation from its input.
   *
   * Throws `ConversationDuplicateError` when a conversation with the same id
   * is already stored. Returns the stored conversation plus the successor
   * repository (appended at the end, preserving insertion order).
   */
  createConversation(input: CreateConversationInput): {
    conversation: Conversation;
    repository: ConversationRepository;
  } {
    if (this.hasConversation(input.id)) {
      throw new ConversationDuplicateError(input.id);
    }
    const conversation = freezeConversation(createConversation(input));
    return {
      conversation,
      repository: new ConversationRepository([...this.conversations, conversation]),
    };
  }

  /**
   * Return a detached clone of the stored conversation, or `undefined` when
   * the id is unknown. The clone is unfrozen so callers may work with it
   * freely; mutating it never affects the repository.
   */
  getConversation(conversationId: string): Conversation | undefined {
    const stored = this.find(conversationId);
    return stored === undefined ? undefined : cloneConversation(stored);
  }

  /**
   * Replace the stored conversation with the same id as `conversation` by a
   * detached copy of it. The conversation keeps its insertion position.
   * Throws `ConversationNotFoundError` for unknown ids.
   */
  updateConversation(conversation: Conversation): ConversationRepository {
    this.require(conversation.id);
    return new ConversationRepository(
      this.conversations.map((stored) =>
        stored.id === conversation.id
          ? freezeConversation(cloneConversation(conversation))
          : stored,
      ),
    );
  }

  /**
   * Remove the conversation with the given id from the collection.
   * Throws `ConversationNotFoundError` for unknown ids.
   */
  deleteConversation(conversationId: string): ConversationRepository {
    this.require(conversationId);
    return new ConversationRepository(
      this.conversations.filter((conversation) => conversation.id !== conversationId),
    );
  }

  /**
   * Return the successor repository with the conversation's state set to
   * `"archived"`. All other fields are preserved (including its messages,
   * which are shared with the stored copy — safe because both are frozen).
   * Throws `ConversationNotFoundError` for unknown ids.
   */
  archiveConversation(conversationId: string): ConversationRepository {
    return this.withState(conversationId, "archived");
  }

  /**
   * Return the successor repository with the conversation's state set to
   * `"active"`. All other fields are preserved. Throws
   * `ConversationNotFoundError` for unknown ids.
   */
  restoreConversation(conversationId: string): ConversationRepository {
    return this.withState(conversationId, "active");
  }

  /** Return detached clones of every stored conversation, in insertion order. */
  listConversations(): Conversation[] {
    return this.conversations.map(cloneConversation);
  }

  /** Whether a conversation with the given id is stored. */
  hasConversation(conversationId: string): boolean {
    return this.conversations.some((conversation) => conversation.id === conversationId);
  }

  /** Number of stored conversations. */
  count(): number {
    return this.conversations.length;
  }

  /** Return a new, empty repository. The receiver is never modified. */
  clear(): ConversationRepository {
    return new ConversationRepository();
  }

  /** Internal (frozen) lookup by id. */
  private find(conversationId: string): Conversation | undefined {
    return this.conversations.find((conversation) => conversation.id === conversationId);
  }

  /** Throw `ConversationNotFoundError` unless the id is stored. */
  private require(conversationId: string): void {
    if (!this.hasConversation(conversationId)) {
      throw new ConversationNotFoundError(conversationId);
    }
  }

  /**
   * Build the successor repository with the conversation's state flipped to
   * `state`, preserving every other field and the insertion position.
   */
  private withState(conversationId: string, state: ConversationState): ConversationRepository {
    const current = this.find(conversationId);
    if (current === undefined) {
      throw new ConversationNotFoundError(conversationId);
    }
    const next: Conversation = {
      id: current.id,
      metadata: { ...current.metadata, state },
      messages: current.messages,
    };
    return new ConversationRepository(
      this.conversations.map((stored) =>
        stored.id === conversationId ? freezeConversation(next) : stored,
      ),
    );
  }
}
