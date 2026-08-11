/**
 * Background AI Jobs — production composition point.
 *
 * The single place the application composes the background jobs framework.
 * The pipeline is wired from the existing engines — nothing is reimplemented:
 *
 * ```text
 * JobManager → BackgroundScheduler → JobExecutor → JobRunner
 *   → BackgroundDigestHandler
 *       → ContextEngine (Gmail/Calendar/GitHub/Drive)
 *       → MemoryEngine (retrieve + store derived memories)
 *       → ConversationEngine (update conversation context)
 *       → ToolExecutor (bg.digest.gather → bg.memory.record plan)
 * ```
 *
 * - `createProductionJobEngine()` is a pure factory: it only wires the
 *   dependency graph (optionally seeded with injected engines for dependency
 *   injection); no job is executed during construction.
 * - `getProductionJobEngine()` returns the application's single engine
 *   instance (module-level singleton).
 * - `runBackgroundJobs()` is the entry point the application uses to run
 *   everything due (including the recurring digest job) through the engine.
 *
 * The digest job itself performs the hourly background pipeline
 * (check Gmail/Calendar/GitHub/Drive through the Context Engine, retrieve
 * memories, update conversation context, execute the tool plan, and store a
 * derived memory) — with **no LLM integration**: the digest is a structured,
 * deterministic summary of gathered signals.
 *
 * Stop conditions (documented, per architecture rules): memory and
 * conversation state are pure in-memory per process (no database/storage
 * exists for them anywhere in the codebase), so memories stored by the
 * digest job and conversation context updates live only for the process
 * lifetime; persistence, the LLM-backed digest, and the Workflow Engine are
 * deliberately excluded from this layer.
 */

import { z } from "zod";
import { ContextEngine } from "@/lib/context/engine";
import {
  PRODUCTION_SOURCE_IDS,
  getProductionContextEngine,
} from "@/lib/context/production";
import { MemoryEngine, createProductionMemoryEngine } from "@/lib/memory/production";
import type { CreateMemoryInput, Memory } from "@/lib/memory/types";
import {
  ConversationEngine,
  createProductionConversationEngine,
} from "@/lib/conversation/production";
import type { Conversation, CreateMessageInput } from "@/lib/conversation/types";
import { ToolExecutor } from "@/lib/tools/executor";
import { ToolRegistry } from "@/lib/tools/registry";
import { createExecutionPlan } from "@/lib/tools/plan";
import type { Tool } from "@/lib/tools/types";
import { JobExecutor, JobHandlerRegistry, type JobHandler } from "./executor";
import { JobManager } from "./manager";
import { JobRunner, type RunSummary } from "./runner";
import { hashString, type CreateJobInput, type Job } from "./types";

/** Id of the recurring background digest job registered by the engine. */
export const DIGEST_JOB_ID = "bg-daily-digest";

/** Human-readable name of the background digest job. */
export const DIGEST_JOB_NAME = "Background Daily Digest";

/** Recurrence interval of the digest job: one hour in milliseconds. */
export const DIGEST_SCHEDULE_INTERVAL_MS = 3_600_000;

/** User id the background pipeline gathers context for. */
export const DIGEST_USER_ID = "background";

/** Token budget forwarded to the Context Engine by the digest handler. */
export const DIGEST_TOKEN_BUDGET = 4000;

/** Timeout applied to the digest job's tool plan. */
export const DIGEST_TOOL_TIMEOUT_MS = 5000;

/** Id of the gather tool used by the digest plan. */
export const BG_GATHER_TOOL_ID = "bg.digest.gather";

/** Id of the memory record tool used by the digest plan. */
export const BG_RECORD_TOOL_ID = "bg.memory.record";

/**
 * The structured, deterministic digest produced by the background digest job.
 */
export interface BackgroundDigest {
  /** Stable digest id derived from userId + createdAt. */
  readonly id: string;
  readonly userId: string;
  /** ISO-8601 UTC timestamp of the digest. */
  readonly createdAt: string;
  /** Number of context sources consulted. */
  readonly sourceCount: number;
  /** Number of stored memories consulted. */
  readonly memoryCount: number;
  /** Character length of the assembled context prompt. */
  readonly contextPromptLength: number;
  /** Deterministic one-line summary (no LLM involved). */
  readonly summary: string;
}

/** Input accepted by {@link buildDigest}. */
export interface BuildDigestInput {
  readonly userId: string;
  /** ISO-8601 UTC timestamp of the digest. */
  readonly now: string;
  readonly sourceCount: number;
  readonly memoryCount: number;
  /** The context prompt assembled by the Context Engine. */
  readonly contextPrompt: string;
}

/**
 * Build a deterministic background digest from gathered signals.
 * Pure — no LLM, no side effects.
 */
export function buildDigest(input: BuildDigestInput): BackgroundDigest {
  const id = `digest-${hashString(`${input.userId}:${input.now}`)}`;
  const summary =
    `Background digest at ${input.now}: gathered ${input.sourceCount} context sources, ` +
    `consulted ${input.memoryCount} memories, assembled ` +
    `${input.contextPrompt.length} characters of context. No LLM invoked.`;
  return {
    id,
    userId: input.userId,
    createdAt: input.now,
    sourceCount: input.sourceCount,
    memoryCount: input.memoryCount,
    contextPromptLength: input.contextPrompt.length,
    summary,
  };
}

/**
 * Dependencies injected into the background digest handler (dependency
 * injection — the handler never constructs engines itself).
 */
export interface BackgroundDigestDependencies {
  /** The Context Engine used to gather Gmail/Calendar/GitHub/Drive context. */
  readonly contextEngine: ContextEngine;
  /** The Tool Executor used to run the digest tool plan. */
  readonly toolExecutor: ToolExecutor;
  /** Snapshot of the memory engine's stored memories. */
  readonly listMemories: () => readonly Memory[];
  /** Snapshot of the conversation engine's conversations. */
  readonly listConversations: () => readonly Conversation[];
  /** Append a system note to a conversation (updates the engine's state). */
  readonly appendConversationMessage: (
    conversationId: string,
    input: CreateMessageInput,
  ) => void;
}

/**
 * The background digest job handler.
 *
 * Pipeline (in this exact order):
 * 1. Gather context through the Context Engine (Gmail/Calendar/GitHub/Drive).
 * 2. Retrieve stored memories from the Memory Engine.
 * 3. Build the deterministic digest (`buildDigest`).
 * 4. Execute the tool plan through the Tool Executor
 *    (`bg.digest.gather` → `bg.memory.record`), which stores a derived
 *    memory via the injected store.
 * 5. Update conversation context by appending a system note to the most
 *    recent conversation, when one exists.
 *
 * The job is never mutated; every engine transition happens through the
 * injected closures.
 */
export function createBackgroundDigestHandler(
  deps: BackgroundDigestDependencies,
): JobHandler {
  return async (context): Promise<BackgroundDigest> => {
    const userId = DIGEST_USER_ID;
    const now = context.now;

    // 1. Gather context (Gmail, Calendar, GitHub, Drive) + 2. memories.
    const contextPrompt = await deps.contextEngine.buildPrompt({
      retrievalQuery: { userId, query: "background digest" },
      tokenBudget: DIGEST_TOKEN_BUDGET,
      userQuery: "background digest",
    });
    const memories = deps.listMemories();

    // 3. Build the deterministic digest.
    const digest = buildDigest({
      userId,
      now,
      sourceCount: PRODUCTION_SOURCE_IDS.length,
      memoryCount: memories.length,
      contextPrompt,
    });

    // 4. Execute the tool plan through the Tool Executor.
    const plan = createExecutionPlan({
      id: `bg-plan-${hashString(now)}`,
      steps: [
        {
          stepId: "gather",
          toolId: BG_GATHER_TOOL_ID,
          input: {
            sourceCount: digest.sourceCount,
            memoryCount: digest.memoryCount,
            contextPromptLength: digest.contextPromptLength,
          },
          dependsOn: [],
        },
        {
          stepId: "record",
          toolId: BG_RECORD_TOOL_ID,
          input: {
            memoryId: digest.id.replace(/^digest-/, "mem-digest-"),
            title: "Background digest",
            content: digest.summary,
            createdAt: now,
          },
          dependsOn: ["gather"],
        },
      ],
    });
    const execution = await deps.toolExecutor.execute(plan, {
      timeoutMs: DIGEST_TOOL_TIMEOUT_MS,
      signal: context.signal,
    });
    if (execution.failedStepIds.length > 0) {
      throw new Error(
        `Background digest tool plan failed: ${execution.failedStepIds.join(", ")}`,
      );
    }

    // 5. Update conversation context (most recent conversation, if any).
    const conversations = deps.listConversations();
    if (conversations.length > 0) {
      const latest = conversations[conversations.length - 1];
      deps.appendConversationMessage(latest.id, {
        role: "system",
        content: digest.summary,
        createdAt: now,
      });
    }

    return digest;
  };
}

/** Input accepted by the background gather tool. */
export type BackgroundGatherInput = z.infer<typeof gatherInputSchema>;

/** Input schema of the background gather tool. */
const gatherInputSchema = z.object({
  sourceCount: z.number().int().min(0),
  memoryCount: z.number().int().min(0),
  contextPromptLength: z.number().int().min(0),
});

/**
 * Gather tool: reports the digest's gathered signals. Pure transformation —
 * the plan's first step.
 */
export class BackgroundGatherTool implements Tool {
  readonly id = BG_GATHER_TOOL_ID;
  readonly description = "Gather background digest signals (sources, memories, context size).";
  readonly inputSchema = gatherInputSchema;

  async execute(input: BackgroundGatherInput): Promise<BackgroundGatherInput> {
    return {
      sourceCount: input.sourceCount,
      memoryCount: input.memoryCount,
      contextPromptLength: input.contextPromptLength,
    };
  }
}

/** Input accepted by the background record tool. */
export type BackgroundRecordInput = z.infer<typeof recordInputSchema>;

/** Input schema of the background record tool. */
const recordInputSchema = z.object({
  memoryId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  createdAt: z.string().min(1),
});

/**
 * Record tool: stores a derived memory through the injected store closure.
 * The plan's second step (depends on `gather`).
 */
export class BackgroundRecordTool implements Tool {
  readonly id = BG_RECORD_TOOL_ID;
  readonly description = "Store a derived memory produced by a background job.";
  readonly inputSchema = recordInputSchema;

  constructor(
    private readonly store: (input: CreateMemoryInput) => Memory = () => {
      throw new Error("No memory store wired to the background record tool");
    },
  ) {}

  async execute(input: BackgroundRecordInput): Promise<Memory> {
    return this.store({
      id: input.memoryId,
      title: input.title,
      content: input.content,
      createdAt: input.createdAt,
      kind: "context",
      source: "derived",
    });
  }
}

/** Options accepted by {@link createProductionJobTools}. */
export interface ProductionJobToolsOptions {
  /** Store closure backing the record tool (defaults to throwing). */
  readonly storeMemory?: (input: CreateMemoryInput) => Memory;
}

/**
 * Build the production background tool registry: the two digest tools.
 */
export function createProductionJobTools(
  options: ProductionJobToolsOptions = {},
): ToolRegistry {
  return new ToolRegistry([
    new BackgroundGatherTool(),
    new BackgroundRecordTool(options.storeMemory),
  ]);
}

/**
 * Build the recurring digest job's registration input at `now`. Deterministic
 * given `now` (the job id derives from name + trigger + priority + timestamps).
 */
export function createDigestJobInput(now: string): CreateJobInput {
  return {
    // Explicit stable id — the engine addresses the digest job by
    // `DIGEST_JOB_ID` across runs and engines.
    id: DIGEST_JOB_ID,
    name: DIGEST_JOB_NAME,
    priority: "normal",
    trigger: "recurring",
    schedule: { everyMs: DIGEST_SCHEDULE_INTERVAL_MS },
    maxAttempts: 2,
    createdAt: now,
    scheduledAt: now,
    metadata: { tags: ["background", "digest"], timeoutMs: DIGEST_TOOL_TIMEOUT_MS },
  };
}

/** Options accepted by the {@link JobEngine} constructor. */
export interface JobEngineOptions {
  /** Initial job manager (dependency injection); empty by default. */
  readonly manager?: JobManager;
  /** Job executor (dependency injection); built from the handler registry. */
  readonly executor?: JobExecutor;
  /** Handler registry (dependency injection); digest handler added unless provided. */
  readonly handlerRegistry?: JobHandlerRegistry;
  /** Memory engine reused by the digest handler (fresh empty by default). */
  readonly memoryEngine?: MemoryEngine;
  /** Conversation engine reused by the digest handler (fresh empty by default). */
  readonly conversationEngine?: ConversationEngine;
  /** Context Engine reused by the digest handler (production singleton by default). */
  readonly contextEngine?: ContextEngine;
  /** Tool executor reused by the digest handler (built from `toolRegistry`). */
  readonly toolExecutor?: ToolExecutor;
  /** Tool registry backing the default tool executor. */
  readonly toolRegistry?: ToolRegistry;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
  /** Register the recurring digest job at construction; defaults to true. */
  readonly seedDigestJob?: boolean;
}

/**
 * The background jobs engine — the application composition root.
 *
 * Owns the immutable `JobManager` (exposed readonly), the executor, and the
 * engines the digest handler works through. `JobEngine` itself is stateful by
 * design (it is the composition root): the manager, memory engine, and
 * conversation engine it holds are *replaced* via successor construction on
 * every transition — the underlying models/repositories/managers remain
 * immutable and deterministic.
 */
export class JobEngine {
  private _manager: JobManager;
  private _memoryEngine: MemoryEngine;
  private _conversationEngine: ConversationEngine;

  /** The Context Engine reused by the digest handler (never replaced). */
  readonly contextEngine: ContextEngine;
  /** The Tool Executor reused by the digest handler (never replaced). */
  readonly toolExecutor: ToolExecutor;
  /** The job executor (resolves handlers by job id). */
  readonly executor: JobExecutor;

  private readonly now: () => string;

  constructor(options: JobEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this._memoryEngine = options.memoryEngine ?? createProductionMemoryEngine();
    this._conversationEngine =
      options.conversationEngine ?? createProductionConversationEngine();
    this.contextEngine = options.contextEngine ?? getProductionContextEngine();

    const toolRegistry =
      options.toolRegistry ??
      createProductionJobTools({
        storeMemory: (input) => this.storeMemory(input),
      });
    this.toolExecutor = options.toolExecutor ?? new ToolExecutor(toolRegistry);

    const handlerRegistry = (
      options.handlerRegistry ?? new JobHandlerRegistry()
    ).register(
      DIGEST_JOB_ID,
      createBackgroundDigestHandler({
        contextEngine: this.contextEngine,
        toolExecutor: this.toolExecutor,
        listMemories: () => this._memoryEngine.listMemories(),
        listConversations: () => this._conversationEngine.listConversations(),
        appendConversationMessage: (conversationId, input) => {
          this._conversationEngine = this._conversationEngine
            .appendMessage(conversationId, input)
            .engine;
        },
      }),
    );
    this.executor =
      options.executor ?? new JobExecutor(handlerRegistry, { now: options.now });

    this._manager = options.manager ?? new JobManager();
    if (options.seedDigestJob ?? true) {
      this.seedDigestJob();
    }
  }

  /** The current job manager (readonly view; never replaced in place). */
  get manager(): JobManager {
    return this._manager;
  }

  /** The current memory engine state held by the engine. */
  get memoryEngine(): MemoryEngine {
    return this._memoryEngine;
  }

  /** The current conversation engine state held by the engine. */
  get conversationEngine(): ConversationEngine {
    return this._conversationEngine;
  }

  /** Number of registered jobs. */
  count(): number {
    return this._manager.count();
  }

  /** Number of memories currently stored by the engine's memory engine. */
  memoryCount(): number {
    return this._memoryEngine.count();
  }

  /** Detached clones of the memories stored by the engine's memory engine. */
  listStoredMemories(): Memory[] {
    return this._memoryEngine.listMemories();
  }

  /** Number of conversations currently held by the engine. */
  conversationCount(): number {
    return this._conversationEngine.count();
  }

  /** Detached clones of the conversations held by the engine. */
  listConversations(): Conversation[] {
    return this._conversationEngine.listConversations();
  }

  /** The registered digest job, or `undefined` before it is seeded. */
  digestJob(): Job | undefined {
    return this._manager.find(DIGEST_JOB_ID);
  }

  /**
   * Run everything due at `now` (default: the injected clock), ensuring the
   * recurring digest job is registered first. Returns the aggregated run
   * summary. Recurring jobs are re-armed into the future, so repeated calls
   * do not re-run completed work.
   */
  async run(options: { now?: string; signal?: AbortSignal } = {}): Promise<RunSummary> {
    const at = options.now ?? this.now();
    this.seedDigestJob();
    const runner = new JobRunner(this._manager, this.executor, { now: this.now });
    const { runner: next, summary } = await runner.run(at, options.signal);
    this._manager = next.manager;
    return summary;
  }

  /** Run exactly one pass over the jobs due at `now`. */
  async runOnce(now?: string, signal?: AbortSignal): Promise<RunSummary> {
    const runner = new JobRunner(this._manager, this.executor, { now: this.now });
    const { runner: next, summary } = await runner.runOnce(now, signal);
    this._manager = next.manager;
    return summary;
  }

  /** Run the due scheduled/recurring/startup/shutdown jobs at `now`. */
  async runScheduled(now?: string, signal?: AbortSignal): Promise<RunSummary> {
    const runner = new JobRunner(this._manager, this.executor, { now: this.now });
    const { runner: next, summary } = await runner.runScheduled(now, signal);
    this._manager = next.manager;
    return summary;
  }

  /** Run a manual job (or every pending manual job) at `now`. */
  async runManual(
    reference?: Parameters<JobRunner["runManual"]>[0],
    now?: string,
    signal?: AbortSignal,
  ): Promise<RunSummary> {
    const runner = new JobRunner(this._manager, this.executor, { now: this.now });
    const { runner: next, summary } = await runner.runManual(reference, now, signal);
    this._manager = next.manager;
    return summary;
  }

  /** Register the recurring digest job when absent (successor-safe). */
  private seedDigestJob(): void {
    if (this._manager.has(DIGEST_JOB_ID)) return;
    const registered = this._manager.registerJob(createDigestJobInput(this.now()));
    this._manager = registered.manager;
  }

  /**
   * Store a memory through the engine's memory engine (successor).
   *
   * Idempotent: storing a memory whose derived id already exists (e.g. the
   * digest handler running twice at the same injected time) returns the
   * stored memory instead of throwing `MemoryDuplicateError`, so repeated
   * runs at an identical timestamp never fail the digest job.
   */
  private storeMemory(input: CreateMemoryInput): Memory {
    if (input.id !== undefined && this._memoryEngine.hasMemory(input.id)) {
      return this._memoryEngine.getMemory(input.id) as Memory;
    }
    const { engine, memory } = this._memoryEngine.remember(input);
    this._memoryEngine = engine;
    return memory;
  }
}

/**
 * Build a fresh production job engine.
 *
 * Wires the digest handler and the recurring digest job over the existing
 * production engines (Context Engine singleton, fresh Memory/Conversation
 * engines) and the Tool Executor. Optional overrides seed the graph for
 * dependency injection; when omitted, the engine starts with the digest job
 * registered and nothing executed. Construction only — no job is executed.
 *
 * Note on determinism: when no `now` clock is injected, the seeded digest
 * job's timestamps come from the wall clock (the composition root is
 * stateful by design); inject a fixed `now` clock to make the factory fully
 * deterministic.
 */
export function createProductionJobEngine(options: JobEngineOptions = {}): JobEngine {
  return new JobEngine(options);
}

/**
 * The application's single production job engine instance.
 * Created once at module load.
 */
const productionJobEngine = createProductionJobEngine();

/** Return the application's single production job engine instance. */
export function getProductionJobEngine(): JobEngine {
  return productionJobEngine;
}

/** Options accepted by {@link runBackgroundJobs}. */
export interface RunBackgroundJobsOptions {
  /** Injected current time (deterministic); defaults to the engine clock. */
  readonly now?: string;
}

/**
 * Run everything due through the production job engine (the application's
 * background-jobs entry point). Returns the aggregated run summary.
 */
export function runBackgroundJobs(
  options: RunBackgroundJobsOptions = {},
): Promise<RunSummary> {
  return getProductionJobEngine().run({ now: options.now });
}
