/**
 * AI Actions — action planner (pure, deterministic).
 *
 * Converts an intent (free text and/or an explicit request list) into an
 * immutable `ActionPlan` of `Action` objects. No LLM and no reasoning live
 * here — the planner is a deterministic rule engine:
 *
 * - **Keyword detection**: when no explicit requests are given, the intent
 *   text is scanned against a fixed keyword table (`ACTION_KEYWORDS`) that
 *   maps intent words to action types.
 * - **Enrichment**: each request is completed from the intent and the
 *   injected `PlannerSources` (Conversation/Memory/Digest/Job engines) — a
 *   search query defaults to the intent text, an `update_conversation` action
 *   resolves the most recent conversation, a `run_job` action resolves the
 *   first pending job, and so on.
 * - **Stable ordering**: planned actions are ordered by priority
 *   (`critical` > `high` > `normal` > `low`), then by a canonical type order,
 *   then by name — fully deterministic.
 * - **Dependencies**: `update_conversation` depends on every other planned
 *   action (the conversation note summarizes the completed plan); explicit
 *   `dependsOn` type references on a request are resolved to the planned
 *   action ids. Self-references and unknown references are ignored (failure
 *   isolation).
 * - **Deduplication**: one action per type — later duplicates of a type are
 *   dropped (first occurrence wins).
 *
 * The planner reads its sources only to *enrich* requests; a throwing source
 * contributes nothing (the plan still builds). The returned `ActionPlan` is
 * validated by `createActionPlan` (acyclic, known references) and deep-frozen
 * by construction.
 */

import { createExecutionPlan, type ExecutionStep } from "@/lib/tools/plan";
import type { Conversation } from "@/lib/conversation/types";
import type { Digest } from "@/lib/digest/types";
import type { Job } from "@/lib/jobs/types";
import type { Memory } from "@/lib/memory/types";
import {
  PRIORITY_RANK,
  createAction,
  hashAction,
  type Action,
  type ActionPriority,
  type ActionType,
  type CreateActionInput,
} from "./types";

/** A canonical, deterministic ordering of action types within a plan. */
export const ACTION_TYPE_ORDER: readonly ActionType[] = Object.freeze([
  "search_gmail",
  "search_calendar",
  "search_drive",
  "search_github",
  "create_memory",
  "update_conversation",
  "generate_digest",
  "run_job",
  "execute_tool_plan",
  "custom",
]);

/**
 * The deterministic keyword table: intent words → planned action types.
 * Scanned in canonical type order; each type is requested at most once.
 */
export const ACTION_KEYWORDS: Readonly<Record<ActionType, readonly string[]>> = Object.freeze({
  search_gmail: Object.freeze(["email", "gmail", "mail", "inbox"]),
  search_calendar: Object.freeze(["calendar", "meeting", "schedule", "event"]),
  search_drive: Object.freeze(["drive", "file", "document", "folder"]),
  search_github: Object.freeze(["github", "repo", "repository", "pull request"]),
  create_memory: Object.freeze(["remember", "memory", "note", "store"]),
  update_conversation: Object.freeze(["conversation", "context", "chat"]),
  generate_digest: Object.freeze(["digest", "summary", "brief", "daily brief"]),
  run_job: Object.freeze(["job", "background", "task", "cron"]),
  execute_tool_plan: Object.freeze(["tool", "plan", "execute", "workflow"]),
  custom: Object.freeze([]),
});

/**
 * Planner data-source consumption (documented, per architecture rules):
 *
 * - `listConversations` — `update_conversation` resolves the most recent
 *   conversation when the request carries no `conversationId`.
 * - `listJobs` — `run_job` resolves the first pending, non-archived job when
 *   the request carries no `jobId`.
 * - `listMemories` — `create_memory` is *deduplicated* against existing
 *   memories: a request whose `content` already exists is dropped (the
 *   planner never plans a duplicate memory).
 * - `listDigests` — `generate_digest` is *deduplicated* against existing
 *   digests: a request whose kind+createdAt already exists is dropped (the
 *   planner never plans a digest the Digest Engine would reject as a
 *   duplicate id).
 *
 * Context signals and Tool plans are consumed at execution time (the
 * `generate_digest` / `execute_tool_plan` handlers drive the Context Engine
 * and the Tool Executor); the planner itself stays a pure rule engine.
 */

/** The default priority derivation per action type (deterministic). */
const DEFAULT_TYPE_PRIORITY: Readonly<Record<ActionType, ActionPriority>> = Object.freeze({
  search_gmail: "normal",
  search_calendar: "normal",
  search_drive: "normal",
  search_github: "normal",
  create_memory: "normal",
  update_conversation: "low",
  generate_digest: "high",
  run_job: "high",
  execute_tool_plan: "normal",
  custom: "normal",
});

/** Map a search action type to its built-in read-tool id. */
const SEARCH_TOOL_BY_TYPE: Readonly<Partial<Record<ActionType, string>>> = Object.freeze({
  search_gmail: "search.gmail",
  search_calendar: "search.calendar",
  search_drive: "search.drive",
  search_github: "search.github",
});

/**
 * The data surfaces the planner may read to enrich requests — the
 * dependency-injection seam over the existing engines. Every method is a
 * read; a throwing source degrades to no contribution.
 */
export interface PlannerSources {
  /** Snapshot of the Conversation Engine's conversations. */
  readonly listConversations?: () => readonly Conversation[];
  /** Snapshot of the Memory Engine's memories. */
  readonly listMemories?: () => readonly Memory[];
  /** Snapshot of the Digest Engine's digests. */
  readonly listDigests?: () => readonly Digest[];
  /** Snapshot of the Job Engine's jobs. */
  readonly listJobs?: () => readonly Job[];
}

/** A single requested action inside an intent. */
export interface PlanActionRequest {
  readonly type: ActionType;
  /** The action's input payload (enriched with defaults when partial). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Explicit priority; defaults per type (`DEFAULT_TYPE_PRIORITY`). */
  readonly priority?: ActionPriority;
  /** Explicit human-readable name; defaults to the type. */
  readonly name?: string;
  /**
   * Action *types* this request depends on. Resolved to the planned action
   * ids; self- and unknown references are ignored.
   */
  readonly dependsOn?: readonly ActionType[];
}

/** Input accepted by {@link ActionPlanner.plan}. */
export interface PlanIntent {
  /** The intent text (used for keyword detection and query defaults). */
  readonly text: string;
  /** Application-level user id the actions are planned for. */
  readonly userId: string;
  /** ISO-8601 UTC timestamp of the planning. */
  readonly now: string;
  /** Conversation the intent came from, when applicable. */
  readonly conversationId?: string;
  /**
   * Explicit requests. When omitted (or empty), requests are derived from
   * `text` via the keyword table.
   */
  readonly requests?: readonly PlanActionRequest[];
}

/**
 * An immutable plan of actions produced by the planner.
 *
 * Validated by `createActionPlan` (unique action ids, known dependency
 * references, no self-dependencies, no cycles) and deep-frozen.
 */
export interface ActionPlan {
  /** Stable plan id; deterministic when derived by `createActionPlan`. */
  readonly id: string;
  /** The intent the plan was derived from. */
  readonly intent: string;
  readonly userId: string;
  /** ISO-8601 UTC timestamp of the planning. */
  readonly now: string;
  /** Conversation the plan was derived from, when applicable. */
  readonly conversationId?: string;
  /** The planned actions, in deterministic execution order. */
  readonly actions: readonly Action[];
  /** Deterministic one-line summary of the plan. */
  readonly summary: string;
}

/** Options accepted by {@link createActionPlan}. */
export interface CreateActionPlanInput {
  /** Explicit plan id; when omitted, one is derived deterministically. */
  readonly id?: string;
  readonly intent: string;
  readonly userId: string;
  readonly now: string;
  readonly conversationId?: string;
  /** The planned actions (already dependency-resolved). */
  readonly actions: readonly Action[];
}

/**
 * Build an immutable `ActionPlan` from planned actions.
 *
 * Validates the candidate actions (unique ids, dependencies referencing
 * existing actions, no self-dependency, no cycles) and returns the plan
 * deep-frozen: the plan, its actions array, each action, and each action's
 * `dependsOn`/`input` are `Object.freeze`d.
 */
export function createActionPlan(input: CreateActionPlanInput): ActionPlan {
  const actionIds = new Set(input.actions.map((action) => action.id));
  for (const action of input.actions) {
    if (action.dependsOn.includes(action.id)) {
      throw new Error(`Action plan contains an action that depends on itself: "${action.id}"`);
    }
    for (const dependency of action.dependsOn) {
      if (!actionIds.has(dependency)) {
        throw new Error(
          `Action plan action "${action.id}" depends on unknown action "${dependency}"`,
        );
      }
    }
  }

  // Cycle detection via Kahn's algorithm (deterministic; order-independent).
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const action of input.actions) {
    indegree.set(action.id, 0);
    adjacency.set(action.id, []);
  }
  for (const action of input.actions) {
    for (const dependency of new Set(action.dependsOn)) {
      adjacency.get(dependency)?.push(action.id);
      indegree.set(action.id, (indegree.get(action.id) ?? 0) + 1);
    }
  }
  const ready: string[] = input.actions
    .filter((action) => (indegree.get(action.id) ?? 0) === 0)
    .map((action) => action.id);
  let processed = 0;
  while (ready.length > 0) {
    const current = ready.shift() ?? "";
    processed += 1;
    for (const next of adjacency.get(current) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) ready.push(next);
    }
  }
  if (processed !== input.actions.length) {
    throw new Error("Action plan contains a dependency cycle");
  }

  const id =
    input.id ??
    `plan-${hashAction(
      `${input.intent}:${input.userId}:${input.now}:${input.actions.map((a) => a.id).join(",")}`,
    )}`;
  const summary = `${input.actions.length} action(s): ${input.actions
    .map((action) => action.type)
    .join(", ")}`;

  const actions = input.actions.map((action) =>
    Object.freeze({
      ...action,
      input: action.input !== undefined ? Object.freeze({ ...action.input }) : undefined,
      dependsOn: Object.freeze([...action.dependsOn]),
    }),
  );

  return Object.freeze({
    id,
    intent: input.intent,
    userId: input.userId,
    now: input.now,
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    actions: Object.freeze(actions),
    summary,
  });
}

/**
 * The deterministic action planner — a pure rule engine over an intent.
 */
export class ActionPlanner {
  /**
   * Build a planner over optional data sources (dependency injection). When
   * sources are omitted, enrichment that needs them (most recent
   * conversation, first pending job) contributes nothing.
   */
  constructor(private readonly sources?: PlannerSources) {}

  /**
   * Plan an intent into an immutable `ActionPlan`.
   *
   * Pipeline (deterministic):
   * 1. Resolve requests (explicit, or keyword-derived from `text`).
   * 2. Deduplicate by type (first occurrence wins).
   * 3. Enrich each request (query defaults, conversation/job links); requests
   *    that cannot be enriched (no conversation, no pending job) are dropped.
   * 4. Derive dependencies (explicit type refs + the `update_conversation`
   *    depends-on-all rule).
   * 5. Order actions (priority, then type order, then name).
   * 6. Validate + deep-freeze via `createActionPlan`.
   *
   * Never throws for planning decisions: unknown types and unknown dependency
   * references are ignored; an empty request list yields a plan with no
   * actions.
   */
  plan(intent: PlanIntent): ActionPlan {
    const requests = dedupeByType(this.resolveRequests(intent));
    const inputs: CreateActionInput[] = [];
    for (const request of requests) {
      const enriched = this.enrich(request, intent);
      if (enriched !== undefined) inputs.push(enriched);
    }
    const ordered = orderActions(inputs);
    // Preliminarily create the actions so their deterministic ids are known
    // (ids derive from name/type/trigger/priority/timestamps — never from
    // `dependsOn`, so re-creating with dependencies keeps the same ids).
    const preliminary = ordered.map((input) => createAction(input));
    const dependencyIds = new Map(preliminary.map((action) => [action.type, action.id]));
    const actions = ordered.map((input, index) => {
      const request = requests.find((candidate) => candidate.type === input.type);
      return createAction({
        ...input,
        dependsOn: this.resolveDependencies(
          input,
          request,
          dependencyIds,
          preliminary[index].id,
        ),
      });
    });
    return createActionPlan({
      intent: intent.text,
      userId: intent.userId,
      now: intent.now,
      ...(intent.conversationId !== undefined ? { conversationId: intent.conversationId } : {}),
      actions,
    });
  }

  /** Resolve the effective request list (explicit or keyword-derived). */
  private resolveRequests(intent: PlanIntent): readonly PlanActionRequest[] {
    const explicit = intent.requests ?? [];
    if (explicit.length > 0) return explicit;
    return detectIntentRequests(intent.text);
  }

  /**
   * Enrich a request into a full `CreateActionInput`, or `undefined` when the
   * request cannot be satisfied (no conversation to update, no job to run).
   * Never throws — a throwing source degrades to `undefined`.
   */
  private enrich(request: PlanActionRequest, intent: PlanIntent): CreateActionInput | undefined {
    const base: CreateActionInput = {
      name: request.name ?? defaultNameFor(request.type),
      type: request.type,
      priority: request.priority ?? DEFAULT_TYPE_PRIORITY[request.type],
      trigger: "intent",
      createdAt: intent.now,
      ...(intent.conversationId !== undefined
        ? { conversationId: intent.conversationId }
        : {}),
    };

    switch (request.type) {
      case "search_gmail":
      case "search_calendar":
      case "search_drive":
      case "search_github": {
        const query = stringField(request.input, "query") ?? intent.text;
        const maxResults = numberField(request.input, "maxResults");
        return {
          ...base,
          input: {
            query,
            ...(maxResults !== undefined ? { maxResults } : {}),
          },
        };
      }
      case "create_memory": {
        const content = stringField(request.input, "content") ?? intent.text;
        // Deduplicate against existing memories: a memory with this content
        // already exists → the request contributes nothing.
        if (this.hasMemoryContent(content)) return undefined;
        const title = stringField(request.input, "title") ?? truncate(content, 40);
        const memoryId = stringField(request.input, "memoryId");
        return {
          ...base,
          input: { title, content },
          ...(memoryId !== undefined ? { memoryId } : {}),
        };
      }
      case "update_conversation": {
        const conversationId =
          stringField(request.input, "conversationId") ??
          intent.conversationId ??
          this.mostRecentConversationId();
        if (conversationId === undefined) return undefined;
        const content =
          stringField(request.input, "content") ?? `Planned from intent: ${intent.text}`;
        return { ...base, input: { conversationId, content } };
      }
      case "generate_digest": {
        const query = stringField(request.input, "query") ?? intent.text;
        const kind = stringField(request.input, "kind") ?? "morning";
        // Deduplicate against existing digests: a digest of this kind at this
        // time already exists → the request contributes nothing.
        if (this.hasDigestAt(kind, intent.now)) return undefined;
        return { ...base, input: { query, kind } };
      }
      case "run_job": {
        const jobId = stringField(request.input, "jobId") ?? this.firstPendingJobId();
        if (jobId === undefined) return undefined;
        return { ...base, input: { jobId } };
      }
      case "execute_tool_plan": {
        const matched = dedupedSearchTypes(intent);
        const steps: ExecutionStep[] = matched.map((type, index) => ({
          stepId: `step-${index + 1}`,
          toolId: SEARCH_TOOL_BY_TYPE[type] as string,
          input: { query: intent.text },
          dependsOn: [],
        }));
        if (steps.length === 0) return undefined;
        const plan = createExecutionPlan({ id: `plan-${hashAction(intent.text)}`, steps });
        return { ...base, input: { plan } };
      }
      default:
        return { ...base, input: request.input !== undefined ? { ...request.input } : {} };
    }
  }

  /**
   * Resolve the dependency ids of an action: the request's explicit `dependsOn`
   * type references, plus the rule that `update_conversation` depends on every
   * other planned action. Self- and unknown references are ignored.
   */
  private resolveDependencies(
    input: CreateActionInput,
    request: PlanActionRequest | undefined,
    dependencyIds: ReadonlyMap<ActionType, string>,
    ownId: string,
  ): readonly string[] {
    const types = new Set<ActionType>(request?.dependsOn ?? []);
    if (input.type === "update_conversation") {
      for (const type of dependencyIds.keys()) {
        if (type !== "update_conversation") types.add(type);
      }
    }
    const dependsOn: string[] = [];
    for (const type of types) {
      const id = dependencyIds.get(type);
      if (id === undefined || id === ownId) continue;
      if (!dependsOn.includes(id)) dependsOn.push(id);
    }
    return dependsOn;
  }

  /** The id of the most recent conversation, when any exists. */
  private mostRecentConversationId(): string | undefined {
    try {
      const conversations = this.sources?.listConversations?.() ?? [];
      if (conversations.length === 0) return undefined;
      return conversations[conversations.length - 1].id;
    } catch {
      return undefined;
    }
  }

  /** The id of the first pending, non-archived job, when any exists. */
  private firstPendingJobId(): string | undefined {
    try {
      const jobs = this.sources?.listJobs?.() ?? [];
      return jobs.find((job) => job.status === "pending" && !job.archived)?.id;
    } catch {
      return undefined;
    }
  }

  /** Whether an existing memory already carries `content` (dedupe). */
  private hasMemoryContent(content: string): boolean {
    try {
      return (this.sources?.listMemories?.() ?? []).some(
        (memory) => memory.content === content,
      );
    } catch {
      return false;
    }
  }

  /**
   * Whether an existing digest of `kind` was created at `now` (dedupe).
   */
  private hasDigestAt(kind: string, now: string): boolean {
    try {
      const digests = this.sources?.listDigests?.() ?? [];
      return digests.some(
        (digest) => digest.metadata.kind === kind && digest.metadata.createdAt === now,
      );
    } catch {
      return false;
    }
  }
}

/** Detect the action types the intent text requests (keyword table). */
export function detectIntentRequests(text: string): readonly PlanActionRequest[] {
  const lowered = text.toLowerCase();
  const requests: PlanActionRequest[] = [];
  for (const type of ACTION_TYPE_ORDER) {
    if (type === "custom") continue;
    const keywords = ACTION_KEYWORDS[type];
    if (keywords.some((keyword) => lowered.includes(keyword))) {
      requests.push({ type });
    }
  }
  return requests;
}

/** Deduplicate requests by type, preserving first-occurrence order. */
function dedupeByType(requests: readonly PlanActionRequest[]): readonly PlanActionRequest[] {
  const seen = new Set<ActionType>();
  const result: PlanActionRequest[] = [];
  for (const request of requests) {
    if (seen.has(request.type)) continue;
    seen.add(request.type);
    result.push(request);
  }
  return result;
}

/**
 * Deterministically order planned actions: priority rank (descending), then
 * the canonical type order, then name (lexicographic). The input array is
 * never mutated.
 */
function orderActions(inputs: readonly CreateActionInput[]): readonly CreateActionInput[] {
  return [...inputs].sort((left, right) => {
    const priorityDelta =
      PRIORITY_RANK[right.priority ?? "normal"] - PRIORITY_RANK[left.priority ?? "normal"];
    if (priorityDelta !== 0) return priorityDelta;
    const typeDelta = typeIndex(left.type) - typeIndex(right.type);
    if (typeDelta !== 0) return typeDelta;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

/** The default human-readable name for an action type. */
export function defaultNameFor(type: ActionType): string {
  return type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Index of an action type in the canonical ordering. */
function typeIndex(type: ActionType): number {
  const index = ACTION_TYPE_ORDER.indexOf(type);
  return index === -1 ? ACTION_TYPE_ORDER.length : index;
}

/** Truncate a string to `max` characters. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Read a string field from an input record. */
function stringField(
  input: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a numeric field from an input record. */
function numberField(
  input: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = input?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The search types present in an intent (deduplicated, in canonical order). */
function dedupedSearchTypes(intent: PlanIntent): readonly ActionType[] {
  const types = new Set<ActionType>();
  for (const request of intent.requests ?? []) {
    if (SEARCH_TOOL_BY_TYPE[request.type] !== undefined) types.add(request.type);
  }
  if (types.size === 0) {
    for (const request of detectIntentRequests(intent.text)) {
      if (SEARCH_TOOL_BY_TYPE[request.type] !== undefined) types.add(request.type);
    }
  }
  return ACTION_TYPE_ORDER.filter((type) => types.has(type));
}
