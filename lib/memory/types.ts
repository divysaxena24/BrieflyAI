/**
 * Memory Engine — immutable domain models.
 *
 * Step 1 of the AI Memory Engine: the pure, readonly data model for memories
 * plus the pure helper functions that construct, clone, freeze, summarize,
 * touch, and expire them.
 *
 * No services, no database, no storage, no AI, no embeddings, and no side
 * effects live here — only data and pure functions. Every function is
 * deterministic: identical inputs always produce identical outputs, and
 * caller-supplied objects/arrays are never referenced or mutated.
 *
 * Timestamps are always supplied by the caller (no `Date.now()`) so every
 * operation stays pure and reproducible.
 */

import { estimateTokens } from "@/lib/context/tokenBudget";
import type { ContextMetadata } from "@/lib/context/types";

/** Semantic category of a memory. */
export type MemoryKind = "fact" | "preference" | "task" | "knowledge" | "conversation" | "context";

/** Provenance of a memory. */
export type MemorySource = "user" | "assistant" | "system" | "tool" | "derived";

/**
 * Caller/heuristic importance of a memory — the exact union already used by
 * the Context Engine (`ContextMetadata["importance"]`), so memories rank and
 * integrate without conversion.
 */
export type MemoryImportance = NonNullable<ContextMetadata["importance"]>;

/** Retention tier: short-term (high churn) vs long-term (persistent). */
export type MemoryTier = "short-term" | "long-term";

/** Lifecycle state of a memory. */
export type MemoryState = "active" | "archived" | "deleted";

/** Default kind assigned by `createMemory` when none is provided. */
export const DEFAULT_MEMORY_KIND: MemoryKind = "knowledge";

/** Default source assigned by `createMemory` when none is provided. */
export const DEFAULT_MEMORY_SOURCE: MemorySource = "user";

/** Default importance assigned by `createMemory` when none is provided. */
export const DEFAULT_MEMORY_IMPORTANCE: MemoryImportance = "normal";

/** Default tier assigned by `createMemory` when none is provided. */
export const DEFAULT_MEMORY_TIER: MemoryTier = "short-term";

/** Default state assigned by `createMemory` when none is provided. */
export const DEFAULT_MEMORY_STATE: MemoryState = "active";

/** Default access count assigned by `createMemory`. */
export const DEFAULT_MEMORY_ACCESS_COUNT = 0;

/** Length of the content preview rendered by `createMemorySummary`. */
const SUMMARY_PREVIEW_LENGTH = 80;

/**
 * Structured metadata of a memory.
 *
 * `updatedAt` is the last modification time (content/title/kind/... changes);
 * `lastAccessedAt`/`accessCount` track read activity via `touchMemory` and do
 * not modify `updatedAt`.
 */
export interface MemoryMetadata {
  /** Short human-readable title. */
  readonly title: string;
  readonly kind: MemoryKind;
  readonly source: MemorySource;
  readonly importance: MemoryImportance;
  readonly tier: MemoryTier;
  readonly state: MemoryState;
  /** ISO-8601 UTC timestamp of the memory's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the most recent modification. */
  readonly updatedAt: string;
  /** ISO-8601 UTC timestamp of the most recent access, or null when never accessed. */
  readonly lastAccessedAt: string | null;
  /** Number of times the memory was touched (read). */
  readonly accessCount: number;
  /** Stable tags; defaults to an empty array when created. */
  readonly tags: readonly string[];
  /** Conversation the memory is linked to, when applicable. */
  readonly conversationId?: string;
  /** Optional expiry timestamp; `isExpired` returns true at or after it. */
  readonly expiresAt?: string;
}

/**
 * An immutable memory: metadata plus the memory's text content.
 */
export interface Memory {
  /** Stable memory id; deterministic when derived by `createMemory`. */
  readonly id: string;
  readonly metadata: MemoryMetadata;
  /** The memory text. */
  readonly content: string;
  /** Optional extra structured fields, opaque to this layer. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Lightweight projection of a memory for list/overview views.
 */
export interface MemorySummary {
  readonly id: string;
  readonly title: string;
  readonly kind: MemoryKind;
  readonly importance: MemoryImportance;
  readonly tier: MemoryTier;
  /** ISO-8601 UTC timestamp of the most recent modification. */
  readonly updatedAt: string;
  /** Estimated token cost of the memory content. */
  readonly tokenEstimate: number;
  /** Optional short content preview. */
  readonly preview?: string;
}

/**
 * A stable reference to a memory — the dedupe/citation key of the memory layer.
 */
export interface MemoryReference {
  readonly memoryId: string;
  /** Conversation the memory is linked to, when applicable. */
  readonly conversationId?: string;
}

/**
 * A memory with a relevance score in [0, 1], produced by the semantic search
 * and the ranker.
 */
export interface MemorySearchResult extends Memory {
  /** Final relevance score in [0, 1]. */
  readonly score: number;
}

/**
 * Deterministic 32-bit FNV-1a hash of `value`, rendered as lowercase hex.
 * Used to derive stable memory ids from a memory's own contents.
 */
function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic memory id derived from the memory's own contents. */
function memoryIdFor(kind: MemoryKind, title: string, content: string, createdAt: string): string {
  return `mem-${hashString(`${kind}:${title}:${content}:${createdAt}`)}`;
}

/** Options accepted by {@link createMemory}. */
export interface CreateMemoryInput {
  /** Explicit id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly title: string;
  readonly content: string;
  readonly kind?: MemoryKind;
  readonly source?: MemorySource;
  readonly importance?: MemoryImportance;
  readonly tier?: MemoryTier;
  readonly state?: MemoryState;
  /** ISO-8601 UTC timestamp of the memory's creation. */
  readonly createdAt: string;
  /** ISO-8601 UTC timestamp of the most recent modification; defaults to `createdAt`. */
  readonly updatedAt?: string;
  /** ISO-8601 UTC timestamp of the most recent access; defaults to null. */
  readonly lastAccessedAt?: string | null;
  /** Access count; defaults to 0. */
  readonly accessCount?: number;
  readonly tags?: readonly string[];
  readonly conversationId?: string;
  readonly expiresAt?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Build a new immutable memory.
 *
 * - `id` defaults to a deterministic hash of kind + title + content +
 *   createdAt. Derived ids are stable but not guaranteed unique across
 *   memories with identical inputs; callers that need uniqueness should pass
 *   an explicit `id`.
 * - `tags` is copied as a new array; `extra` is copied as a new record
 *   (nested values are shared by reference).
 * - The returned object is new and detached from all inputs.
 */
export function createMemory(input: CreateMemoryInput): Memory {
  const metadata: MemoryMetadata = {
    title: input.title,
    kind: input.kind ?? DEFAULT_MEMORY_KIND,
    source: input.source ?? DEFAULT_MEMORY_SOURCE,
    importance: input.importance ?? DEFAULT_MEMORY_IMPORTANCE,
    tier: input.tier ?? DEFAULT_MEMORY_TIER,
    state: input.state ?? DEFAULT_MEMORY_STATE,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    lastAccessedAt: input.lastAccessedAt ?? null,
    accessCount: input.accessCount ?? DEFAULT_MEMORY_ACCESS_COUNT,
    tags: input.tags !== undefined ? [...input.tags] : [],
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };

  return {
    id: input.id ?? memoryIdFor(metadata.kind, input.title, input.content, input.createdAt),
    metadata,
    content: input.content,
    ...(input.extra !== undefined ? { extra: { ...input.extra } } : {}),
  };
}

/**
 * Estimate the total token cost of a memory using the shared
 * `estimateTokens` heuristic (`ceil(length / 4)`) on the content. Content
 * only — the metadata/title are not charged, matching the Context Engine's
 * `tokenEstimate` semantics. Deterministic and pure.
 */
export function estimateMemoryTokens(memory: Memory): number {
  return estimateTokens(memory.content);
}

/**
 * Build a lightweight summary projection of a memory (see `MemorySummary`).
 * `preview` is the first 80 characters of the content when it is non-empty.
 */
export function createMemorySummary(memory: Memory): MemorySummary {
  const preview =
    memory.content.length > 0 ? memory.content.slice(0, SUMMARY_PREVIEW_LENGTH) : undefined;
  return {
    id: memory.id,
    title: memory.metadata.title,
    kind: memory.metadata.kind,
    importance: memory.metadata.importance,
    tier: memory.metadata.tier,
    updatedAt: memory.metadata.updatedAt,
    tokenEstimate: estimateMemoryTokens(memory),
    ...(preview !== undefined ? { preview } : {}),
  };
}

/**
 * Return the successor memory with `lastAccessedAt` set to `at` and
 * `accessCount` incremented by one. `updatedAt` is NOT changed — accessing a
 * memory is not a modification. Deterministic; the input is never mutated.
 */
export function touchMemory(memory: Memory, at: string): Memory {
  return {
    id: memory.id,
    metadata: {
      ...memory.metadata,
      lastAccessedAt: at,
      accessCount: memory.metadata.accessCount + 1,
    },
    content: memory.content,
    ...(memory.extra !== undefined ? { extra: { ...memory.extra } } : {}),
  };
}

/**
 * Whether a memory has expired at or before `now`. A memory without
 * `expiresAt` never expires. Deterministic — `now` is supplied by the caller.
 */
export function isExpired(memory: Memory, now: string): boolean {
  if (memory.metadata.expiresAt === undefined) return false;
  return Date.parse(memory.metadata.expiresAt) <= Date.parse(now);
}

/**
 * Deep-freeze a memory in place and return it.
 *
 * Freezes the memory, its metadata (and `tags`), and its `extra` record.
 * Idempotent: freezing an already frozen memory is a no-op.
 */
export function freezeMemory(memory: Memory): Memory {
  Object.freeze(memory.metadata.tags);
  Object.freeze(memory.metadata);
  if (memory.extra !== undefined) Object.freeze(memory.extra);
  Object.freeze(memory);
  return memory;
}

/**
 * Return a deep, detached copy of a memory.
 *
 * Every object is new — the memory, its metadata (and `tags`), and its
 * `extra` record — so mutating the clone's own structure can never affect the
 * source and vice versa. Nested values inside `extra` are shared by
 * reference. The clone is not frozen (call `freezeMemory` to freeze it).
 * Values, including optional fields, are preserved exactly.
 */
export function cloneMemory(memory: Memory): Memory {
  const metadata: MemoryMetadata = {
    title: memory.metadata.title,
    kind: memory.metadata.kind,
    source: memory.metadata.source,
    importance: memory.metadata.importance,
    tier: memory.metadata.tier,
    state: memory.metadata.state,
    createdAt: memory.metadata.createdAt,
    updatedAt: memory.metadata.updatedAt,
    lastAccessedAt: memory.metadata.lastAccessedAt,
    accessCount: memory.metadata.accessCount,
    tags: [...memory.metadata.tags],
    ...(memory.metadata.conversationId !== undefined
      ? { conversationId: memory.metadata.conversationId }
      : {}),
    ...(memory.metadata.expiresAt !== undefined ? { expiresAt: memory.metadata.expiresAt } : {}),
  };

  return {
    id: memory.id,
    metadata,
    content: memory.content,
    ...(memory.extra !== undefined ? { extra: { ...memory.extra } } : {}),
  };
}
