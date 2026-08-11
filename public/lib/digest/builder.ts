/**
 * Daily AI Digest — digest builder (deterministic aggregation).
 *
 * Builds structured digests from the existing engines and tool results —
 * nothing is reimplemented and no AI is involved:
 *
 * ```text
 * DigestDataSources
 *   → Context Engine (assembled context prompt)
 *   → Tool Executor  (search.gmail / search.calendar / search.github /
 *                     search.drive → email/calendar/github/file items)
 *   → Memory Engine  (rankMemories → memory items)
 *   → Conversation Engine (summarizeConversation → conversation summary)
 *   → Job Engine     (pending jobs → action items)
 *   → DigestContext  → DigestBuilder (per template) → Digest
 * ```
 *
 * Guarantees:
 * - **Deterministic**: identical data sources, templates, and injected time
 *   produce identical digests (stable ordering, no duplicate sections/items).
 * - **Failure isolation**: a throwing source degrades to an empty
 *   contribution — the digest still builds.
 * - **Immutability**: sources are only read; the builder never mutates them.
 *
 * The engine access lives exclusively behind the injected `DigestDataSources`
 * (dependency injection); the builder itself is engine-agnostic.
 */

import type { ExecutionResult } from "@/lib/tools/executor";
import type { ExecutionPlan, ExecutionStep } from "@/lib/tools/plan";
import { createExecutionPlan } from "@/lib/tools/plan";
import type { Conversation } from "@/lib/conversation/types";
import { summarizeConversation } from "@/lib/conversation/summarizer";
import type { Job } from "@/lib/jobs/types";
import { rankMemories } from "@/lib/memory/ranker";
import type { Memory } from "@/lib/memory/types";
import type { ListEventsResult, EventSummary } from "@/lib/services/calendar/types";
import type { ListFilesResult, DriveFile } from "@/lib/services/drive/types";
import type { ListMessagesResult, MessageSummary } from "@/lib/services/gmail/types";
import type { SearchRepositoriesResult, RepositorySummary } from "@/lib/services/github";
import {
  createDigest,
  createItem,
  createSection,
  hashDigest,
  type CreateDigestInput,
  type Digest,
  type DigestCategory,
  type DigestContext,
  type DigestImportance,
  type DigestItem,
  type DigestSection,
  type DigestTemplate,
  type DigestWindow,
} from "./types";

/** Tool ids used by the digest tool plan (match `lib/tools/builtin.ts`). */
export const DIGEST_GMAIL_TOOL_ID = "search.gmail";
export const DIGEST_CALENDAR_TOOL_ID = "search.calendar";
export const DIGEST_GITHUB_TOOL_ID = "search.github";
export const DIGEST_DRIVE_TOOL_ID = "search.drive";

/** Default cap on items gathered per source and rendered per section. */
export const DEFAULT_DIGEST_MAX_ITEMS = 10;

/** Token budget forwarded to the conversation summarizer. */
export const DIGEST_CONVERSATION_TOKEN_BUDGET = 400;

/** Message cap applied by the conversation summarizer. */
export const DIGEST_CONVERSATION_MESSAGE_CAP = 10;

/** Default digest query used when a template kind has no query. */
export function defaultQueryFor(kind: DigestTemplate["kind"]): string {
  switch (kind) {
    case "morning":
      return "morning digest";
    case "evening":
      return "evening digest";
    case "weekly":
      return "weekly digest";
    default:
      return "daily digest";
  }
}

/**
 * The data surfaces the digest builder reads from — the dependency-injection
 * seam over the existing engines. Every method is a read; nothing is
 * constructed here.
 */
export interface DigestDataSources {
  /** Snapshot of the Memory Engine's stored memories. */
  readonly listMemories: () => readonly Memory[];
  /** Snapshot of the Conversation Engine's conversations. */
  readonly listConversations: () => readonly Conversation[];
  /** Assemble the context prompt through the Context Engine. */
  readonly buildContextPrompt: (query: string, userId: string) => Promise<string>;
  /** Snapshot of the Job Engine's registered jobs. */
  readonly listJobs: () => readonly Job[];
  /** Execute a tool plan through the Tool Executor. */
  readonly executeTools: (plan: ExecutionPlan) => Promise<ExecutionResult>;
}

/** Options accepted by {@link gatherDigestContext}. */
export interface GatherOptions {
  readonly userId: string;
  /** ISO-8601 UTC timestamp of the digest. */
  readonly now: string;
  readonly window: DigestWindow;
  /** Free-text query forwarded to retrieval and the search tools. */
  readonly query: string;
  /** Cap on items gathered per source. */
  readonly maxItemsPerSource?: number;
}

/** Options accepted by {@link DigestBuilder.build}. */
export interface BuildDigestInput {
  readonly template: DigestTemplate;
  readonly userId: string;
  /** ISO-8601 UTC timestamp of the digest. */
  readonly now: string;
  /** Free-text query; defaults per template kind. */
  readonly query?: string;
  /** Time window; defaults per template (see `templateWindowFor`). */
  readonly window?: DigestWindow;
}

/** A step result reduced to the fields the builder maps. */
interface ToolOutput {
  readonly stepId: string;
  readonly toolId: string;
  readonly status: "success" | "failure" | "cancelled";
  readonly output?: unknown;
}

/**
 * Build the deterministic tool plan executed for a digest: one search step
 * per source, in fixed order, all independent (parallel-ready).
 */
export function createDigestToolPlan(query: string, maxResults: number): ExecutionPlan {
  const steps: readonly ExecutionStep[] = [
    {
      stepId: "emails",
      toolId: DIGEST_GMAIL_TOOL_ID,
      input: { query, maxResults },
      dependsOn: [],
    },
    {
      stepId: "calendar",
      toolId: DIGEST_CALENDAR_TOOL_ID,
      input: { query, maxResults },
      dependsOn: [],
    },
    {
      stepId: "github",
      toolId: DIGEST_GITHUB_TOOL_ID,
      input: { query, maxResults },
      dependsOn: [],
    },
    {
      stepId: "files",
      toolId: DIGEST_DRIVE_TOOL_ID,
      input: { query, maxResults },
      dependsOn: [],
    },
  ];
  return createExecutionPlan({ id: `digest-tools-${hashDigest(query)}`, steps });
}

/**
 * Gather a normalized `DigestContext` from the injected data sources.
 *
 * Every source is isolated: a throwing source contributes nothing (the
 * digest still builds). Tool steps that fail are skipped; successful steps
 * are mapped to items by tool id. Memory items are ranked with
 * `rankMemories`, jobs contribute pending non-archived jobs, and the most
 * recent conversation is summarized with `summarizeConversation`. The
 * returned items are deduplicated by id (first occurrence wins).
 */
export async function gatherDigestContext(
  sources: DigestDataSources,
  options: GatherOptions,
): Promise<DigestContext> {
  const { userId, now, window, query } = options;
  const maxItems = options.maxItemsPerSource ?? DEFAULT_DIGEST_MAX_ITEMS;

  const contextPrompt = await safe(
    () => sources.buildContextPrompt(query, userId),
    "",
  );
  const toolResult = await safe(
    () => sources.executeTools(createDigestToolPlan(query, maxItems)),
    emptyExecutionResult(query),
  );

  // Each step's mapping is isolated: a malformed-but-successful tool output
  // (e.g. a non-array payload) degrades to no items for THAT step — other
  // steps still contribute, and the digest never fails.
  const toolItems = toolResult.results.flatMap((result) => {
    try {
      return itemsFromToolOutput(result, maxItems);
    } catch {
      return [] as DigestItem[];
    }
  });
  const memoryItems = await safe(
    () => rankMemories(sources.listMemories(), query).slice(0, maxItems).map(memoryToItem),
    [],
  );
  const jobItems = await safe(
    () =>
      sources
        .listJobs()
        .filter((job) => job.status === "pending" && !job.archived)
        .slice(0, maxItems)
        .map(jobToItem),
    [],
  );
  const conversationItem = await safe(
    () => conversationToItem(sources.listConversations()),
    undefined,
  );

  const items = dedupeById([
    ...toolItems,
    ...memoryItems,
    ...jobItems,
    ...(conversationItem !== undefined ? [conversationItem] : []),
  ]);

  return {
    userId,
    now,
    window,
    contextPrompt,
    conversationSummary: conversationItem?.content ?? "",
    items,
  };
}

/**
 * Deterministic digest builder.
 *
 * Composes `gatherDigestContext` with the pure section assembly for a
 * template: sections are emitted in template order, only when they have
 * items, each category at most once, items capped per section and
 * deduplicated. The statistics section is always appended last.
 */
export class DigestBuilder {
  constructor(private readonly sources: DigestDataSources) {}

  /**
   * Build a digest for `input.template`.
   *
   * Pure orchestration: the data sources are only read; the returned digest
   * is new and detached. Deterministic for identical sources/templates/time.
   */
  async build(input: BuildDigestInput): Promise<Digest> {
    const template = input.template;
    const now = input.now;
    const query = input.query ?? defaultQueryFor(template.kind);
    const window =
      input.window ?? templateWindowFor(template, now);

    const context = await gatherDigestContext(this.sources, {
      userId: input.userId,
      now,
      window,
      query,
    });

    const contentSections = assembleContentSections(template, context);
    const stats = statisticsOf(contentSections);
    const sections = [
      ...contentSections,
      createSection({
        id: "section-statistics",
        category: "statistics",
        title: "Statistics",
        priority: "low",
        items: statisticsItems(stats),
      }),
    ];

    const input_: CreateDigestInput = {
      kind: template.kind,
      title: template.title,
      priority: template.priority,
      createdAt: now,
      window,
      tags: [template.kind],
      sections,
    };
    return createDigest(input_);
  }
}

/** Assemble the content sections (statistics excluded) in template order. */
function assembleContentSections(
  template: DigestTemplate,
  context: DigestContext,
): DigestSection[] {
  const sections: DigestSection[] = [];
  const emitted = new Set<string>();
  const seenItems = new Set<string>();

  for (const templateSection of template.sections) {
    if (templateSection.category === "statistics") continue;
    if (emitted.has(templateSection.category)) continue;

    const items: DigestItem[] = [];
    for (const item of context.items) {
      if (item.category !== templateSection.category) continue;
      if (seenItems.has(item.id)) continue;
      seenItems.add(item.id);
      items.push(item);
    }

    const capped = items.slice(0, templateSection.maxItems ?? items.length);
    if (capped.length === 0) continue;

    emitted.add(templateSection.category);
    sections.push(
      createSection({
        id: `section-${templateSection.category}`,
        category: templateSection.category,
        title: templateSection.title,
        priority: templateSection.priority,
        items: capped,
      }),
    );
  }
  return sections;
}

/** Derived counts of the content sections (statistics excluded). */
function statisticsOf(
  sections: Digest["sections"],
): { sectionCount: number; itemCount: number; categories: Record<string, number> } {
  const categories: Record<string, number> = {};
  let itemCount = 0;
  for (const section of sections) {
    for (const item of section.items) {
      itemCount += 1;
      categories[item.category] = (categories[item.category] ?? 0) + 1;
    }
  }
  return {
    sectionCount: sections.length,
    itemCount,
    categories,
  };
}

/** One item per non-zero category, plus a context-length note. */
function statisticsItems(stats: { categories: Record<string, number>; itemCount: number }): DigestItem[] {
  const items: DigestItem[] = [];
  for (const category of Object.keys(stats.categories).sort()) {
    items.push(
      createItem({
        category: "statistics",
        title: category,
        content: `${stats.categories[category]} item(s)`,
        importance: "normal",
        source: "statistics",
      }),
    );
  }
  items.push(
    createItem({
      category: "statistics",
      title: "Total",
      content: `${stats.itemCount} item(s) across ${Object.keys(stats.categories).length} section(s)`,
      importance: "high",
      source: "statistics",
    }),
  );
  return items;
}

/** Map a successful tool step's output to digest items by tool id. */
function itemsFromToolOutput(result: ToolOutput, maxItems: number): DigestItem[] {
  if (result.status !== "success" || result.output === undefined) return [];
  const slice = <T>(list: T[]): T[] => list.slice(0, maxItems);
  switch (result.toolId) {
    case DIGEST_GMAIL_TOOL_ID: {
      const output = result.output as ListMessagesResult;
      return slice(output.messages ?? []).map(messageToItem);
    }
    case DIGEST_CALENDAR_TOOL_ID: {
      const output = result.output as ListEventsResult;
      return slice(output.events ?? []).map(eventToItem);
    }
    case DIGEST_GITHUB_TOOL_ID: {
      const output = result.output as SearchRepositoriesResult;
      return slice(output.repositories ?? []).map(repositoryToItem);
    }
    case DIGEST_DRIVE_TOOL_ID: {
      const output = result.output as ListFilesResult;
      return slice(output.files ?? []).map(fileToItem);
    }
    default:
      return [];
  }
}

/** Deterministic id for an item derived from its provider entity. */
function itemIdFor(category: DigestCategory, source: string, entityId: string): string {
  return `item-${hashDigest(`${category}:${source}:${entityId}`)}`;
}

/** Map a Gmail message to a digest item. */
function messageToItem(message: MessageSummary): DigestItem {
  return createItem({
    id: itemIdFor("emails", "gmail", message.id),
    category: "emails",
    title: message.subject ?? "(no subject)",
    content: message.snippet ?? "",
    importance: "normal",
    timestamp: message.date ?? undefined,
    source: "gmail",
  });
}

/** Map a calendar event to a digest item. */
function eventToItem(event: EventSummary): DigestItem {
  return createItem({
    id: itemIdFor("calendar", "calendar", event.id),
    category: "calendar",
    title: event.summary ?? "(no title)",
    content: event.description ?? "",
    importance: "normal",
    timestamp: event.start ?? undefined,
    source: "calendar",
  });
}

/** Map a GitHub repository to a digest item. */
function repositoryToItem(repository: RepositorySummary): DigestItem {
  return createItem({
    id: itemIdFor("github", "github", String(repository.id)),
    category: "github",
    title: repository.fullName ?? repository.name,
    content: repository.description ?? "",
    importance: "normal",
    timestamp: repository.updatedAt ?? undefined,
    source: "github",
  });
}

/** Map a Drive file to a digest item. */
function fileToItem(file: DriveFile): DigestItem {
  const owners = (file.owners ?? [])
    .map((owner) => owner.displayName ?? owner.emailAddress ?? "")
    .filter((name) => name.length > 0)
    .join(", ");
  return createItem({
    id: itemIdFor("files", "drive", file.id),
    category: "files",
    title: file.name,
    content: owners.length > 0 ? `${file.mimeType ?? "file"} — ${owners}` : (file.mimeType ?? "file"),
    importance: "normal",
    timestamp: file.modifiedTime ?? undefined,
    source: "drive",
  });
}

/** Map a ranked memory to a digest item. */
function memoryToItem(memory: Memory): DigestItem {
  return createItem({
    id: itemIdFor("memories", "memory", memory.id),
    category: "memories",
    title: memory.metadata.title,
    content: memory.content,
    importance: memoryImportance(memory.metadata.importance),
    timestamp: memory.metadata.updatedAt,
    source: "memory",
  });
}

/** Map a pending job to a digest action item. */
function jobToItem(job: Job): DigestItem {
  return createItem({
    id: itemIdFor("actions", "job", job.id),
    category: "actions",
    title: job.name,
    content:
      job.scheduledAt !== undefined
        ? `Next run ${job.scheduledAt} (${job.trigger})`
        : `${job.trigger} job`,
    importance: jobImportance(job.priority),
    timestamp: job.createdAt,
    source: "job",
  });
}

/** Summarize the most recent conversation into a single digest item. */
function conversationToItem(conversations: readonly Conversation[]): DigestItem | undefined {
  if (conversations.length === 0) return undefined;
  const latest = conversations[conversations.length - 1];
  const summarized = summarizeConversation(latest, {
    maxTokens: DIGEST_CONVERSATION_TOKEN_BUDGET,
    maxMessages: DIGEST_CONVERSATION_MESSAGE_CAP,
  });
  const lines = summarized.messages.map((message) => `[${message.role}] ${message.content}`);
  return createItem({
    id: itemIdFor("conversation", "conversation", latest.id),
    category: "conversation",
    title: latest.metadata.title ?? "Conversation summary",
    content: lines.length > 0 ? lines.join("\n") : "(empty conversation)",
    importance: "normal",
    timestamp: latest.metadata.updatedAt,
    source: "conversation",
  });
}

/** Map a memory importance to the digest importance union. */
function memoryImportance(
  importance: Memory["metadata"]["importance"],
): DigestImportance {
  return importance;
}

/** Map a job priority to the digest importance union. */
function jobImportance(priority: Job["priority"]): DigestImportance {
  return priority;
}

/** Deduplicate items by id, preserving first-occurrence order. */
function dedupeById(items: readonly DigestItem[]): DigestItem[] {
  const seen = new Set<string>();
  const result: DigestItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

/** Run `fn`, falling back to `fallback` when it throws (failure isolation). */
async function safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** An empty tool execution result (used when the tool source throws). */
function emptyExecutionResult(query: string): ExecutionResult {
  return {
    planId: `digest-tools-${hashDigest(query)}`,
    results: [],
    succeededStepIds: [],
    failedStepIds: [],
    cancelledStepIds: [],
  };
}

/** Day length in milliseconds (used by template windows). */
const DAY_MS = 86_400_000;

/**
 * Resolve a template's window from `now`.
 *
 * - Day templates (`windowDays` 1): from the start of the day (00:00 UTC)
 *   to `now`.
 * - Longer templates: `now` minus `windowDays` days to `now`.
 * Deterministic — a pure function of the template and `now`.
 */
export function templateWindowFor(template: DigestTemplate, now: string): DigestWindow {
  if (template.windowDays <= 1) {
    return { from: `${now.slice(0, 10)}T00:00:00.000Z`, to: now };
  }
  const from = new Date(Date.parse(now) - template.windowDays * DAY_MS).toISOString();
  return { from, to: now };
}

