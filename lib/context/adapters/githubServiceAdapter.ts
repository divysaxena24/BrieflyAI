/**
 * Context Engine — GitHub service adapter.
 *
 * Bridges the repository's production GitHub service
 * (`lib/services/github/githubService.ts`) to the `GitHubService` contract
 * consumed by `GitHubSource`.
 *
 * The production service is a request-scoped static API: it derives the
 * current user from the request context and exposes `createClientForUser`,
 * `listRepositories`, and `searchRepositories` (returning `RepositorySummary[]`).
 * The contract surface differs, so this adapter performs pure delegation plus
 * field mapping:
 *
 * - `isAvailable` probes the production service's client creation; any
 *   failure (unauthenticated, integration not connected, invalid token)
 *   means GitHub is unavailable for the user.
 * - `retrieveRelevantItems` delegates to `searchRepositories` when a query is
 *   provided and to `listRepositories` otherwise, then maps each production
 *   `RepositorySummary` into the `GitHubItem` contract shape — ordering
 *   preserved, no filtering, no reranking, no deduplication, no truncation.
 *
 * Service failures are forwarded, never swallowed; `GitHubSource` already
 * converts retrieval failures into an empty result. Because the production
 * service is request-scoped, the `userId` accepted by the contract is not
 * forwarded to it.
 *
 * Field notes:
 * - The production service covers repositories only — it exposes no issues,
 *   pull requests, or commits APIs. `issueNumber` and `pullRequestNumber`
 *   therefore cannot be produced and stay `undefined` (never invented).
 * - `id`: the production `RepositorySummary.id` is numeric while the contract
 *   `GitHubItem.id` is a string, so it is stringified.
 * - `title` maps to the production repo `name`; `repository` maps to the
 *   `fullName` ("owner/repo") slug.
 * - `content` maps to the production `description` (metadata only — the
 *   service returns no issue/PR body text); `timestamp` maps to `updatedAt`.
 * - `relevance` and `importance` are not produced by the service and are
 *   intentionally omitted (never invented); `GitHubSource` defaults
 *   relevance to 0.5.
 */

import GitHubService from "@/lib/services/github";
import type {
  ListRepositoriesParams,
  ListRepositoriesResult,
  RepositorySummary,
  SearchRepositoriesParams,
  SearchRepositoriesResult,
} from "@/lib/services/github";
import type {
  GitHubItem,
  GitHubService as GitHubServiceContract,
} from "@/lib/context/sources/githubSource";

/**
 * Minimal structural surface of the production GitHub service that the
 * adapter depends on. Mirrors the static members of
 * `lib/services/github/githubService.ts`.
 */
export interface ProductionGitHubService {
  /** Resolve the current user's GitHub client and integration (throws when unavailable). */
  createClientForUser(): Promise<unknown>;
  /** List the current user's repositories. */
  listRepositories(params?: ListRepositoriesParams): Promise<ListRepositoriesResult>;
  /** Search repositories for the current user. */
  searchRepositories(params: SearchRepositoriesParams): Promise<SearchRepositoriesResult>;
}

/**
 * Pure adapter exposing the `GitHubSource`-required `GitHubService` contract
 * over the production GitHub service.
 */
export class GitHubServiceAdapter implements GitHubServiceContract {
  private readonly service: ProductionGitHubService;

  constructor(service: ProductionGitHubService = GitHubService) {
    this.service = service;
  }

  /**
   * Whether GitHub is available for the user.
   *
   * Delegates to the production service by attempting to create a client for
   * the current user. Any failure (unauthenticated, integration not
   * connected, invalid token) means GitHub is unavailable. No caching, no
   * retries, no logging.
   *
   * The production service resolves the user from the request context, so
   * the contract's `userId` is not forwarded to it.
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
   * Retrieve the items most relevant to a query.
   *
   * A non-empty query is delegated to `searchRepositories({ query,
   * perPage: maxItems })` (query passed verbatim; `maxItems` fills the
   * production `perPage` parameter — the real production signature is a
   * params object, not positional arguments); an empty/blank query lists
   * repositories via `listRepositories({ perPage: maxItems })`. The
   * production response is mapped field-by-field into `GitHubItem` objects,
   * preserving order. No filtering, no reranking, no deduplication, no
   * truncation. `history` is accepted for contract compatibility but
   * intentionally ignored (the production service performs no history-aware
   * retrieval).
   *
   * Service failures are forwarded (never swallowed); `GitHubSource` handles
   * them by returning `[]`.
   */
  async retrieveRelevantItems(args: {
    userId: string;
    query: string;
    history?: readonly string[];
    maxItems?: number;
  }): Promise<GitHubItem[]> {
    const { query, maxItems } = args;
    const result =
      query.trim().length > 0
        ? await this.service.searchRepositories({ query, perPage: maxItems })
        : await this.service.listRepositories({ perPage: maxItems });
    return result.repositories.map((repo) => this.toItem(repo));
  }

  /**
   * Map a production `RepositorySummary` to the `GitHubItem` contract.
   *
   * - `id` maps to the stringified production id (contract requires a string).
   * - Required `title`/`content` normalize a null production value to an
   *   empty string (the neutral "no value" representation).
   * - `timestamp` maps to `updatedAt`; a null timestamp maps to `undefined`.
   * - `repository` maps to the `fullName` slug, omitted when empty.
   * - `author` maps to the production `owner` login, omitted when missing.
   * - `issueNumber`/`pullRequestNumber`/`relevance`/`importance` are not
   *   produced by the repository-only service and are intentionally omitted
   *   (never invented); `GitHubSource` defaults relevance to 0.5.
   */
  private toItem(repo: RepositorySummary): GitHubItem {
    return {
      id: String(repo.id),
      title: repo.name ?? "",
      content: repo.description ?? "",
      timestamp: repo.updatedAt ?? undefined,
      repository: repo.fullName || undefined,
      author: repo.owner ?? undefined,
    };
  }
}
