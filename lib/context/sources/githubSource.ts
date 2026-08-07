/**
 * Context Engine — GitHub context source.
 *
 * `GitHubSource` is the fourth real `ContextSource`: it retrieves relevant
 * GitHub items (issues, pull requests, commits) from a GitHub service and
 * converts each item into a `Context` object consumed by the pipeline.
 *
 * Note: the repository may contain GitHub-related services; they are ignored
 * unless they already expose exactly this contract. This module defines the
 * minimal structural contract (`GitHubService` / `GitHubItem`) in-file, and
 * the future adapter must satisfy that shape.
 *
 * Type note: the spec maps `metadata.kind` to the source-level literal
 * `"github"`, which is not a member of `ContextMetadata["kind"]` in
 * `lib/context/types.ts` (which uses semantic kinds like `"issue"`/`"pr"`),
 * and adds `repository`/`issueNumber`/`pullRequestNumber` metadata fields
 * that `ContextMetadata` does not declare. Since no existing file may be
 * modified, the extended `GitHubMetadata` intersection documents those extra
 * fields and a single targeted assertion supplies the `"github"` kind; every
 * other field remains fully type-checked.
 */

import type { Context, ContextMetadata, RetrievalQuery } from "@/lib/context/types";
import { estimateTokens } from "@/lib/context/tokenBudget";
import { ContextSourceBase } from "./contextSource";

/** Source id used by `GitHubSource`. */
export const GITHUB_SOURCE_ID = "github";

/** Default priority of `GitHubSource` relative to other sources. */
export const GITHUB_SOURCE_PRIORITY = 40;

/** Default relevance used when an item carries no relevance score. */
export const DEFAULT_GITHUB_ITEM_RELEVANCE = 0.5;

/** Importance levels shared with the context pipeline. */
export type ContextImportance = "low" | "normal" | "high" | "critical";

/** "github" is a source-level kind; `ContextMetadata.kind` lacks the literal. */
const GITHUB_METADATA_KIND = "github" as unknown as ContextMetadata["kind"];

/**
 * Metadata of a GitHub context item: `ContextMetadata` plus the GitHub
 * source-specific fields the spec maps (`repository`, `issueNumber`,
 * `pullRequestNumber`).
 */
export type GitHubMetadata = ContextMetadata & {
  /** Repository slug the item belongs to, when known. */
  repository?: string;
  /** Issue number when the item is an issue. */
  issueNumber?: number;
  /** Pull request number when the item is a pull request. */
  pullRequestNumber?: number;
};

/**
 * A single GitHub item returned by a `GitHubService`.
 */
export interface GitHubItem {
  /** Stable provider-side id of the item. */
  id: string;
  /** Item title (issue/PR title, commit subject). */
  title: string;
  /** Item body text that will be sent to the LLM. */
  content: string;
  /** ISO timestamp of the item, or null/undefined when unknown. */
  timestamp?: string | null;
  /** Relevance score in [0, 1]; 0.5 is assumed when missing. */
  relevance?: number;
  /** Repository slug the item belongs to, when known. */
  repository?: string;
  /** Issue number when the item is an issue. */
  issueNumber?: number;
  /** Pull request number when the item is a pull request. */
  pullRequestNumber?: number;
  /** Human-readable author of the item, when known. */
  author?: string;
  /** Importance used during ranking. */
  importance?: ContextImportance;
}

/**
 * Contract for the GitHub service consumed by `GitHubSource`.
 *
 * The service decides how issues, pull requests, and commits are searched and
 * ranked for relevance. `GitHubSource` only depends on this surface.
 */
export interface GitHubService {
  /** Whether GitHub is available for the user right now. */
  isAvailable(userId: string): Promise<boolean>;
  /**
   * Return the items most relevant to a query, in relevance order
   * (best first). Implementations may use the query, conversation history,
   * and an item cap.
   */
  retrieveRelevantItems(args: {
    userId: string;
    query: string;
    history?: readonly string[];
    maxItems?: number;
  }): Promise<GitHubItem[]>;
}

/**
 * Fourth real context source: retrieves relevant GitHub items and maps them
 * to `Context` items.
 */
export class GitHubSource extends ContextSourceBase {
  private readonly service: GitHubService;

  constructor(service: GitHubService) {
    super(GITHUB_SOURCE_ID, GITHUB_SOURCE_PRIORITY);
    this.service = service;
  }

  /**
   * Whether GitHub is available for the user — delegated to the service.
   */
  async isAvailable(userId: string): Promise<boolean> {
    return this.service.isAvailable(userId);
  }

  /**
   * Retrieve relevant items and map them to `Context` items.
   *
   * - The service is called with `userId`, `query`, `history`, and `maxItems`
   *   from the retrieval query (missing optional fields forwarded as
   *   `undefined`).
   * - Every returned item is mapped to a new `Context` with `source`
   *   `"github"`, `metadata.kind` `"github"`, `metadata.entityId` set to the
   *   item id, `repository`/`issueNumber`/`pullRequestNumber`/`author`/
   *   `importance` copied through, `metadata.raw` set to the original item
   *   object (by reference), and `permissions` `null`. `tokenEstimate` uses
   *   `estimateTokens(content)`; a missing timestamp maps to `null` and a
   *   missing relevance to 0.5.
   * - Input order is preserved.
   * - A throwing service yields `[]` (never throws, no logging, no retries).
   * - Inputs are never mutated; each returned item is a new object.
   */
  async retrieve(query: RetrievalQuery): Promise<Context[]> {
    let items: GitHubItem[];
    try {
      items = await this.service.retrieveRelevantItems({
        userId: query.userId,
        query: query.query,
        history: query.history,
        maxItems: query.maxItems,
      });
    } catch {
      return [];
    }
    return items.map((item) => this.toContext(item));
  }

  /** Map an item to a `Context` object (new object, no mutation). */
  private toContext(item: GitHubItem): Context {
    const metadata: GitHubMetadata = {
      kind: GITHUB_METADATA_KIND,
      entityId: item.id,
      repository: item.repository,
      issueNumber: item.issueNumber,
      pullRequestNumber: item.pullRequestNumber,
      author: item.author,
      importance: item.importance,
      raw: item,
    };

    return {
      id: item.id,
      source: GITHUB_SOURCE_ID,
      title: item.title,
      content: item.content,
      timestamp: item.timestamp ?? null,
      relevance: item.relevance ?? DEFAULT_GITHUB_ITEM_RELEVANCE,
      tokenEstimate: estimateTokens(item.content),
      truncated: false,
      compressed: false,
      metadata,
      permissions: null,
    };
  }
}
