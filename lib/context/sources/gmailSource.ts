/**
 * Context Engine — Gmail context source.
 *
 * `GmailSource` is the second real `ContextSource`: it retrieves relevant
 * emails from a Gmail service and converts each email into a `Context` object
 * consumed by the pipeline.
 *
 * Note: the repository's existing Gmail service
 * (`lib/services/gmail/gmailService.ts`) exposes a different surface
 * (`listMessages`, `getMessage`, `searchMessages`, ...) and does not yet
 * provide the `isAvailable(userId)` / `retrieveRelevantEmails(...)` contract
 * this source depends on. This module therefore defines the minimal
 * structural contract (`GmailService` / `GmailEmail`) in-file; a future
 * adapter or service extension satisfying that shape is required to wire this
 * source to the live API.
 */

import type { Context, ContextMetadata, RetrievalQuery } from "@/lib/context/types";
import { estimateTokens } from "@/lib/context/tokenBudget";
import { ContextSourceBase } from "./contextSource";

/** Source id used by `GmailSource`. */
export const GMAIL_SOURCE_ID = "gmail";

/** Default priority of `GmailSource` relative to other sources. */
export const GMAIL_SOURCE_PRIORITY = 80;

/** Default relevance used when an email carries no relevance score. */
export const DEFAULT_EMAIL_RELEVANCE = 0.5;

/**
 * A single email returned by a `GmailService`.
 */
export interface GmailEmail {
  /** Stable provider-side id of the email. */
  id: string;
  /** Email subject line. */
  subject: string;
  /** Email body text that will be sent to the LLM. */
  body: string;
  /** ISO timestamp of the email, or null/undefined when unknown. */
  timestamp?: string | null;
  /** Relevance score in [0, 1]; 0.5 is assumed when missing. */
  relevance?: number;
  /** Provider-side thread id the email belongs to, when known. */
  threadId?: string;
  /** Human-readable author/sender of the email, when known. */
  author?: string;
  /** Importance used during ranking. */
  importance?: ContextMetadata["importance"];
}

/**
 * Contract for the Gmail service consumed by `GmailSource`.
 *
 * The service decides how emails are searched and ranked for relevance.
 * `GmailSource` only depends on this surface.
 */
export interface GmailService {
  /** Whether Gmail is available for the user right now. */
  isAvailable(userId: string): Promise<boolean>;
  /**
   * Return the emails most relevant to a query, in relevance order
   * (best first). Implementations may use the query, conversation history,
   * and an item cap.
   */
  retrieveRelevantEmails(options: {
    userId: string;
    query: string;
    history?: string[];
    maxItems?: number;
  }): Promise<GmailEmail[]>;
}

/**
 * Second real context source: retrieves relevant emails and maps them to
 * `Context` items.
 */
export class GmailSource extends ContextSourceBase {
  private readonly gmailService: GmailService;

  constructor(gmailService: GmailService) {
    super(GMAIL_SOURCE_ID, GMAIL_SOURCE_PRIORITY);
    this.gmailService = gmailService;
  }

  /**
   * Whether Gmail is available for the user — delegated to the service.
   */
  async isAvailable(userId: string): Promise<boolean> {
    return this.gmailService.isAvailable(userId);
  }

  /**
   * Retrieve relevant emails and map them to `Context` items.
   *
   * - The service is called with `userId`, `query`, `history`, and `maxItems`
   *   from the retrieval query (missing optional fields forwarded as
   *   `undefined`).
   * - Every returned email is mapped to a new `Context` with `source`
   *   `"gmail"`, `metadata.kind` `"email"`, `metadata.entityId` set to the
   *   email id, `metadata.threadId`/`author`/`importance` copied through,
   *   `metadata.raw` set to the original email object, and `permissions`
   *   `null`. `tokenEstimate` uses `estimateTokens(body)`; a missing
   *   timestamp maps to `null` and a missing relevance to 0.5.
   * - Input order is preserved.
   * - A throwing service yields `[]` (never throws, no logging, no retries).
   * - Inputs are never mutated; each returned item is a new object.
   */
  async retrieve(query: RetrievalQuery): Promise<Context[]> {
    let emails: GmailEmail[];
    try {
      emails = await this.gmailService.retrieveRelevantEmails({
        userId: query.userId,
        query: query.query,
        history: query.history,
        maxItems: query.maxItems,
      });
    } catch {
      return [];
    }
    return emails.map((email) => this.toContext(email));
  }

  /** Map an email to a `Context` object (new object, no mutation). */
  private toContext(email: GmailEmail): Context {
    return {
      id: email.id,
      source: GMAIL_SOURCE_ID,
      title: email.subject,
      content: email.body,
      timestamp: email.timestamp ?? null,
      relevance: email.relevance ?? DEFAULT_EMAIL_RELEVANCE,
      tokenEstimate: estimateTokens(email.body),
      truncated: false,
      compressed: false,
      metadata: {
        kind: "email",
        entityId: email.id,
        threadId: email.threadId,
        author: email.author,
        importance: email.importance,
        raw: email,
      },
      permissions: null,
    };
  }
}
