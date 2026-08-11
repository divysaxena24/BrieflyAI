/**
 * Conversation layer — conversation summarizer (deterministic compression).
 *
 * Fits conversations into token/message budgets using deterministic
 * truncation only. There is no AI, no LLM, no provider, and no semantic
 * summarization — the "summary" is a structural window: a leading `system`
 * message (when present) is always preserved, and the remaining messages are
 * selected from the most recent end backward until both the token budget and
 * the message cap are satisfied.
 *
 * Reuses the shared token estimation (`estimateTokens`, `MESSAGE_OVERHEAD_TOKENS`,
 * and `estimateConversationTokens` from `./types`) — no token math is
 * reimplemented here. All operations are pure and deterministic.
 */

import {
  cloneConversation,
  estimateConversationTokens,
  MESSAGE_OVERHEAD_TOKENS,
  type Conversation,
  type ConversationMessage,
} from "./types";
import { estimateTokens } from "@/lib/context/tokenBudget";

export { estimateConversationTokens } from "./types";

/** Options accepted by {@link summarizeConversation}. */
export interface SummarizeOptions {
  /** Hard cap on the summarized conversation's estimated tokens. */
  readonly maxTokens?: number;
  /** Hard cap on the summarized conversation's message count. */
  readonly maxMessages?: number;
}

/**
 * Return the longest suffix of `messages` (most recent, oldest first in the
 * result) whose estimated token cost — `MESSAGE_OVERHEAD_TOKENS` plus
 * `estimateTokens(content)` per message — does not exceed `maxTokens`.
 *
 * - A non-positive `maxTokens` yields `[]`.
 * - A `maxTokens` at least as large as the whole transcript returns every
 *   message.
 * - Messages are shared by reference (never copied, never mutated); the
 *   returned array is new. Deterministic, O(n).
 */
export function summarizeWindow(
  messages: readonly ConversationMessage[],
  maxTokens: number,
): ConversationMessage[] {
  if (maxTokens <= 0) return [];

  const reversed: ConversationMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content);
    if (used + cost > maxTokens) break;
    reversed.push(message);
    used += cost;
  }
  return reversed.reverse();
}

/**
 * Return a summarized copy of `conversation` that satisfies `options`.
 *
 * - When the conversation already fits every cap, the SAME conversation
 *   object is returned (no copying, no mutation).
 * - Otherwise a new conversation is returned whose messages are the leading
 *   `system` message (when the transcript starts with one) plus the most
 *   recent messages that fit the remaining token budget and the remaining
 *   message capacity. The oldest non-system messages are dropped first.
 * - `maxTokens` and `maxMessages` are both enforced when both are given. The
 *   leading system message is always preserved and counts against the caps;
 *   when the budget is too small even for it, only the system message (or an
 *   empty transcript) remains.
 * - All metadata (id, createdAt, updatedAt, title, tags, state) is preserved.
 *   The input conversation is never mutated.
 */
export function summarizeConversation(
  conversation: Conversation,
  options: SummarizeOptions = {},
): Conversation {
  if (fitsWithinCaps(conversation, options)) return conversation;

  const messages = selectMessages(conversation.messages, options);
  return cloneConversation({ ...conversation, messages });
}

/**
 * Return `conversation` unchanged when its estimated tokens already fit
 * `maxTokens`; otherwise return the token-truncated summary (see
 * `summarizeConversation`). The input is never mutated.
 */
export function truncateIfNeeded(conversation: Conversation, maxTokens: number): Conversation {
  if (estimateConversationTokens(conversation) <= maxTokens) return conversation;
  return summarizeConversation(conversation, { maxTokens });
}

/** Whether a conversation already satisfies every cap in `options`. */
function fitsWithinCaps(conversation: Conversation, options: SummarizeOptions): boolean {
  if (options.maxTokens !== undefined && estimateConversationTokens(conversation) > options.maxTokens) {
    return false;
  }
  if (
    options.maxMessages !== undefined &&
    conversation.messages.length > options.maxMessages
  ) {
    return false;
  }
  return true;
}

/**
 * Select the summarized message list: the leading system message (when
 * present) plus the most recent messages that fit the remaining budget and
 * capacity. Deterministic; the input array is never mutated.
 */
function selectMessages(
  messages: readonly ConversationMessage[],
  options: SummarizeOptions,
): readonly ConversationMessage[] {
  // A zero (or negative) message cap yields no messages, even with a head.
  if (options.maxMessages !== undefined && options.maxMessages <= 0) return [];

  const headCount = messages.length > 0 && messages[0].role === "system" ? 1 : 0;

  // Token budget left for the tail after reserving the system head.
  let tailBudget = options.maxTokens;
  if (tailBudget !== undefined) {
    for (let index = 0; index < headCount; index += 1) {
      tailBudget -= MESSAGE_OVERHEAD_TOKENS + estimateTokens(messages[index].content);
    }
    if (tailBudget < 0) tailBudget = 0;
  }

  // Message capacity left for the tail after reserving the system head.
  const tailCapacity =
    options.maxMessages === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, options.maxMessages - headCount);

  const tailSource = messages.slice(headCount);
  const windowed =
    tailBudget === undefined ? [...tailSource] : summarizeWindow(tailSource, tailBudget);
  // slice(-0) is the whole array, so a zero tail capacity must short-circuit.
  const capped =
    tailCapacity === 0 ? [] : windowed.length <= tailCapacity ? windowed : windowed.slice(-tailCapacity);

  return [...messages.slice(0, headCount), ...capped];
}
