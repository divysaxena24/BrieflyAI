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

export type GithubRepoQuery = z.infer<typeof githubRepoQuerySchema>;
export type GithubQuery = z.infer<typeof githubQuerySchema>;
