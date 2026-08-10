/**
 * Daily AI Digest — immutable domain models.
 *
 * Step 1 of the AI Digest framework: the pure, readonly data model for
 * structured digests plus the pure helper functions that construct, clone,
 * freeze, touch, measure, and summarize them.
 *
 * No services, no LLM, no AI summarization, no sending channels, and no side
 * effects live here — only data and pure functions. Every function is
 * deterministic: identical inputs always produce identical outputs, and
 * caller-supplied objects/arrays are never referenced or mutated (they are
 * copied on entry, and the returned structures are detached).
 *
 * Timestamps are always supplied by the caller (no `Date.now()`) and token
 * estimation reuses the shared `estimateTokens` heuristic — no token math is
 * reimplemented.
 */

import { estimateTokens } from "@/lib/context/tokenBudget";

/** The template a digest was built from. */
export type DigestKind = "morning" | "evening" | "weekly" | "custom";

/** Lifecycle state of a digest. */
export type DigestStatus = "draft" | "published" | "archived" | "deleted";

/** Delivery/scheduling priority of a digest. */
export type DigestPriority = "low" | "normal" | "high" | "critical";

/** Per-item importance used during rendering. */
export type DigestImportance = "low" | "normal" | "high" | "critical";

/** Semantic category of a digest section/item. */
export type DigestCategory =
  | "meetings"
  | "emails"
  | "github"
  | "calendar"
  | "memories"
  | "conversation"
  | "actions"
  | "files"
  | "statistics"
  | "general";

/** Supported output formats of the delivery layer. */
export type DigestFormat = "json" | "markdown" | "plain" | "object";

/** Default status assigned by `createDigest` when none is provided. */
export const DEFAULT_DIGEST_STATUS: DigestStatus = "draft";

/** Default priority assigned by `createDigest` when none is provided. */
export const DEFAULT_DIGEST_PRIORITY: DigestPriority = "normal";

/** Default read flag assigned by `createDigest`. */
export const DEFAULT_DIGEST_READ = false;

/**
 * A time window a digest covers — the interval (ISO-8601 UTC) the gathered
 * signals were drawn from.
 */
export interface DigestWindow {
  /** Inclusive start of the window. */
  readonly from: string;
  /** Inclusive end of the window. */
  readonly to: string;
}

/**
 * A digest recipient — an address the digest may be delivered to. The
 * delivery layer only *formats* and *dispatches* through an injected
 * publisher; no real channel (Gmail/Discord/Slack) is implemented here.
 */
export interface DigestRecipient {
  /** Stable recipient id, when known. */
  readonly id?: string;
  /** Human-readable display name. */
  readonly name?: string;
  /** Delivery address (email/chat id/...). */
  readonly address: string;
}

/**
 * A record of one digest delivery: the format it was rendered in, its
 * recipients, and when it was delivered.
 */
export interface DigestDelivery {
  readonly format: DigestFormat;
  readonly recipients: readonly DigestRecipient[];
  /** ISO-8601 UTC timestamp of the delivery. */
  readonly deliveredAt?: string;
}

/**
 * A single digest entry: one signal rendered into the digest.
 */
export interface DigestItem {
  /** Stable item id; deterministic when derived by `createItem`. */
  readonly id: string;
  readonly category: DigestCategory;
  /** Short human-readable title. */
  readonly title: string;
  /** The item text. */
  readonly content: string;
  readonly importance: DigestImportance;
  /** ISO-8601 UTC timestamp of the underlying signal. */
  readonly timestamp?: string;
  /** Provenance of the item (gmail/calendar/github/drive/memory/job/...). */
  readonly source?: string;
}

/**
 * A named group of digest items, in display order.
 */
export interface DigestSection {
  /** Stable section id. */
  readonly id: string;
  readonly category: DigestCategory;
  /** Human-readable section title. */
  readonly title: string;
  readonly priority: DigestPriority;
  readonly items: readonly DigestItem[];
}

/**
 * Structured metadata of a digest.
 */
export interface DigestMetadata {
  readonly kind: DigestKind;
  /** Optional human-readable digest title. */
  readonly title?: string;
  /** ISO-8601 UTC timestamp of the digest's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the most recent modification. */
  readonly updatedAt: string;
  readonly status: DigestStatus;
  /** Whether the digest has been marked read. */
  readonly read: boolean;
  readonly priority: DigestPriority;
  /** Stable tags; defaults to an empty array when created. */
  readonly tags: readonly string[];
  readonly window: DigestWindow;
  /** The most recent delivery record, when delivered. */
  readonly delivery?: DigestDelivery;
}

/**
 * Deterministic aggregate counts of a digest.
 */
export interface DigestStatistics {
  /** Number of sections (including the statistics section). */
  readonly sectionCount: number;
  /** Number of items across content sections (statistics excluded). */
  readonly itemCount: number;
  /** Estimated token cost of the digest (see `estimateDigestTokens`). */
  readonly totalTokens: number;
  /** Number of distinct item sources. */
  readonly sourceCount: number;
  /** Item count per category (statistics excluded). */
  readonly categories: Readonly<Record<string, number>>;
}

/**
 * An immutable digest: metadata, ordered sections, and derived statistics.
 */
export interface Digest {
  /** Stable digest id; deterministic when derived by `createDigest`. */
  readonly id: string;
  readonly metadata: DigestMetadata;
  readonly sections: readonly DigestSection[];
  readonly statistics: DigestStatistics;
}

/**
 * Lightweight projection of a digest for list/overview views.
 */
export interface DigestSummary {
  readonly id: string;
  readonly kind: DigestKind;
  readonly title?: string;
  readonly status: DigestStatus;
  readonly priority: DigestPriority;
  readonly read: boolean;
  /** ISO-8601 UTC timestamp of the digest's creation. */
  readonly createdAt: string;
  readonly sectionCount: number;
  readonly itemCount: number;
  readonly totalTokens: number;
}

/**
 * A stable reference to a digest.
 */
export interface DigestReference {
  readonly digestId: string;
  readonly kind?: DigestKind;
}

/**
 * The lifecycle history of a single digest.
 */
export interface DigestHistory {
  readonly digestId: string;
  /** ISO-8601 UTC timestamp of the most recent publication, when published. */
  readonly publishedAt?: string;
  /** ISO-8601 UTC timestamp of the most recent read, when read. */
  readonly readAt?: string;
  /** Every recorded delivery. */
  readonly deliveries: readonly DigestDelivery[];
}

/**
 * A template section: which category to render, under what title, with what
 * priority and optional item cap.
 */
export interface DigestTemplateSection {
  readonly category: DigestCategory;
  /** Human-readable section title. */
  readonly title: string;
  readonly priority: DigestPriority;
  /** Hard cap on the number of items rendered for this section. */
  readonly maxItems?: number;
}

/**
 * A pure digest template: the fixed shape a kind of digest is built from
 * (title, priority, window semantics, and the ordered section list).
 */
export interface DigestTemplate {
  /** Stable template id. */
  readonly id: string;
  readonly kind: DigestKind;
  /** Human-readable digest title. */
  readonly title: string;
  readonly priority: DigestPriority;
  /** Window length in days (1 = day window, 7 = week window). */
  readonly windowDays: number;
  /** Sections in display order (categories unique within a template). */
  readonly sections: readonly DigestTemplateSection[];
}

/**
 * The raw, gathered snapshot the digest builder consumes — the normalized
 * output of the data sources, fully decoupled from the engines.
 */
export interface DigestContext {
  readonly userId: string;
  /** ISO-8601 UTC timestamp of the digest. */
  readonly now: string;
  readonly window: DigestWindow;
  /** Assembled context prompt from the Context Engine (informational). */
  readonly contextPrompt: string;
  /** Deterministic summary text of the most recent conversation. */
  readonly conversationSummary: string;
  /** Every gathered item (deduplicated), each carrying its category. */
  readonly items: readonly DigestItem[];
}

/**
 * Deterministic 32-bit FNV-1a hash of `value`, rendered as lowercase hex.
 * Used to derive stable digest/item ids from content, so the creators stay
 * pure and deterministic. (The job layer exposes a sibling under the name
 * `hashString`; this layer owns its `hashDigest`.)
 */
export function hashDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic digest id derived from the digest's own contents. */
function digestIdFor(
  kind: DigestKind,
  createdAt: string,
  from: string,
  to: string,
): string {
  return `digest-${hashDigest(`${kind}:${createdAt}:${from}:${to}`)}`;
}

/** Options accepted by {@link createItem}. */
export interface CreateItemInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly category: DigestCategory;
  readonly title: string;
  readonly content: string;
  readonly importance?: DigestImportance;
  readonly timestamp?: string;
  readonly source?: string;
}

/**
 * Build a new immutable digest item.
 *
 * `id` defaults to a deterministic hash of category + title + content +
 * timestamp + source. The returned object is new and detached from all
 * inputs.
 */
export function createItem(input: CreateItemInput): DigestItem {
  return {
    id:
      input.id ??
      `item-${hashDigest(
        `${input.category}:${input.title}:${input.content}:${input.timestamp ?? ""}:${input.source ?? ""}`,
      )}`,
    category: input.category,
    title: input.title,
    content: input.content,
    importance: input.importance ?? "normal",
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
}

/** Options accepted by {@link createSection}. */
export interface CreateSectionInput {
  /** Explicit id; defaults to `section-<category>`. */
  readonly id?: string;
  readonly category: DigestCategory;
  readonly title: string;
  readonly priority?: DigestPriority;
  readonly items?: readonly DigestItem[];
}

/**
 * Build a new immutable digest section. `items` are copied as a new array;
 * the returned object is new and detached from all inputs.
 */
export function createSection(input: CreateSectionInput): DigestSection {
  return {
    id: input.id ?? `section-${input.category}`,
    category: input.category,
    title: input.title,
    priority: input.priority ?? DEFAULT_DIGEST_PRIORITY,
    items: input.items !== undefined ? [...input.items] : [],
  };
}

/** Options accepted by {@link createDigest}. */
export interface CreateDigestInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly kind: DigestKind;
  readonly title?: string;
  /** ISO-8601 UTC timestamp of the digest's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the most recent modification; defaults to `createdAt`. */
  readonly updatedAt?: string;
  readonly status?: DigestStatus;
  readonly read?: boolean;
  readonly priority?: DigestPriority;
  readonly tags?: readonly string[];
  readonly window: DigestWindow;
  readonly delivery?: DigestDelivery;
  readonly sections?: readonly DigestSection[];
}

/**
 * Build a new immutable digest.
 *
 * - `id` defaults to a deterministic hash of kind + createdAt + window.
 * - `status` defaults to `"draft"`, `priority` to `"normal"`, `read` to
 *   `false`, `tags` to `[]`.
 * - `sections` are copied section-by-section (items are shared by reference
 *   — sections are immutable). The returned object is new and detached.
 * - `statistics` are derived deterministically (see `computeDigestStatistics`).
 */
export function createDigest(input: CreateDigestInput): Digest {
  const sections = input.sections !== undefined ? [...input.sections] : [];
  const metadata: DigestMetadata = {
    kind: input.kind,
    ...(input.title !== undefined ? { title: input.title } : {}),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    status: input.status ?? DEFAULT_DIGEST_STATUS,
    read: input.read ?? DEFAULT_DIGEST_READ,
    priority: input.priority ?? DEFAULT_DIGEST_PRIORITY,
    tags: input.tags !== undefined ? [...input.tags] : [],
    window: { from: input.window.from, to: input.window.to },
    ...(input.delivery !== undefined
      ? { delivery: cloneDelivery(input.delivery) }
      : {}),
  };

  const digest: Digest = {
    id:
      input.id ??
      digestIdFor(metadata.kind, metadata.createdAt, metadata.window.from, metadata.window.to),
    metadata,
    sections,
    statistics: emptyStatistics(),
  };

  return {
    ...digest,
    statistics: computeDigestStatistics(digest),
  };
}

/**
 * Estimate the total token cost of a digest: for every section, its title,
 * and for every item, title + content, using the shared `estimateTokens`
 * heuristic. Deterministic and pure.
 */
export function estimateDigestTokens(digest: Digest): number {
  let total = 0;
  for (const section of digest.sections) {
    total += estimateTokens(section.title);
    for (const item of section.items) {
      total += estimateTokens(item.title) + estimateTokens(item.content);
    }
  }
  return total;
}

/**
 * Derive the deterministic statistics of a digest.
 *
 * - `itemCount`/`categories` count content items only (the statistics
 *   section is excluded from the per-category counts so it never feeds
 *   itself); `sectionCount` counts every section.
 * - `sourceCount` counts distinct item sources.
 * - `totalTokens` uses `estimateDigestTokens`.
 */
export function computeDigestStatistics(digest: Digest): DigestStatistics {
  const categories: Record<string, number> = {};
  let itemCount = 0;
  const sources = new Set<string>();
  for (const section of digest.sections) {
    if (section.category === "statistics") continue;
    for (const item of section.items) {
      itemCount += 1;
      categories[item.category] = (categories[item.category] ?? 0) + 1;
      if (item.source !== undefined) sources.add(item.source);
    }
  }
  return {
    sectionCount: digest.sections.length,
    itemCount,
    totalTokens: estimateDigestTokens(digest),
    sourceCount: sources.size,
    categories,
  };
}

/** Empty statistics used while a digest is being assembled. */
function emptyStatistics(): DigestStatistics {
  return {
    sectionCount: 0,
    itemCount: 0,
    totalTokens: 0,
    sourceCount: 0,
    categories: {},
  };
}

/**
 * A partial patch applied by {@link touchDigest} (and the repository's
 * `update`). Keys present in the patch are applied; missing keys are
 * preserved. A `null` value clears the corresponding optional field.
 */
export type DigestPatch = Partial<{
  kind: DigestKind;
  title: string | null;
  status: DigestStatus;
  read: boolean;
  priority: DigestPriority;
  tags: readonly string[];
  window: DigestWindow;
  delivery: DigestDelivery | null;
  updatedAt: string;
  createdAt: string;
  sections: readonly DigestSection[];
}>;

/**
 * Return the successor digest with the patch applied.
 *
 * Missing patch keys are preserved; `tags` and `sections` are copied; a
 * `null` value clears an optional field. `statistics` are re-derived after
 * the patch. Deterministic; the input is never mutated.
 */
export function touchDigest(digest: Digest, patch: DigestPatch): Digest {
  const next: Digest = {
    id: digest.id,
    metadata: {
      kind: patch.kind ?? digest.metadata.kind,
      ...(patch.title !== undefined
        ? patch.title !== null
          ? { title: patch.title }
          : {}
        : digest.metadata.title !== undefined
          ? { title: digest.metadata.title }
          : {}),
      createdAt: patch.createdAt ?? digest.metadata.createdAt,
      updatedAt: patch.updatedAt ?? digest.metadata.updatedAt,
      status: patch.status ?? digest.metadata.status,
      read: patch.read ?? digest.metadata.read,
      priority: patch.priority ?? digest.metadata.priority,
      tags: patch.tags !== undefined ? [...patch.tags] : [...digest.metadata.tags],
      window:
        patch.window !== undefined
          ? { from: patch.window.from, to: patch.window.to }
          : { from: digest.metadata.window.from, to: digest.metadata.window.to },
      ...(patch.delivery !== undefined
        ? patch.delivery !== null
          ? { delivery: cloneDelivery(patch.delivery) }
          : {}
        : digest.metadata.delivery !== undefined
          ? { delivery: cloneDelivery(digest.metadata.delivery) }
          : {}),
    },
    sections: patch.sections !== undefined ? [...patch.sections] : [...digest.sections],
    statistics: emptyStatistics(),
  };
  return { ...next, statistics: computeDigestStatistics(next) };
}

/**
 * Deep-freeze a digest in place and return it.
 *
 * Freezes the digest, its metadata (and `tags`), its window, its delivery
 * (and recipients), the sections array, and every section/item. Idempotent:
 * freezing an already frozen digest is a no-op.
 */
export function freezeDigest(digest: Digest): Digest {
  Object.freeze(digest.metadata.tags);
  Object.freeze(digest.metadata.window);
  if (digest.metadata.delivery !== undefined) {
    Object.freeze(digest.metadata.delivery);
    Object.freeze(digest.metadata.delivery.recipients);
  }
  Object.freeze(digest.metadata);
  for (const section of digest.sections) {
    for (const item of section.items) {
      Object.freeze(item);
    }
    Object.freeze(section.items);
    Object.freeze(section);
  }
  Object.freeze(digest.sections);
  Object.freeze(digest.statistics);
  Object.freeze(digest);
  return digest;
}

/**
 * Return a deep, detached copy of a digest.
 *
 * Every object is new — the digest, its metadata (and `tags`), its window,
 * its delivery (and recipients), the sections array, and each section/item.
 * Nested values inside item `content` strings are primitives. The clone is
 * not frozen (call `freezeDigest` to freeze it).
 */
export function cloneDigest(digest: Digest): Digest {
  const metadata = touchDigest(digest, {}).metadata;
  const sections = digest.sections.map((section) =>
    createSection({
      id: section.id,
      category: section.category,
      title: section.title,
      priority: section.priority,
      items: section.items.map((item) =>
        createItem({
          id: item.id,
          category: item.category,
          title: item.title,
          content: item.content,
          importance: item.importance,
          ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
          ...(item.source !== undefined ? { source: item.source } : {}),
        }),
      ),
    }),
  );
  const base: Digest = {
    id: digest.id,
    metadata,
    sections,
    statistics: emptyStatistics(),
  };
  return { ...base, statistics: computeDigestStatistics(base) };
}

/** Detached copy of a delivery record. */
export function cloneDelivery(delivery: DigestDelivery): DigestDelivery {
  return {
    format: delivery.format,
    recipients: delivery.recipients.map((recipient) => ({
      ...(recipient.id !== undefined ? { id: recipient.id } : {}),
      ...(recipient.name !== undefined ? { name: recipient.name } : {}),
      address: recipient.address,
    })),
    ...(delivery.deliveredAt !== undefined ? { deliveredAt: delivery.deliveredAt } : {}),
  };
}

/**
 * Build a lightweight summary projection of a digest (see `DigestSummary`).
 */
export function createDigestSummary(digest: Digest): DigestSummary {
  return {
    id: digest.id,
    kind: digest.metadata.kind,
    ...(digest.metadata.title !== undefined ? { title: digest.metadata.title } : {}),
    status: digest.metadata.status,
    priority: digest.metadata.priority,
    read: digest.metadata.read,
    createdAt: digest.metadata.createdAt,
    sectionCount: digest.statistics.sectionCount,
    itemCount: digest.statistics.itemCount,
    totalTokens: digest.statistics.totalTokens,
  };
}

/**
 * Build a stable reference to a digest (see `DigestReference`).
 */
export function createDigestReference(digest: Digest): DigestReference {
  return { digestId: digest.id, kind: digest.metadata.kind };
}

/**
 * Build the lifecycle history of a digest (see `DigestHistory`).
 */
export function createDigestHistory(digest: Digest): DigestHistory {
  return {
    digestId: digest.id,
    ...(digest.metadata.status === "published"
      ? { publishedAt: digest.metadata.updatedAt }
      : {}),
    ...(digest.metadata.read ? { readAt: digest.metadata.updatedAt } : {}),
    deliveries:
      digest.metadata.delivery !== undefined
        ? [cloneDelivery(digest.metadata.delivery)]
        : [],
  };
}

/** Options accepted by {@link createDigestDelivery}. */
export interface CreateDigestDeliveryInput {
  readonly format: DigestFormat;
  readonly recipients?: readonly DigestRecipient[];
  /** ISO-8601 UTC timestamp of the delivery. */
  readonly deliveredAt?: string;
}

/**
 * Build a new immutable delivery record (recipients copied).
 */
export function createDigestDelivery(input: CreateDigestDeliveryInput): DigestDelivery {
  return {
    format: input.format,
    recipients: input.recipients !== undefined ? [...input.recipients] : [],
    ...(input.deliveredAt !== undefined ? { deliveredAt: input.deliveredAt } : {}),
  };
}

/** Options accepted by {@link createDigestTemplate}. */
export interface CreateDigestTemplateInput {
  readonly id: string;
  readonly kind: DigestKind;
  readonly title: string;
  readonly priority?: DigestPriority;
  /** Window length in days; defaults to 7 for `weekly`, 1 otherwise. */
  readonly windowDays?: number;
  readonly sections: readonly DigestTemplateSection[];
}

/**
 * Build a new immutable digest template.
 *
 * Validates that every section category appears at most once (a digest must
 * never contain duplicate sections). `sections` are copied as new objects.
 */
export function createDigestTemplate(input: CreateDigestTemplateInput): DigestTemplate {
  const seen = new Set<string>();
  for (const section of input.sections) {
    if (seen.has(section.category)) {
      throw new Error(
        `Digest template "${input.id}" contains duplicate section category "${section.category}"`,
      );
    }
    seen.add(section.category);
  }
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    priority: input.priority ?? DEFAULT_DIGEST_PRIORITY,
    windowDays: input.windowDays ?? (input.kind === "weekly" ? 7 : 1),
    sections: input.sections.map((section) => ({
      category: section.category,
      title: section.title,
      priority: section.priority,
      ...(section.maxItems !== undefined ? { maxItems: section.maxItems } : {}),
    })),
  };
}
