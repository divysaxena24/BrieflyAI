/**
 * Context Engine — source registry (pure dependency wiring).
 *
 * Owns the application's `ContextSource` collection. The registry creates no
 * services — it only receives already-created service implementations via the
 * constructor and constructs a `ContextSource` for each one that is provided.
 *
 * No retrieval, ranking, availability checks, filtering, caching, singletons,
 * or lazy initialization happen here — only construction and exposure.
 */

import type { ContextSource } from "./types";
import { MemorySource } from "./sources/memorySource";
import type { MemoryService } from "./sources/memorySource";
import { GmailSource } from "./sources/gmailSource";
import type { GmailService } from "./sources/gmailSource";
import { CalendarSource } from "./sources/calendarSource";
import type { CalendarService } from "./sources/calendarSource";
import { GitHubSource } from "./sources/githubSource";
import type { GitHubService } from "./sources/githubSource";
import { DriveSource } from "./sources/driveSource";
import type { DriveService } from "./sources/driveSource";

/** Options accepted by {@link ContextSourceRegistry}. */
interface ContextSourceRegistryOptions {
  /** Creates a `MemorySource` when provided. */
  memoryService?: MemoryService;
  /** Creates a `GmailSource` when provided. */
  gmailService?: GmailService;
  /** Creates a `CalendarSource` when provided. */
  calendarService?: CalendarService;
  /** Creates a `GitHubSource` when provided. */
  githubService?: GitHubService;
  /** Creates a `DriveSource` when provided. */
  driveService?: DriveService;
}

/**
 * Owns the application's context sources.
 *
 * Constructs a source only for each service that is provided, in the fixed
 * order Memory → Gmail → Calendar → GitHub → Drive (never sorted; priority
 * ordering is `ContextBuilder`'s responsibility). The internal collection is
 * immutable by type and never mutated.
 */
export class ContextSourceRegistry {
  private readonly sources: readonly ContextSource[];

  constructor(options: ContextSourceRegistryOptions = {}) {
    const sources: ContextSource[] = [];
    if (options.memoryService) sources.push(new MemorySource(options.memoryService));
    if (options.gmailService) sources.push(new GmailSource(options.gmailService));
    if (options.calendarService) sources.push(new CalendarSource(options.calendarService));
    if (options.githubService) sources.push(new GitHubSource(options.githubService));
    if (options.driveService) sources.push(new DriveSource(options.driveService));
    this.sources = sources;
  }

  /**
   * Return the constructed sources in creation order as a shallow copy.
   *
   * The internal array is never exposed: caller mutation of the returned
   * array cannot affect registry state, and repeated calls return
   * independent arrays.
   */
  getSources(): readonly ContextSource[] {
    return [...this.sources];
  }
}
