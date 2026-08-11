import { z } from "zod";

export const githubRepoQuerySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

// Flexible query used by API routes (owner and/or repo optional)
export const githubQuerySchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
});

// Query params for GET /api/github/repos (list the authenticated user's repos)
export const githubReposListSchema = z.object({
  page: z.number().int().min(1).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  sort: z.string().optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  visibility: z.enum(["public", "private", "all"]).optional(),
  affiliation: z.string().optional(),
});

// Query params for GET /api/github/repos/search
// query is required; sort/order/page/perPage are optional
const githubSortSchema = z.enum(["stars", "forks", "help-wanted-issues", "updated"]).optional();
const githubOrderSchema = z.enum(["asc", "desc"]).optional();
export const githubReposSearchSchema = z.object({
  query: z.string().min(1),
  sort: githubSortSchema,
  order: githubOrderSchema,
  page: z.number().int().min(1).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
});

export type GithubRepoQuery = z.infer<typeof githubRepoQuerySchema>;
export type GithubQuery = z.infer<typeof githubQuerySchema>;
export type GithubReposListInput = z.infer<typeof githubReposListSchema>;
export type GithubReposSearchInput = z.infer<typeof githubReposSearchSchema>;
