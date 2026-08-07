/**
 * Context Engine — Gmail service adapter.
 *
 * Bridges the repository's production Gmail service
 * (`lib/services/gmail/gmailService.ts`) to the `GmailService` contract
 * consumed by `GmailSource`.
 *
 * The production service is a request-scoped static API: it derives the
 * current user from the request context and exposes `createClientForUser`,
 * `listMessages`, and `searchMessages` (returning `MessageSummary[]`). The
 * contract surface differs, so this adapter performs pure delegation plus
 * field mapping:
 *
 * - `isAvailable` probes the production service's client creation; any
 *   failure (unauthenticated, integration not connected, invalid token)
 *   means Gmail is unavailable for the user.
 * - `retrieveRelevantEmails` delegates to `searchMessages` when a query is
 *   provided and to `listMessages` otherwise, then maps each production
 *   `MessageSummary` into the `GmailEmail` contract shape — ordering
 *   preserved, no filtering, no reranking, no deduplication, no truncation.
 *
 * Service failures are forwarded, never swallowed; `GmailSource` already
 * converts retrieval failures into an empty result. Because the production
 * service is request-scoped, the `userId` accepted by the contract is not
 * forwarded to it.
 */

import GmailService from "@/lib/services/gmail";
import type { ListMessagesResult, MessageSummary } from "@/lib/services/gmail/types";
import type { GmailEmail, GmailService as GmailServiceContract } from "@/lib/context/sources/gmailSource";

/**
 * Minimal structural surface of the production Gmail service that the adapter
 * depends on. Mirrors the static members of `lib/services/gmail/gmailService.ts`.
 */
export interface ProductionGmailService {
  /** Resolve the current user's Gmail client and integration (throws when unavailable). */
  createClientForUser(): Promise<unknown>;
  /** List recent messages for the current user. */
  listMessages(params?: { maxResults?: number; pageToken?: string; labelIds?: string[] }): Promise<ListMessagesResult>;
  /** Search messages for the current user. */
  searchMessages(q: string, maxResults?: number, pageToken?: string): Promise<ListMessagesResult>;
}

/**
 * Pure adapter exposing the `GmailSource`-required `GmailService` contract
 * over the production Gmail service.
 */
export class GmailServiceAdapter implements GmailServiceContract {
  private readonly service: ProductionGmailService;

  constructor(service: ProductionGmailService = GmailService) {
    this.service = service;
  }

  /**
   * Whether Gmail is available for the user.
   *
   * Delegates to the production service by attempting to create a client for
   * the current user. Any failure (unauthenticated, integration not
   * connected, invalid token) means Gmail is unavailable. No caching, no
   * retries, no logging.
   *
   * The production service resolves the user from the request context, so
   * `userId` is accepted for contract compatibility but not forwarded.
   */
  async isAvailable(userId: string): Promise<boolean> {
    // The production service resolves the user from the request context, so
    // the contract's `userId` is not forwarded to it.
    void userId;
    try {
      await this.service.createClientForUser();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieve the emails most relevant to a query.
   *
   * A non-empty query is delegated to `searchMessages(query, maxItems)`
   * (query passed verbatim); an empty/blank query lists recent messages via
   * `listMessages({ maxResults: maxItems })`. The production response is
   * mapped field-by-field into `GmailEmail` objects, preserving order.
   * No filtering, no reranking, no deduplication, no truncation.
   *
   * Service failures are forwarded (never swallowed); `GmailSource` handles
   * them by returning `[]`.
   */
  async retrieveRelevantEmails(options: {
    userId: string;
    query: string;
    history?: string[];
    maxItems?: number;
  }): Promise<GmailEmail[]> {
    const { query, maxItems } = options;
    const result =
      query.trim().length > 0
        ? await this.service.searchMessages(query, maxItems)
        : await this.service.listMessages({ maxResults: maxItems });
    return result.messages.map((message) => this.toEmail(message));
  }

  /**
   * Map a production `MessageSummary` to the `GmailEmail` contract.
   *
   * - `body` maps to the snippet the production API exposes (full bodies are
   *   intentionally not returned for privacy).
   * - Required `subject`/`body` normalize a `null` production value to an
   *   empty string — the neutral "no value" representation.
   * - Optional values that are missing (`date`, `from`) map to `undefined`.
   * - `relevance` and `importance` are not produced by the service and are
   *   intentionally omitted (never invented); `GmailSource` defaults
   *   relevance to 0.5.
   */
  private toEmail(message: MessageSummary): GmailEmail {
    return {
      id: message.id,
      subject: message.subject ?? "",
      body: message.snippet ?? "",
      timestamp: message.date ?? undefined,
      threadId: message.threadId,
      author: message.from ?? undefined,
    };
  }
}
