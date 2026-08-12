/**
 * AI layer — Gmail tools.
 *
 * Five tools that reuse the existing production `GmailService` (real data,
 * real authentication, existing error handling):
 *
 * - `gmail.summarizeInbox`    → recent inbox messages, normalized for Groq
 * - `gmail.findImportantEmails` → deterministic importance ranking
 * - `gmail.findUnreadEmails`  → actual unread emails (UNREAD label)
 * - `gmail.searchEmails`      → `GmailService.searchMessages(query)`
 * - `gmail.summarizeThread`   → `GmailService.getThread(threadId)`
 *
 * Tools are pure data retrieval + normalization — the Groq natural-language
 * summary is produced by the orchestrator, not inside the tool.
 */

import { z } from "zod";
import type { Tool } from "@/lib/tools/types";
import GmailService from "@/lib/services/gmail";
import type {
  ListMessagesResult,
  MessageDetail,
  MessageSummary,
  ThreadDetail,
} from "@/lib/services/gmail/types";
import { toolSuccess, truncate, type AIToolResult, type AIToolSource } from "./types";

/** Default / maximum number of messages a single tool fetches. */
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 50;

/** Max snippet length kept in normalized data (context-size safety). */
const SNIPPET_MAX = 300;

/** Input schema for the inbox/list/search tools. */
const messagesInputSchema = z.object({
  /** Optional maximum number of messages (1-50). */
  maxResults: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

/** Input schema for `gmail.searchEmails`. */
const searchInputSchema = z.object({
  /** Free-text Gmail search query (same syntax as the Gmail search box). */
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

/** Input schema for `gmail.summarizeThread`. */
const threadInputSchema = z.object({
  /** The Gmail thread id to summarize. */
  threadId: z.string().min(1),
  /** Optional maximum number of messages to include. */
  maxMessages: z.number().int().min(1).max(20).optional(),
});

export type MessagesToolInput = z.infer<typeof messagesInputSchema>;
export type SearchEmailsInput = z.infer<typeof searchInputSchema>;
export type SummarizeThreadInput = z.infer<typeof threadInputSchema>;

/**
 * Minimal structural surface of the production Gmail service used by the
 * tools (mirrors `lib/services/gmail/gmailService.ts`).
 */
export interface GmailToolService {
  listMessages(params?: { maxResults?: number; pageToken?: string; labelIds?: string[] }): Promise<ListMessagesResult>;
  searchMessages(q: string, maxResults?: number, pageToken?: string): Promise<ListMessagesResult>;
  getMessage(id: string): Promise<MessageDetail>;
  getThread(id: string): Promise<ThreadDetail>;
}

/** Normalize a message summary for display + LLM context. */
export function toEmailSummary(message: MessageSummary | MessageDetail) {
  return {
    id: message.id,
    threadId: message.threadId,
    subject: message.subject ?? "",
    from: message.from ?? "",
    date: message.date ?? null,
    snippet: truncate(message.snippet ?? "", SNIPPET_MAX),
    isUnread: message.isUnread,
  };
}

/** Source reference for a message. */
function messageSource(message: MessageSummary | MessageDetail): AIToolSource {
  return { integration: "gmail", type: "message", id: message.id, title: message.subject ?? undefined };
}

/** Fetch recent messages with a bounded default. */
async function listRecentMessages(service: GmailToolService, maxResults?: number): Promise<MessageSummary[]> {
  const result = await service.listMessages({ maxResults: maxResults ?? DEFAULT_MAX_RESULTS });
  return result.messages;
}

/**
 * Fetch recent messages, ranked deterministically by importance:
 * unread messages first, then recency (date desc). This is the
 * "deterministic metadata/filtering first" step; the Groq summary step in
 * the orchestrator explains *why* each message matters.
 */
export function rankImportantMessages(messages: readonly MessageSummary[], limit: number) {
  return [...messages]
    .sort((a, b) => {
      if (a.isUnread !== b.isUnread) return a.isUnread ? -1 : 1;
      return (b.date ?? "").localeCompare(a.date ?? "");
    })
    .slice(0, limit)
    .map((message) => ({
      ...toEmailSummary(message),
      reason: message.isUnread ? "Unread" : "Recent",
    }));
}

/** Summarize the recent inbox. */
export class GmailSummarizeInboxTool implements Tool {
  readonly id = "gmail.summarizeInbox";
  readonly description = "Fetch the user's recent Gmail inbox messages for summarization.";
  readonly inputSchema = messagesInputSchema;

  constructor(private readonly service: GmailToolService = GmailService) {}

  async execute(input: MessagesToolInput): Promise<AIToolResult> {
    const messages = await listRecentMessages(this.service, input.maxResults);
    return toolSuccess(
      this.id,
      {
        count: messages.length,
        messages: messages.map(toEmailSummary),
      },
      messages.map(messageSource),
    );
  }
}

/** Find the most important emails using deterministic ranking. */
export class GmailFindImportantEmailsTool implements Tool {
  readonly id = "gmail.findImportantEmails";
  readonly description = "Find the user's important recent emails (unread and recent messages).";
  readonly inputSchema = messagesInputSchema;

  constructor(private readonly service: GmailToolService = GmailService) {}

  async execute(input: MessagesToolInput): Promise<AIToolResult> {
    // Fetch a slightly wider pool so ranking has material to work with.
    const messages = await listRecentMessages(this.service, input.maxResults ?? 30);
    const limit = input.maxResults ?? 10;
    const important = rankImportantMessages(messages, limit);
    return toolSuccess(
      this.id,
      {
        count: important.length,
        emails: important,
      },
      messages.map(messageSource).slice(0, limit),
    );
  }
}

/** Return the user's actual unread emails (UNREAD label). */
export class GmailFindUnreadEmailsTool implements Tool {
  readonly id = "gmail.findUnreadEmails";
  readonly description = "List the user's unread Gmail messages.";
  readonly inputSchema = messagesInputSchema;

  constructor(private readonly service: GmailToolService = GmailService) {}

  async execute(input: MessagesToolInput): Promise<AIToolResult> {
    const result = await this.service.listMessages({
      maxResults: input.maxResults ?? 30,
      labelIds: ["UNREAD"],
    });
    const unread = result.messages.filter((message) => message.isUnread);
    return toolSuccess(
      this.id,
      {
        count: unread.length,
        emails: unread.map(toEmailSummary),
      },
      unread.map(messageSource),
    );
  }
}

/** Search the user's Gmail. */
export class GmailSearchEmailsTool implements Tool {
  readonly id = "gmail.searchEmails";
  readonly description = "Search the user's Gmail messages by query text.";
  readonly inputSchema = searchInputSchema;

  constructor(private readonly service: GmailToolService = GmailService) {}

  async execute(input: SearchEmailsInput): Promise<AIToolResult> {
    const result = await this.service.searchMessages(input.query, input.maxResults ?? DEFAULT_MAX_RESULTS);
    const messages = result.messages;
    return toolSuccess(
      this.id,
      {
        query: input.query,
        count: messages.length,
        messages: messages.map(toEmailSummary),
      },
      messages.map(messageSource),
    );
  }
}

/** Summarize a Gmail thread. */
export class GmailSummarizeThreadTool implements Tool {
  readonly id = "gmail.summarizeThread";
  readonly description = "Fetch a Gmail thread's messages for conversation summarization.";
  readonly inputSchema = threadInputSchema;

  constructor(private readonly service: GmailToolService = GmailService) {}

  async execute(input: SummarizeThreadInput): Promise<AIToolResult> {
    const thread = await this.service.getThread(input.threadId);
    const messages = thread.messages.slice(0, input.maxMessages ?? 10).map((message) => ({
      id: message.id,
      subject: message.subject ?? "",
      from: message.from ?? "",
      date: message.date ?? null,
      preview: truncate(message.preview ?? message.snippet ?? "", 500),
    }));
    return toolSuccess(
      this.id,
      {
        threadId: thread.id,
        count: messages.length,
        messages,
      },
      messages.map((message) => ({
        integration: "gmail" as const,
        type: "message",
        id: message.id,
        title: message.subject || undefined,
      })),
    );
  }
}
