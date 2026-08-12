/**
 * AI layer — GitHub tools.
 *
 * Three tools that reuse the existing production `GitHubService`:
 *
 * - `github.repositorySummary`    → real repository metadata
 * - `github.recentActivity`       → real repository events (pushes/PRs/issues)
 * - `github.openIssuesSummary`    → real open issues
 *
 * Repository resolution always operates on the authenticated user's own
 * GitHub repositories (the same identity used by listRepositories /
 * getRepository / listIssues / listRepositoryEvents):
 *
 * - A caller-supplied reference ("owner/repo" or a github.com URL) is
 *   sanitized and verified against the user's actual repository list before
 *   any API call. A repo that is not in the user's accessible set is never
 *   reported as found.
 * - When the caller omits `repository`, the tools select the user's most
 *   recently updated, non-fork repository deterministically — real data,
 *   never invented, and never hardcoded.
 */

import { z } from "zod";
import type { Tool } from "@/lib/tools/types";
import GitHubService from "@/lib/services/github";
import type {
  ListIssuesResult,
  ListRepositoriesResult,
  ListRepositoryEventsResult,
  RepositoryDetail,
  RepositoryEventSummary,
} from "@/lib/services/github";
import { AppError } from "@/lib/errors";
import { toolSuccess, truncate, type AIToolResult, type AIToolSource } from "./types";

/** Cap for issue/event bodies kept in normalized data. */
const BODY_MAX = 300;

const repositoryInputSchema = z.object({
  /** \"owner/repo\", a github.com URL, or omit to use the first repository. */
  repository: z.string().min(1).max(300).optional(),
});

const repositoryLimitInputSchema = z.object({
  repository: z.string().min(1).max(300).optional(),
  /** Optional maximum number of items (1-100). */
  limit: z.number().int().min(1).max(100).optional(),
});

export type RepositoryToolInput = z.infer<typeof repositoryInputSchema>;
export type RepositoryLimitToolInput = z.infer<typeof repositoryLimitInputSchema>;

/**
 * Minimal structural surface of the production GitHub service used by the
 * tools (mirrors `lib/services/github/githubService.ts`).
 */
export interface GitHubToolService {
  getRepository(owner: string, repo: string): Promise<RepositoryDetail>;
  listRepositories(params?: { page?: number; perPage?: number; sort?: string; direction?: string }): Promise<ListRepositoriesResult>;
  listIssues(owner: string, repo: string, params?: { state?: "open" | "closed" | "all"; perPage?: number }): Promise<ListIssuesResult>;
  listRepositoryEvents(owner: string, repo: string, perPage?: number): Promise<ListRepositoryEventsResult>;
}

/** A resolved repository target. */
export interface ResolvedRepository {
  owner: string;
  repo: string;
  fullName: string;
}

/** Strip a trailing ".git" from a repository name (common in clone URLs). */
function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/i, "");
}

/**
 * Parse a repository reference ("owner/repo" or a github.com URL) into its
 * owner and repo parts. Trailing punctuation (e.g. "owner/repo." from an LLM)
 * and ".git" suffixes (clone URLs) are stripped so a well-formed reference is
 * never turned into a 404. Returns null for empty or non-repository input.
 *
 * A bare repository name (e.g. "briefly") parses with an empty owner — callers
 * resolve it against the authenticated user's own repositories by name.
 */
export function parseRepositoryReference(input: string): { owner: string; repo: string } | null {
  let ref = input.trim();
  if (!ref) return null;

  // Strip trailing punctuation LLMs often append (e.g. "owner/repo.").
  ref = ref.replace(/[.,;:!?)\]\s]+$/, "").trim();

  // Full URL form: https://github.com/owner/repo[/...]
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    try {
      const url = new URL(ref);
      if (url.hostname !== "github.com" && !url.hostname.endsWith(".github.com")) return null;
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length >= 2) return { owner: segments[0], repo: stripGitSuffix(segments[1]) };
      return null;
    } catch {
      return null;
    }
  }

  const segments = ref.split("/").filter(Boolean);
  if (segments.length === 2) return { owner: segments[0], repo: stripGitSuffix(segments[1]) };
  // A bare repository name — resolved against the user's own repos by name
  // (a bare owner like "acme" is not a resolvable repository reference).
  if (segments.length === 1) return { owner: "", repo: stripGitSuffix(segments[0]) };
  return null;
}

/**
 * Resolve the repository to operate on, always from the authenticated user's
 * own accessible repositories:
 *
 * 1. A caller-supplied reference is sanitized, matched against the user's
 *    repository list (case-insensitive), and verified via getRepository if it
 *    is not in the list. A repo that cannot be found is reported with a clean
 *    404 — never as a successful summary.
 * 2. When no reference is supplied, the user's most recently updated,
 *    non-fork repository is selected deterministically.
 */
export async function resolveRepository(
  service: GitHubToolService,
  repository?: string,
): Promise<ResolvedRepository> {
  const raw = repository?.trim();
  if (raw) {
    const parsed = parseRepositoryReference(raw);
    if (parsed) {
      // Verify against the authenticated user's own repositories first — this
      // uses the SAME identity as getRepository / listIssues / events.
      const { repositories } = await service.listRepositories({ perPage: 100 });
      const match = parsed.owner
        ? repositories.find(
            (r) => r.fullName && r.fullName.toLowerCase() === `${parsed.owner}/${parsed.repo}`.toLowerCase(),
          ) ??
          repositories.find(
            (r) =>
              r.name &&
              r.name.toLowerCase() === parsed.repo.toLowerCase() &&
              r.owner?.toLowerCase() === parsed.owner.toLowerCase(),
          )
        : // Bare repo name (no owner) — match the user's own repos by name.
          repositories.find((r) => r.name && r.name.toLowerCase() === parsed.repo.toLowerCase());
      if (match && match.owner && match.name) {
        return { owner: match.owner, repo: match.name, fullName: match.fullName || `${match.owner}/${match.name}` };
      }

      // An ownerless reference cannot be verified directly — fall through to
      // the deterministic default. An owner-qualified reference that is not in
      // the user's list may still be a public repo the token can read: verify
      // existence; a missing repo throws a clean 404 (never a fabricated
      // summary).
      if (parsed.owner) {
        const detail = await service.getRepository(parsed.owner, parsed.repo);
        if (detail && detail.owner && detail.name) {
          return { owner: detail.owner, repo: detail.name, fullName: detail.fullName || `${detail.owner}/${detail.name}` };
        }
      }
    }
    // The reference could not be parsed or resolved (e.g. "my repository") —
    // fall through to the deterministic default below instead of erroring.
  }

  // Deterministic default: most recently updated non-fork repository.
  const { repositories } = await service.listRepositories({ sort: "updated", direction: "desc", perPage: 20 });
  const first = repositories.find((r) => !r.isFork) ?? repositories[0];
  if (!first || !first.owner || !first.name) {
    throw new AppError("No GitHub repositories found for user", 404, "no_repositories");
  }
  return { owner: first.owner, repo: first.name, fullName: first.fullName };
}

/** Source reference for a repository. */
function repositorySource(repository: ResolvedRepository): AIToolSource {
  return {
    integration: "github",
    type: "repository",
    id: repository.fullName,
    title: repository.fullName,
    url: `https://github.com/${repository.fullName}`,
  };
}

/** Normalize a repository detail for display + LLM context. */
function toRepositoryDetail(repository: RepositoryDetail) {
  return {
    id: repository.id,
    name: repository.name,
    fullName: repository.fullName,
    owner: repository.owner,
    description: repository.description ?? "",
    language: repository.language,
    topics: repository.topics ?? [],
    isPrivate: repository.isPrivate,
    isFork: repository.isFork,
    starCount: repository.starCount,
    forksCount: repository.forksCount,
    openIssuesCount: repository.openIssuesCount,
    defaultBranch: repository.defaultBranch,
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
    pushedAt: repository.pushedAt,
    htmlUrl: repository.htmlUrl,
    license: repository.license?.name ?? null,
  };
}

/** Normalize a repository event for display + LLM context. */
export function toEventSummary(event: RepositoryEventSummary) {
  return {
    id: event.id,
    type: event.type,
    actor: event.actor,
    createdAt: event.createdAt,
    action: event.action,
    ref: event.ref,
    commitCount: event.commitCount,
    issueNumber: event.issueNumber,
    pullRequestNumber: event.pullRequestNumber,
    title: truncate(event.title ?? "", BODY_MAX),
  };
}

/** Summarize a repository's metadata. */
export class GitHubRepositorySummaryTool implements Tool {
  readonly id = "github.repositorySummary";
  readonly description = "Fetch a GitHub repository's metadata for summarization.";
  readonly inputSchema = repositoryInputSchema;

  constructor(private readonly service: GitHubToolService = GitHubService) {}

  async execute(input: RepositoryToolInput): Promise<AIToolResult> {
    const resolved = await resolveRepository(this.service, input.repository);
    const repository = await this.service.getRepository(resolved.owner, resolved.repo);
    return toolSuccess(
      this.id,
      { repository: toRepositoryDetail(repository) },
      [repositorySource(resolved)],
    );
  }
}

/** List recent activity (pushes/PRs/issues) for a repository. */
export class GitHubRecentActivityTool implements Tool {
  readonly id = "github.recentActivity";
  readonly description = "List recent activity (pushes, pull requests, issues) for a GitHub repository.";
  readonly inputSchema = repositoryLimitInputSchema;

  constructor(private readonly service: GitHubToolService = GitHubService) {}

  async execute(input: RepositoryLimitToolInput): Promise<AIToolResult> {
    const resolved = await resolveRepository(this.service, input.repository);
    const result = await this.service.listRepositoryEvents(resolved.owner, resolved.repo, input.limit ?? 20);
    const events = result.events;
    return toolSuccess(
      this.id,
      {
        repository: resolved.fullName,
        count: events.length,
        events: events.map(toEventSummary),
      },
      events.map((event) => ({
        integration: "github" as const,
        type: event.type || "event",
        id: event.id || `${resolved.fullName}:${event.createdAt ?? ""}`,
        title: event.title ?? event.type ?? undefined,
        url: `https://github.com/${resolved.fullName}`,
      })),
    );
  }
}

/** List a repository's open issues. */
export class GitHubOpenIssuesSummaryTool implements Tool {
  readonly id = "github.openIssuesSummary";
  readonly description = "List the open issues of a GitHub repository for summarization.";
  readonly inputSchema = repositoryLimitInputSchema;

  constructor(private readonly service: GitHubToolService = GitHubService) {}

  async execute(input: RepositoryLimitToolInput): Promise<AIToolResult> {
    const resolved = await resolveRepository(this.service, input.repository);
    const result = await this.service.listIssues(resolved.owner, resolved.repo, {
      state: "open",
      perPage: input.limit ?? 30,
    });
    const issues = result.issues;
    const normalized = issues.map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      body: truncate(issue.body ?? "", BODY_MAX),
      user: issue.user,
      labels: issue.labels,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      comments: issue.comments,
      htmlUrl: issue.htmlUrl,
    }));
    return toolSuccess(
      this.id,
      {
        repository: resolved.fullName,
        count: normalized.length,
        issues: normalized,
      },
      issues.map((issue) => ({
        integration: "github" as const,
        type: "issue",
        id: String(issue.number),
        title: issue.title || undefined,
        url: issue.htmlUrl || undefined,
      })),
    );
  }
}
