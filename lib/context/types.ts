/**
 * Context Engine — core type definitions.
 *
 * This module is the type-only foundation for the Unified Context Engine.
 * Every later module (sources, builder, ranker, deduplicator, compressor,
 * assembler, token budgeting, prompt builder) consumes these types.
 *
 * No runtime logic lives here — interfaces and types only.
 */

/**
 * Access permissions attached to a piece of retrieved context.
 *
 * Derived from the connected integration record (`integrations.permissions`)
 * and its OAuth token scopes (`oauth_tokens.scope`). Used to gate retrieval
 * and to let the assembler enforce what the engine is allowed to include.
 */
export interface ContextPermission {
  /** ID of the integration record that granted this access. */
  integrationId: string;
  /** Platform id (e.g. "gmail", "github", "memory"). */
  platform: string;
  /** OAuth scopes granted to the integration (space-separated value split into a list). */
  scopes: string[];
  /** Granular access level granted by the integration. */
  level: "read" | "write";
}

/**
 * Structured metadata describing what a piece of context is and where it
 * came from. Used for deduplication, ranking, citations, and display.
 */
export interface ContextMetadata {
  /** The semantic category of the context item. */
  kind:
    | "email"
    | "thread"
    | "message"
    | "channel"
    | "event"
    | "file"
    | "issue"
    | "pr"
    | "commit"
    | "memory"
    | "conversation";
  /** Provider-side identifier of the underlying entity (dedupe key input). */
  entityId: string;
  /** Thread/conversation identifier when the item belongs to a thread. */
  threadId?: string;
  /** Stable identifier for the containing conversation. */
  conversationId?: string;
  /** Deep link back to the source item in the provider UI. */
  url?: string;
  /** Human-readable author/sender of the item, when known. */
  author?: string;
  /** Caller/heuristic importance estimate used during ranking. */
  importance?: "low" | "normal" | "high" | "critical";
  /** Provider payload. Never sent to the LLM. */
  raw?: Record<string, unknown>;
}

/**
 * A single unit of context gathered from a source and passed toward the LLM.
 */
export interface Context {
  /** Deterministic identity: hash of source + entityId. Stable across runs. */
  id: string;
  /** Source id the context came from (e.g. "gmail", "github", "memory"). */
  source: string;
  /** Short human-readable title for the item. */
  title: string;
  /** The text content that will be sent to the LLM. */
  content: string;
  /** ISO timestamp of the item, or null when unknown. */
  timestamp: string | null;
  /** Relevance score in [0, 1], assigned by the ranker. */
  relevance: number;
  /** Estimated token count of the current content. */
  tokenEstimate: number;
  /** Token count before any compression was applied, when changed. */
  originalTokens?: number;
  /** True when the content was cut to fit a token budget. */
  truncated: boolean;
  /** True when the content was summarized or structurally condensed. */
  compressed: boolean;
  /** Structured metadata about the item (kind, ids, importance, ...). */
  metadata: ContextMetadata;
  /** Permissions of the integration that supplied this item, when known. */
  permissions: ContextPermission | null;
}

/**
 * Input contract passed by the engine to every context source.
 */
export interface RetrievalQuery {
  /** Application-level user id the retrieval is performed for. */
  userId: string;
  /** The user's request text. */
  query: string;
  /** Prior conversation turns that may inform retrieval, newest last. */
  history?: string[];
  /** Restrict retrieval to these source ids (empty/omitted = all available). */
  sourceFilters?: string[];
  /** Hard cap on items a source may return. */
  maxItems?: number;
  /** Hard cap on tokens a source may return (source-level budget). */
  maxTokens?: number;
  /** Restrict retrieval to a time window (both ends optional, open-ended when omitted). */
  timeRange?: {
    /** Inclusive start of the window. */
    from?: Date;
    /** Inclusive end of the window. */
    to?: Date;
  };
}

/**
 * Contract implemented by every context source (one per platform, plus memory).
 */
export interface ContextSource {
  /** Unique source id (e.g. "gmail", "github", "memory"). */
  id: string;
  /** Default ranking weight of this source relative to others. */
  priority: number;
  /**
   * Whether the source can serve context for a user right now
   * (e.g. integration connected, required scope granted).
   */
  isAvailable(userId: string): Promise<boolean>;
  /**
   * Retrieve candidate context items for a query.
   * Must never throw for "not available" cases — return an empty array.
   */
  retrieve(query: RetrievalQuery): Promise<Context[]>;
}

/**
 * Result of allocating a model's context window across fixed overhead and
 * per-source budgets. Produced by the token budgeting stage.
 */
export interface TokenBudget {
  /** Total token capacity available for context + overhead. */
  totalBudget: number;
  /** Tokens reserved for system prompt, query, history, tools, and response. */
  reservedBudget: number;
  /** Tokens available for context content (totalBudget - reservedBudget). */
  availableBudget: number;
  /** Token allowance per source id. */
  perSourceBudget: Record<string, number>;
}

/**
 * A context item after relevance ranking. Extends Context with its score.
 */
export type RankedContext = Context & {
  /** Final relevance score in [0, 1]. */
  score: number;
};

/**
 * Output of the compression stage: the context set that fits the budget.
 */
export interface CompressionResult {
  /** Context items that survived compression, within budget. */
  contexts: Context[];
  /** Total tokens consumed by the surviving contexts. */
  usedTokens: number;
  /** Tokens still available under the budget. */
  remainingTokens: number;
}
