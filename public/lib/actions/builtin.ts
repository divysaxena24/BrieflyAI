/**
 * AI Actions — built-in action handlers.
 *
 * The production action adapters. Each handler reuses an existing production
 * capability through an injected closure — nothing is reimplemented and no
 * service is invented:
 *
 * - `search_gmail`        → built-in read tool (`search.gmail`)
 * - `search_calendar`     → built-in read tool (`search.calendar`)
 * - `search_drive`        → built-in read tool (`search.drive`)
 * - `search_github`       → built-in read tool (`search.github`)
 * - `create_memory`       → Memory Engine (`remember`)
 * - `update_conversation` → Conversation Engine (`appendMessage`)
 * - `generate_digest`     → Digest Engine (`build` over the templates)
 * - `run_job`             → Job Engine (`runManual`)
 * - `execute_tool_plan`   → Tool Executor (`execute`)
 *
 * Every handler validates its input with a Zod schema (mirroring the tool
 * layer) and returns the structured production output. A throwing handler is
 * isolated by the executor into a structured `failed` result — handlers never
 * need to catch.
 *
 * Stop conditions (documented, per architecture rules): no Gmail/Calendar/
 * Drive/GitHub *write* services exist (only read/search surfaces), so no
 * send/create actions are provided; the `custom` type is intentionally left
 * without a built-in handler — it fails structurally (`unknown_action`)
 * unless the application registers its own.
 */

import { z } from "zod";
import type { ConversationMessage, CreateMessageInput } from "@/lib/conversation/types";
import type { Digest, DigestTemplate } from "@/lib/digest/types";
import type { BuildDigestOptions } from "@/lib/digest/production";
import { TEMPLATES_BY_KIND } from "@/lib/digest/templates";
import type { RunSummary } from "@/lib/jobs/runner";
import type { CreateMemoryInput, Memory } from "@/lib/memory/types";
import type { ListEventsResult } from "@/lib/services/calendar/types";
import type { ListFilesResult } from "@/lib/services/drive/types";
import type { ListMessagesResult } from "@/lib/services/gmail/types";
import type { SearchRepositoriesResult } from "@/lib/services/github";
import type { ExecutionResult } from "@/lib/tools/executor";
import type { ExecutionPlan } from "@/lib/tools/plan";
import { createExecutionPlan } from "@/lib/tools/plan";
import type { ActionHandlerEntry } from "./executor";
import type { ActionContext } from "./types";

/** Input accepted by the search actions. */
const searchInputSchema = z.object({
  /** Free-text search query. */
  query: z.string().min(1),
  /** Optional maximum number of results. */
  maxResults: z.number().int().positive().optional(),
});

/** Input accepted by {@link createCreateMemoryHandler}. */
const createMemoryInputSchema = z.object({
  /** Short human-readable title (defaults to the content preview). */
  title: z.string().min(1).optional(),
  content: z.string().min(1),
  kind: z
    .enum(["fact", "preference", "task", "knowledge", "conversation", "context"])
    .optional(),
  importance: z.enum(["low", "normal", "high", "critical"]).optional(),
  tier: z.enum(["short-term", "long-term"]).optional(),
  tags: z.array(z.string()).optional(),
});

/** Input accepted by {@link createUpdateConversationHandler}. */
const updateConversationInputSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]).optional(),
});

/** Input accepted by {@link createGenerateDigestHandler}. */
const generateDigestInputSchema = z.object({
  /** Digest kind; defaults to `morning`. */
  kind: z.enum(["morning", "evening", "weekly"]).optional(),
  /** Free-text query forwarded to the digest builder. */
  query: z.string().optional(),
});

/** Input accepted by {@link createRunJobHandler}. */
const runJobInputSchema = z.object({
  /** Id of the job to run manually. */
  jobId: z.string().min(1),
  /** Injected run time; defaults to the execution time. */
  now: z.string().min(1).optional(),
});

/** Input accepted by {@link createExecuteToolPlanHandler}. */
const executeToolPlanInputSchema = z.object({
  /** The execution plan to run through the Tool Executor. */
  plan: z.object({
    id: z.string().min(1),
    steps: z.array(
      z.object({
        stepId: z.string().min(1),
        toolId: z.string().min(1),
        input: z.record(z.string(), z.unknown()),
        dependsOn: z.array(z.string()).default([]),
      }),
    ),
  }),
});

/** Input accepted by {@link createSearchGmailHandler}. */
export type SearchGmailActionInput = z.infer<typeof searchInputSchema>;
/** Input accepted by {@link createSearchCalendarHandler}. */
export type SearchCalendarActionInput = z.infer<typeof searchInputSchema>;
/** Input accepted by {@link createSearchDriveHandler}. */
export type SearchDriveActionInput = z.infer<typeof searchInputSchema>;
/** Input accepted by {@link createSearchGitHubHandler}. */
export type SearchGitHubActionInput = z.infer<typeof searchInputSchema>;
/** Input accepted by {@link createCreateMemoryHandler}. */
export type CreateMemoryActionInput = z.infer<typeof createMemoryInputSchema>;
/** Input accepted by {@link createUpdateConversationHandler}. */
export type UpdateConversationActionInput = z.infer<typeof updateConversationInputSchema>;
/** Input accepted by {@link createGenerateDigestHandler}. */
export type GenerateDigestActionInput = z.infer<typeof generateDigestInputSchema>;
/** Input accepted by {@link createRunJobHandler}. */
export type RunJobActionInput = z.infer<typeof runJobInputSchema>;
/** Input accepted by {@link createExecuteToolPlanHandler}. */
export type ExecuteToolPlanActionInput = z.infer<typeof executeToolPlanInputSchema>;

/**
 * Dependencies injected into the built-in action handlers (dependency
 * injection — the handlers never construct or reach for engines themselves).
 */
export interface BuiltinActionDependencies {
  /** Search Gmail through the built-in read tool. */
  readonly searchGmail: (input: SearchGmailActionInput) => Promise<ListMessagesResult>;
  /** Search Calendar through the built-in read tool. */
  readonly searchCalendar: (input: SearchCalendarActionInput) => Promise<ListEventsResult>;
  /** Search Drive through the built-in read tool. */
  readonly searchDrive: (input: SearchDriveActionInput) => Promise<ListFilesResult>;
  /** Search GitHub through the built-in read tool. */
  readonly searchGitHub: (input: SearchGitHubActionInput) => Promise<SearchRepositoriesResult>;
  /** Store a memory through the Memory Engine. */
  readonly storeMemory: (input: CreateMemoryInput) => Memory;
  /** Append a message through the Conversation Engine. */
  readonly appendConversationMessage: (
    conversationId: string,
    input: CreateMessageInput,
  ) => ConversationMessage;
  /** Build a digest through the Digest Engine. */
  readonly buildDigest: (template: DigestTemplate, options: BuildDigestOptions) => Promise<Digest>;
  /** Run a job manually through the Job Engine. */
  readonly runJob: (jobId: string, now?: string, signal?: AbortSignal) => Promise<RunSummary>;
  /** Execute a tool plan through the Tool Executor. */
  readonly executeTools: (plan: ExecutionPlan, timeoutMs?: number) => Promise<ExecutionResult>;
}

/**
 * Build the nine built-in action handler entries over injected dependencies.
 * Deterministic — each entry is a fixed (type, handler) pair.
 */
export function createBuiltInActionHandlers(
  deps: BuiltinActionDependencies,
): readonly ActionHandlerEntry[] {
  return [
    { type: "search_gmail", handler: createSearchGmailHandler(deps) },
    { type: "search_calendar", handler: createSearchCalendarHandler(deps) },
    { type: "search_drive", handler: createSearchDriveHandler(deps) },
    { type: "search_github", handler: createSearchGitHubHandler(deps) },
    { type: "create_memory", handler: createCreateMemoryHandler(deps) },
    { type: "update_conversation", handler: createUpdateConversationHandler(deps) },
    { type: "generate_digest", handler: createGenerateDigestHandler(deps) },
    { type: "run_job", handler: createRunJobHandler(deps) },
    { type: "execute_tool_plan", handler: createExecuteToolPlanHandler(deps) },
  ];
}

/** The `search_gmail` handler: delegate to the Gmail read tool. */
export function createSearchGmailHandler(
  deps: BuiltinActionDependencies,
): (context: ActionContext) => Promise<ListMessagesResult> {
  return async (context): Promise<ListMessagesResult> => {
    const input = searchInputSchema.parse(context.action.input);
    return deps.searchGmail(input);
  };
}

/** The `search_calendar` handler: delegate to the Calendar read tool. */
export function createSearchCalendarHandler(
  deps: BuiltinActionDependencies,
): (context: ActionContext) => Promise<ListEventsResult> {
  return async (context): Promise<ListEventsResult> => {
    const input = searchInputSchema.parse(context.action.input);
    return deps.searchCalendar(input);
  };
}

/** The `search_drive` handler: delegate to the Drive read tool. */
export function createSearchDriveHandler(
  deps: BuiltinActionDependencies,
): (context: ActionContext) => Promise<ListFilesResult> {
  return async (context): Promise<ListFilesResult> => {
    const input = searchInputSchema.parse(context.action.input);
    return deps.searchDrive(input);
  };
}

/** The `search_github` handler: delegate to the GitHub read tool. */
export function createSearchGitHubHandler(
  deps: BuiltinActionDependencies,
): (context: ActionContext) => Promise<SearchRepositoriesResult> {
  return async (context): Promise<SearchRepositoriesResult> => {
    const input = searchInputSchema.parse(context.action.input);
    return deps.searchGitHub(input);
  };
}

/** The `create_memory` handler: store a memory through the Memory Engine. */
export function createCreateMemoryHandler(
  deps: BuiltinActionDependencies,
): (context: ActionContext) => Promise<Memory> {
  return async (context): Promise<Memory> => {
    const input = createMemoryInputSchema.parse(context.action.input);
    const title = input.title ?? truncate(input.content, 40);
    return deps.storeMemory({
      title,
      content: input.content,
      createdAt: context.now,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      source: "tool",
    });
  };
}

/** The `update_conversation` handler: append a message to a conversation. */
export function createUpdateConversationHandler(
  deps: BuiltinActionDependencies,
): (context: ActionContext) => Promise<ConversationMessage> {
  return async (context): Promise<ConversationMessage> => {
    const input = updateConversationInputSchema.parse(context.action.input);
    return deps.appendConversationMessage(input.conversationId, {
      role: input.role ?? "system",
      content: input.content,
      createdAt: context.now,
    });
  };
}

/** The `generate_digest` handler: build a digest through the Digest Engine. */
export function createGenerateDigestHandler(
  deps: BuiltinActionDependencies,
): (context: ActionContext) => Promise<Digest> {
  return async (context): Promise<Digest> => {
    const input = generateDigestInputSchema.parse(context.action.input);
    const kind = input.kind ?? "morning";
    const template = TEMPLATES_BY_KIND[kind];
    return deps.buildDigest(template, {
      userId: context.userId ?? "background",
      now: context.now,
      ...(input.query !== undefined ? { query: input.query } : {}),
    });
  };
}

/** The `run_job` handler: run a job manually through the Job Engine. */
export function createRunJobHandler(
  deps: BuiltinActionDependencies,
): (context: ActionContext) => Promise<RunSummary> {
  return async (context): Promise<RunSummary> => {
    const input = runJobInputSchema.parse(context.action.input);
    return deps.runJob(input.jobId, input.now ?? context.now, context.signal);
  };
}

/** The `execute_tool_plan` handler: run a tool plan through the Tool Executor. */
export function createExecuteToolPlanHandler(
  deps: BuiltinActionDependencies,
): (context: ActionContext) => Promise<ExecutionResult> {
  return async (context): Promise<ExecutionResult> => {
    const input = executeToolPlanInputSchema.parse(context.action.input);
    const plan = createExecutionPlan({
      id: input.plan.id,
      steps: input.plan.steps,
    });
    const timeoutMs =
      typeof context.action.metadata.timeoutMs === "number"
        ? context.action.metadata.timeoutMs
        : undefined;
    return deps.executeTools(plan, timeoutMs);
  };
}

/** Truncate a string to `max` characters. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
