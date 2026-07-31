import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getUserIntegrationByPlatform, findUserByAuthId, logActivity } from "@/lib/db/queries";
import githubTokenManager from "@/lib/services/integrations/githubTokenManager";
import { GitHubClient } from "./githubClient";
import { buildSearchQuery } from "./githubUtils";
import type { PaginationInfo } from "./githubUtils";

const PLATFORM = "github"; // matches the platform stored by OAuth callback

/**
 * Structured log meta with the platform tag, mirroring the google-logger style.
 */
function logMeta(meta?: Record<string, unknown>) {
  return { platform: "github", ...(meta ?? {}) };
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

/** Raw repository payload returned by the GitHub REST API. */
interface RawRepository {
  id?: number;
  name?: string;
  full_name?: string;
  owner?: { login?: string; avatar_url?: string | null } | null;
  private?: boolean;
  html_url?: string;
  url?: string;
  description?: string | null;
  fork?: boolean;
  language?: string | null;
  stargazers_count?: number;
  watchers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  default_branch?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  pushed_at?: string | null;
  homepage?: string | null;
  size?: number | null;
  topics?: string[];
  license?: { key?: string | null; name?: string | null; spdx_id?: string | null } | null;
  visibility?: string | null;
  archived?: boolean;
  disabled?: boolean;
}

export interface RepositorySummary {
  id: number;
  name: string;
  fullName: string;
  owner: string | null;
  ownerAvatarUrl: string | null;
  description: string | null;
  htmlUrl: string;
  apiUrl: string;
  isPrivate: boolean;
  isFork: boolean;
  language: string | null;
  starCount: number;
  watchersCount: number;
  openIssuesCount: number;
  defaultBranch: string | null;
  updatedAt: string | null;
}

export interface RepositoryDetail extends RepositorySummary {
  homepage: string | null;
  topics: string[];
  visibility: string | null;
  license: { key: string | null; name: string | null; spdxId: string | null } | null;
  size: number | null;
  forksCount: number;
  createdAt: string | null;
  pushedAt: string | null;
  archived: boolean;
  disabled: boolean;
}

export interface ListRepositoriesParams {
  page?: number;
  perPage?: number;
  sort?: string;
  direction?: string;
  visibility?: string;
  affiliation?: string;
}

export interface ListRepositoriesResult {
  repositories: RepositorySummary[];
  pagination: PaginationInfo;
}

export interface SearchRepositoriesParams {
  query: string;
  sort?: string;
  order?: string;
  page?: number;
  perPage?: number;
}

export interface SearchRepositoriesResult {
  repositories: RepositorySummary[];
  totalCount: number;
  pagination: PaginationInfo;
}

// ──────────────────────────────────────────────
//  Service
// ──────────────────────────────────────────────

/**
 * GitHub repositories service.
 * Mirrors the Gmail/Calendar/Drive service architecture: resolves the current
 * user + integration, delegates HTTP to GitHubClient (no direct fetch()),
 * maps raw payloads to typed shapes, logs activity asynchronously, and maps
 * errors to AppError.
 */
export class GitHubService {
  /**
   * Resolve the current user + their GitHub integration and build a client.
   * Unlike the Google clients (which take a resolved access token), GitHubClient
   * takes the integrationId and resolves a valid token itself via
   * githubTokenManager.getValidAccessToken() on every request.
   */
  static async createClientForUser() {
    const user = await getCurrentUser();
    if (!user) throw new AppError("Not authenticated", 401, "authentication_required");

    // Resolve the application user ID — getCurrentUser() returns auth.users.id,
    // but integrations.user_id references users.id (the application-level ID)
    const appUser = await findUserByAuthId(user.id);
    if (!appUser) throw new AppError("User not found", 404, "user_not_found");

    const integration = await getUserIntegrationByPlatform(appUser.id, PLATFORM);
    if (!integration) throw new AppError("No GitHub integration found for user", 404, "github_not_connected");

    logger.debug("GitHubService: creating client", logMeta({ integrationId: integration.id }));
    return { client: new GitHubClient(integration.id), integration };
  }

  // ── Mappers ────────────────────────────────

  static toRepositorySummary(raw: RawRepository): RepositorySummary {
    return {
      id: raw.id ?? 0,
      name: raw.name ?? "",
      fullName: raw.full_name ?? "",
      owner: raw.owner?.login ?? null,
      ownerAvatarUrl: raw.owner?.avatar_url ?? null,
      description: raw.description ?? null,
      htmlUrl: raw.html_url ?? "",
      apiUrl: raw.url ?? "",
      isPrivate: raw.private ?? false,
      isFork: raw.fork ?? false,
      language: raw.language ?? null,
      starCount: raw.stargazers_count ?? 0,
      watchersCount: raw.watchers_count ?? 0,
      openIssuesCount: raw.open_issues_count ?? 0,
      defaultBranch: raw.default_branch ?? null,
      updatedAt: raw.updated_at ?? null,
    };
  }

  static toRepositoryDetail(raw: RawRepository): RepositoryDetail {
    return {
      ...GitHubService.toRepositorySummary(raw),
      homepage: raw.homepage ?? null,
      topics: raw.topics ?? [],
      visibility: raw.visibility ?? null,
      license: raw.license
        ? { key: raw.license.key ?? null, name: raw.license.name ?? null, spdxId: raw.license.spdx_id ?? null }
        : null,
      size: raw.size ?? null,
      forksCount: raw.forks_count ?? 0,
      createdAt: raw.created_at ?? null,
      pushedAt: raw.pushed_at ?? null,
      archived: raw.archived ?? false,
      disabled: raw.disabled ?? false,
    };
  }

  // ── Methods ────────────────────────────────

  /**
   * List the authenticated user's repositories.
   * GET /user/repos — supports page, perPage, sort, direction, visibility, affiliation.
   */
  static async listRepositories(params: ListRepositoriesParams = {}): Promise<ListRepositoriesResult> {
    logger.info("GitHubService: listRepositories request received", logMeta({ params }));
    const { client, integration } = await GitHubService.createClientForUser();
    try {
      const res = await client.get<RawRepository[]>("/user/repos", {
        query: {
          page: params.page,
          per_page: params.perPage,
          sort: params.sort,
          direction: params.direction,
          visibility: params.visibility,
          affiliation: params.affiliation,
        },
      });

      const repositories = (Array.isArray(res.data) ? res.data : []).map((r) => GitHubService.toRepositorySummary(r));

      logger.info("GitHubService: repositories returned", logMeta({ count: repositories.length }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Listed Repositories",
        details: `Listed ${repositories.length} repositories`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { repositories, pagination: res.pagination };
    } catch (err) {
      logger.error("GitHubService: listRepositories failed", logMeta({ error: String(err) }));
      return GitHubService.handleError(err, integration.id);
    }
  }

  /**
   * Get a single repository's metadata (incl. topics, default branch, license,
   * fork status, star/watcher/issue counts, description, homepage).
   * GET /repos/{owner}/{repo}
   */
  static async getRepository(owner: string, repo: string): Promise<RepositoryDetail> {
    logger.info("GitHubService: getRepository request received", logMeta({ owner, repo }));
    const { client, integration } = await GitHubService.createClientForUser();
    try {
      const res = await client.get<RawRepository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      const detail = GitHubService.toRepositoryDetail(res.data);

      logger.info("GitHubService: repository returned", logMeta({ fullName: detail.fullName }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Viewed Repository",
        details: `Viewed repository ${detail.fullName}`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return detail;
    } catch (err) {
      logger.error("GitHubService: getRepository failed", logMeta({ owner, repo, error: String(err) }));
      return GitHubService.handleError(err, integration.id);
    }
  }

  /**
   * Search repositories via the GitHub search API.
   * GET /search/repositories — supports query, sort, order, page, perPage.
   * The query string is built with the shared buildSearchQuery() utility.
   */
  static async searchRepositories(params: SearchRepositoriesParams): Promise<SearchRepositoriesResult> {
    logger.info("GitHubService: searchRepositories request received", logMeta({ params }));
    const { client, integration } = await GitHubService.createClientForUser();
    try {
      const q = buildSearchQuery({ term: params.query });
      const res = await client.get<{ total_count?: number; items?: RawRepository[] }>("/search/repositories", {
        query: {
          q,
          sort: params.sort,
          order: params.order,
          page: params.page,
          per_page: params.perPage,
        },
      });

      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      const repositories = items.map((r) => GitHubService.toRepositorySummary(r));
      const totalCount = res.data?.total_count ?? 0;

      logger.info("GitHubService: search completed", logMeta({ count: repositories.length, totalCount }));
      // Log activity asynchronously — never block the response
      logActivity({
        userId: integration.userId,
        platform: PLATFORM,
        action: "Searched Repositories",
        details: params.query ? `Searched for "${params.query}"` : `Listed all repositories`,
        integrationId: integration.id,
      }).catch((e) => logger.debug("logActivity failed", logMeta({ error: String(e) })));

      return { repositories, totalCount, pagination: res.pagination };
    } catch (err) {
      logger.error("GitHubService: searchRepositories failed", logMeta({ error: String(err) }));
      return GitHubService.handleError(err, integration.id);
    }
  }

  // ── Error handling ─────────────────────────

  /**
   * Centralize error handling: GitHubClient already throws AppError (mapped via
   * mapGitHubError), so rethrow it (invalidating the token on 401 so the UI
   * surfaces reconnection). Wrap any unexpected error into a generic AppError.
   */
  private static async handleError(err: unknown, integrationId: string): Promise<never> {
    if (err instanceof AppError) {
      if (err.status === 401) {
        try {
          await githubTokenManager.invalidate(integrationId);
        } catch (e) {
          logger.debug("GitHubService: failed to invalidate token", logMeta({ integrationId, error: String(e) }));
        }
      }
      throw err;
    }
    // Unexpected (non-AppError) failure — preserve the original message for debugging
    const detail = err instanceof Error ? err.message : String(err);
    throw new AppError("GitHub API error", 502, "github_error", detail);
  }
}

export default GitHubService;
