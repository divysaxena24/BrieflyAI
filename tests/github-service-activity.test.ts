import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "@/lib/errors";

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({
  getUserIntegrationByPlatform: vi.fn(),
  findUserByAuthId: vi.fn(),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/services/integrations/githubTokenManager", () => ({
  default: { getValidAccessToken: vi.fn(), invalidate: vi.fn() },
}));

import { getCurrentUser } from "@/lib/auth";
import { getUserIntegrationByPlatform, findUserByAuthId } from "@/lib/db/queries";
import githubTokenManager from "@/lib/services/integrations/githubTokenManager";
import GitHubService from "@/lib/services/github";

const mockUser = { id: "user-1", email: "test@example.com" };
const mockIntegration = { id: "int-1", platform: "github", userId: "user-1" };

const noPagination = { next: null, prev: null, first: null, last: null, hasNext: false };

// ──────────────────────────────────────────────
//  createClientForUser
// ──────────────────────────────────────────────

describe("GitHubService.createClientForUser (new methods)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as any).mockResolvedValue(mockUser);
    (getUserIntegrationByPlatform as any).mockResolvedValue(mockIntegration);
    (findUserByAuthId as any).mockResolvedValue(mockUser);
    (githubTokenManager.getValidAccessToken as any).mockResolvedValue({ accessToken: "gh-token" });
  });

  it("throws AppError when no GitHub integration exists", async () => {
    (getUserIntegrationByPlatform as any).mockResolvedValue(null);
    await expect(GitHubService.createClientForUser()).rejects.toMatchObject({
      code: "github_not_connected",
    });
  });
});

// ──────────────────────────────────────────────
//  listIssues
// ──────────────────────────────────────────────

describe("GitHubService.listIssues", () => {
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as any).mockResolvedValue(mockUser);
    (getUserIntegrationByPlatform as any).mockResolvedValue(mockIntegration);
    (findUserByAuthId as any).mockResolvedValue(mockUser);
    (githubTokenManager.getValidAccessToken as any).mockResolvedValue({ accessToken: "gh-token" });
    mockClient = { get: vi.fn() };
    vi.spyOn(GitHubService, "createClientForUser").mockResolvedValue({
      client: mockClient,
      integration: mockIntegration,
    });
  });

  it("requests open issues with the expected query params", async () => {
    mockClient.get.mockResolvedValue({ data: [], status: 200, headers: new Headers(), pagination: noPagination });
    await GitHubService.listIssues("acme", "briefly", { perPage: 25 });
    expect(mockClient.get).toHaveBeenCalledWith("/repos/acme/briefly/issues", {
      query: { state: "open", per_page: 25, sort: "created", direction: "desc" },
    });
  });

  it("maps raw issues and filters out pull requests", async () => {
    mockClient.get.mockResolvedValue({
      data: [
        { id: 1, number: 1, title: "Bug in login", state: "open", body: "Cannot log in", user: { login: "alice" }, labels: [{ name: "bug" }], created_at: "2026-08-01T00:00:00Z", updated_at: null, html_url: "https://github.com/acme/briefly/issues/1", comments: 2 },
        { id: 2, number: 2, title: "Some PR", state: "open", pull_request: {} },
      ],
      status: 200,
      headers: new Headers(),
      pagination: noPagination,
    });
    const result = await GitHubService.listIssues("acme", "briefly");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      number: 1,
      title: "Bug in login",
      user: "alice",
      labels: ["bug"],
      comments: 2,
    });
  });

  it("propagates AppError from the client (e.g. 404 repo)", async () => {
    mockClient.get.mockRejectedValue(new AppError("Not found", 404, "not_found"));
    await expect(GitHubService.listIssues("acme", "missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("invalidates the token on 401", async () => {
    mockClient.get.mockRejectedValue(new AppError("Unauthorized", 401, "authentication_required"));
    await expect(GitHubService.listIssues("acme", "briefly")).rejects.toMatchObject({
      code: "authentication_required",
    });
    expect(githubTokenManager.invalidate).toHaveBeenCalledWith("int-1");
  });

  it("wraps unexpected errors into a generic AppError", async () => {
    mockClient.get.mockRejectedValue(new Error("boom"));
    await expect(GitHubService.listIssues("acme", "briefly")).rejects.toMatchObject({
      code: "github_error",
    });
  });
});

// ──────────────────────────────────────────────
//  listRepositoryEvents
// ──────────────────────────────────────────────

describe("GitHubService.listRepositoryEvents", () => {
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as any).mockResolvedValue(mockUser);
    (getUserIntegrationByPlatform as any).mockResolvedValue(mockIntegration);
    (findUserByAuthId as any).mockResolvedValue(mockUser);
    (githubTokenManager.getValidAccessToken as any).mockResolvedValue({ accessToken: "gh-token" });
    mockClient = { get: vi.fn() };
    vi.spyOn(GitHubService, "createClientForUser").mockResolvedValue({
      client: mockClient,
      integration: mockIntegration,
    });
  });

  it("requests events with the per_page param", async () => {
    mockClient.get.mockResolvedValue({ data: [], status: 200, headers: new Headers(), pagination: noPagination });
    await GitHubService.listRepositoryEvents("acme", "briefly", 15);
    expect(mockClient.get).toHaveBeenCalledWith("/repos/acme/briefly/events", {
      query: { per_page: 15 },
    });
  });

  it("normalizes push/issue/PR event payloads", async () => {
    mockClient.get.mockResolvedValue({
      data: [
        { id: "evt-1", type: "PushEvent", created_at: "2026-08-01T10:00:00Z", actor: { login: "alice" }, payload: { ref: "refs/heads/main", size: 3 } },
        { id: "evt-2", type: "IssuesEvent", created_at: "2026-08-02T10:00:00Z", actor: { login: "bob" }, payload: { action: "opened", issue: { number: 4, title: "New bug" } } },
        { id: "evt-3", type: "PullRequestEvent", created_at: "2026-08-03T10:00:00Z", actor: { login: "carol" }, payload: { action: "closed", pull_request: { number: 7, title: "Fix nav" } } },
      ],
      status: 200,
      headers: new Headers(),
      pagination: noPagination,
    });
    const result = await GitHubService.listRepositoryEvents("acme", "briefly");
    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({ type: "PushEvent", actor: "alice", ref: "refs/heads/main", commitCount: 3 });
    expect(result.events[1]).toMatchObject({ type: "IssuesEvent", action: "opened", issueNumber: 4, title: "New bug" });
    expect(result.events[2]).toMatchObject({ type: "PullRequestEvent", action: "closed", pullRequestNumber: 7, title: "Fix nav" });
  });

  it("falls back to commits.length when size is absent", async () => {
    mockClient.get.mockResolvedValue({
      data: [
        { id: "evt-1", type: "PushEvent", created_at: null, actor: null, payload: { commits: [{ message: "a" }, { message: "b" }] } },
      ],
      status: 200,
      headers: new Headers(),
      pagination: noPagination,
    });
    const result = await GitHubService.listRepositoryEvents("acme", "briefly");
    expect(result.events[0].commitCount).toBe(2);
  });

  it("propagates AppError from the client", async () => {
    mockClient.get.mockRejectedValue(new AppError("Rate limited", 403, "rate_limited"));
    await expect(GitHubService.listRepositoryEvents("acme", "briefly")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});

// ──────────────────────────────────────────────
//  toRepositoryEvent unit
// ──────────────────────────────────────────────

describe("GitHubService.toRepositoryEvent", () => {
  it("handles empty payloads without crashing", () => {
    const event = GitHubService.toRepositoryEvent({ id: "e", type: "WatchEvent", created_at: null, actor: null });
    expect(event).toMatchObject({ type: "WatchEvent", action: null, commitCount: null, issueNumber: null, pullRequestNumber: null });
  });
});
