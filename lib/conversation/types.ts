/**
 * Conversation layer — immutable domain models.
 *
 * Step 1 of the conversation pipeline: the pure, readonly data model for
 * conversations and their messages, plus the pure helper functions that
 * construct, clone, freeze, and measure them.
 *
 * No services, no database, no storage, no AI, no context retrieval, and no
 * side effects live here — only data and pure functions. Every function is
 * deterministic: identical inputs always produce identical outputs, and
 * caller-supplied objects/arrays are never referenced or mutated (they are
 * copied on entry, and the returned structures are detached).
 */

import { estimateTokens } from "@/lib/context/tokenBudget";

/** Role of a single conversation message. */
export type ConversationRole = "user" | "assistant" | "system" | "tool";

/** Lifecycle state of a conversation. */
export type ConversationState = "active" | "archived" | "deleted";

/** Default state assigned by `createConversation` when none is provided. */
export const DEFAULT_CONVERSATION_STATE: ConversationState = "active";

/**
 * Per-message token overhead (role/formatting framing) added by
 * `estimateConversationTokens` on top of the shared `estimateTokens` content
 * heuristic, mirroring the message-framing cost of chat-completion APIs.
 */
export const MESSAGE_OVERHEAD_TOKENS = 3;

/**
 * A single message within a conversation.
 *
 * `metadata` is an optional bag of extra structured fields (e.g. tool call
 * ids, attachments) — opaque to this layer.
 */
export interface ConversationMessage {
  /** Stable message id; deterministic when derived by `createMessage`. */
  readonly id: string;
  readonly role: ConversationRole;
  /** The message text. */
  readonly content: string;
  /** ISO-8601 UTC timestamp of the message. */
  readonly createdAt: string;
  /** Optional extra structured fields, opaque to this layer. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Structured metadata of a conversation.
 *
 * `updatedAt` is the latest of the conversation's `createdAt` and its
 * messages' `createdAt` values (see `createConversation`).
 */
export interface ConversationMetadata {
  /** Optional human-readable title. */
  readonly title?: string;
  /** ISO-8601 UTC timestamp of the conversation's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the most recent activity. */
  readonly updatedAt: string;
  readonly state: ConversationState;
  /** Optional stable tags; defaults to an empty array when created. */
  readonly tags?: readonly string[];
}

/**
 * An immutable conversation: metadata plus an ordered list of messages
 * (oldest first).
 */
export interface Conversation {
  /** Stable conversation id. */
  readonly id: string;
  readonly metadata: ConversationMetadata;
  readonly messages: readonly ConversationMessage[];
}

/**
 * Lightweight projection of a conversation for list/overview views.
 * Produced by later pipeline steps; defined here as a pure data shape.
 */
export interface ConversationSummary {
  readonly id: string;
  readonly title?: string;
  /** ISO-8601 UTC timestamp of the conversation's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the most recent activity. */
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly state: ConversationState;
  /** Optional short content preview (e.g. of the latest message). */
  readonly preview?: string;
}

/**
 * A stable reference to a message inside a conversation — the dedupe/citation
 * key of the conversation layer.
 */
export interface MessageReference {
  readonly conversationId: string;
  readonly messageId: string;
}

/**
 * Deterministic 32-bit FNV-1a hash of `value`, rendered as lowercase hex.
 * Used to derive stable message ids from a message's own contents, so
 * `createMessage` stays pure and deterministic.
 */
function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic message id derived from the message's own contents. */
function messageIdFor(role: ConversationRole, content: string, createdAt: string): string {
  return `msg-${hashString(`${role}:${content}:${createdAt}`)}`;
}

/** Options accepted by {@link createMessage}. */
export interface CreateMessageInput {
  readonly role: ConversationRole;
  readonly content: string;
  readonly createdAt: string;
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Build a new immutable message.
 *
 * - `id` defaults to a deterministic hash of role + content + createdAt.
 *   Derived ids are stable but not guaranteed unique across messages in one
 *   conversation (identical role + content + createdAt collide); callers that
 *   need per-conversation uniqueness should pass an explicit `id`.
 * - `metadata` is copied as a new record (top-level keys are detached from
 *   the caller; nested values are shared by reference).
 * - The returned object is new and detached from all inputs.
 */
export function createMessage(input: CreateMessageInput): ConversationMessage {
  return {
    id: input.id ?? messageIdFor(input.role, input.content, input.createdAt),
    role: input.role,
    content: input.content,
    createdAt: input.createdAt,
    ...(input.metadata !== undefined ? { metadata: { ...input.metadata } } : {}),
  };
}

/** Options accepted by {@link createConversation}. */
export interface CreateConversationInput {
  readonly id: string;
  /** ISO-8601 UTC timestamp of the conversation's creation. */
  readonly createdAt: string;
  readonly title?: string;
  readonly state?: ConversationState;
  readonly tags?: readonly string[];
  readonly messages?: readonly ConversationMessage[];
}

/**
 * Build a new immutable conversation.
 *
 * - `state` defaults to `"active"`; `tags` defaults to `[]`.
 * - `metadata.updatedAt` is the latest of `createdAt` and every message's
 *   `createdAt` (compared by `Date.parse`, so mixed ISO-8601 formats order
 *   correctly).
 * - The messages array and each message are copied (via `createMessage`), so
 *   the conversation never shares objects with the caller.
 */
export function createConversation(input: CreateConversationInput): Conversation {
  const messages = (input.messages ?? []).map((message) =>
    createMessage({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      metadata: message.metadata,
    }),
  );

  let updatedAt = input.createdAt;
  for (const message of messages) {
    // Date.parse comparison (not lexicographic) so mixed ISO-8601 formats
    // (e.g. with/without milliseconds) still order correctly.
    if (Date.parse(message.createdAt) > Date.parse(updatedAt)) {
      updatedAt = message.createdAt;
    }
  }

  const metadata: ConversationMetadata = {
    createdAt: input.createdAt,
    updatedAt,
    state: input.state ?? DEFAULT_CONVERSATION_STATE,
    tags: input.tags !== undefined ? [...input.tags] : [],
    ...(input.title !== undefined ? { title: input.title } : {}),
  };

  return { id: input.id, metadata, messages };
}

/**
 * Estimate the total token cost of a conversation: for every message,
 * `MESSAGE_OVERHEAD_TOKENS` plus the shared `estimateTokens(content)`
 * heuristic (ceil(content.length / 4)). Deterministic and pure.
 */
export function estimateConversationTokens(conversation: Conversation): number {
  let total = 0;
  for (const message of conversation.messages) {
    total += MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content);
  }
  return total;
}

/**
 * Deep-freeze a conversation in place and return it.
 *
 * Freezes the conversation, its metadata (and `tags`), the messages array,
 * and every message (and its `metadata`). Idempotent: freezing an already
 * frozen conversation is a no-op.
 */
export function freezeConversation(conversation: Conversation): Conversation {
  if (conversation.metadata.tags !== undefined) Object.freeze(conversation.metadata.tags);
  Object.freeze(conversation.metadata);
  for (const message of conversation.messages) {
    if (message.metadata !== undefined) Object.freeze(message.metadata);
    Object.freeze(message);
  }
  Object.freeze(conversation.messages);
  Object.freeze(conversation);
  return conversation;
}

/**
 * Return a deep, detached copy of a conversation.
 *
 * Every object is new — the conversation, its metadata (and `tags`), the
 * messages array, and each message (and its `metadata` record) — so mutating
 * the clone's own structure can never affect the source and vice versa.
 * Nested values inside message `metadata` are shared by reference (see
 * `createMessage`). The clone is not frozen (call `freezeConversation` to
 * freeze it). Values, including optional fields, are preserved exactly.
 */
export function cloneConversation(conversation: Conversation): Conversation {
  const metadata: ConversationMetadata = {
    createdAt: conversation.metadata.createdAt,
    updatedAt: conversation.metadata.updatedAt,
    state: conversation.metadata.state,
    ...(conversation.metadata.title !== undefined ? { title: conversation.metadata.title } : {}),
    ...(conversation.metadata.tags !== undefined ? { tags: [...conversation.metadata.tags] } : {}),
  };

  return {
    id: conversation.id,
    metadata,
    messages: conversation.messages.map((message) =>
      createMessage({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        metadata: message.metadata,
      }),
    ),
  };
}
