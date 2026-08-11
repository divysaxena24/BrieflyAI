/**
 * AI Tool layer — built-in read tools.
 *
 * Wraps the existing production services as AI tools. Each tool reuses the
 * minimal structural service surface already defined by the context adapters
 * (`Production*Service` in `lib/context/adapters/*`) and the services'
 * native search APIs — no business logic is duplicated.
 *
 * - `SearchGmailTool`    → `GmailService.searchMessages(query, maxResults)`
 * - `SearchCalendarTool` → `CalendarService.searchEvents(query, undefined, maxResults)`
 * - `SearchDriveTool`    → `DriveService.searchFiles(query, maxResults)`
 * - `SearchGitHubTool`   → `GitHubService.searchRepositories({ query, perPage })`
 *
 * The production services are request-scoped (they resolve the current user
 * from the request context), so tools need no user id in their input.
 *
 * There is intentionally no Search Memory tool: no production `MemoryService`
 * exists in the codebase yet (see `lib/context/sources/memorySource.ts`).
 */

import { z } from "zod";
import type { Tool } from "./types";
import GmailService from "@/lib/services/gmail";
import CalendarService from "@/lib/services/calendar";
import DriveService from "@/lib/services/drive";
import GitHubService from "@/lib/services/github";
import type { ProductionGmailService } from "@/lib/context/adapters/gmailServiceAdapter";
import type { ProductionCalendarService } from "@/lib/context/adapters/calendarServiceAdapter";
import type { ProductionDriveService } from "@/lib/context/adapters/driveServiceAdapter";
import type { ProductionGitHubService } from "@/lib/context/adapters/githubServiceAdapter";
import type { ListMessagesResult } from "@/lib/services/gmail/types";
import type { ListEventsResult } from "@/lib/services/calendar/types";
import type { ListFilesResult } from "@/lib/services/drive/types";
import type { SearchRepositoriesResult } from "@/lib/services/github";

/** Input schema shared by the search tools. */
const searchInputSchema = z.object({
  /** Free-text search query. */
  query: z.string().min(1),
  /** Optional maximum number of results. */
  maxResults: z.number().int().positive().optional(),
});

/** Input accepted by {@link SearchGmailTool}. */
export type SearchGmailInput = z.infer<typeof searchInputSchema>;

/** Input accepted by {@link SearchCalendarTool}. */
export type SearchCalendarInput = z.infer<typeof searchInputSchema>;

/** Input accepted by {@link SearchDriveTool}. */
export type SearchDriveInput = z.infer<typeof searchInputSchema>;

/** Input accepted by {@link SearchGitHubTool}. */
export type SearchGitHubInput = z.infer<typeof searchInputSchema>;

/**
 * Search the user's Gmail messages.
 * Delegates to `GmailService.searchMessages(query, maxResults)`.
 */
export class SearchGmailTool implements Tool {
  readonly id = "search.gmail";
  readonly description = "Search the user's Gmail messages by query text.";
  readonly inputSchema = searchInputSchema;

  constructor(private readonly service: ProductionGmailService = GmailService) {}

  async execute(input: SearchGmailInput): Promise<ListMessagesResult> {
    return this.service.searchMessages(input.query, input.maxResults);
  }
}

/**
 * Search the user's calendar events.
 * Delegates to `CalendarService.searchEvents(query, undefined, maxResults)`
 * (`calendarId` left undefined so `maxResults` fills the `maxResults`
 * position — the documented production signature).
 */
export class SearchCalendarTool implements Tool {
  readonly id = "search.calendar";
  readonly description = "Search the user's calendar events by query text.";
  readonly inputSchema = searchInputSchema;

  constructor(private readonly service: ProductionCalendarService = CalendarService) {}

  async execute(input: SearchCalendarInput): Promise<ListEventsResult> {
    return this.service.searchEvents(input.query, undefined, input.maxResults);
  }
}

/**
 * Search the user's Drive files.
 * Delegates to `DriveService.searchFiles(query, maxResults)`.
 */
export class SearchDriveTool implements Tool {
  readonly id = "search.drive";
  readonly description = "Search the user's Drive files by query text.";
  readonly inputSchema = searchInputSchema;

  constructor(private readonly service: ProductionDriveService = DriveService) {}

  async execute(input: SearchDriveInput): Promise<ListFilesResult> {
    return this.service.searchFiles(input.query, input.maxResults);
  }
}

/**
 * Search the user's GitHub repositories.
 * Delegates to `GitHubService.searchRepositories({ query, perPage: maxResults })`.
 */
export class SearchGitHubTool implements Tool {
  readonly id = "search.github";
  readonly description = "Search the user's GitHub repositories by query text.";
  readonly inputSchema = searchInputSchema;

  constructor(private readonly service: ProductionGitHubService = GitHubService) {}

  async execute(input: SearchGitHubInput): Promise<SearchRepositoriesResult> {
    return this.service.searchRepositories({ query: input.query, perPage: input.maxResults });
  }
}

/**
 * The four built-in read tools, each wrapping its production service with
 * the production default.
 */
export function createBuiltInReadTools(): readonly Tool[] {
  return [
    new SearchGmailTool(),
    new SearchCalendarTool(),
    new SearchDriveTool(),
    new SearchGitHubTool(),
  ];
}
