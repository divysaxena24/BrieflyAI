/**
 * AI Actions — production composition point.
 *
 * The single place the application composes the AI Actions framework. The
 * pipeline is wired from the existing engines — nothing is reimplemented:
 *
 * ```text
 * Conversation Engine → Memory Engine → Digest Engine → Job Engine
 *   → Context Engine → Tool Executor (built-in read tools)
 *   → ActionPlanner → ActionManager → ActionExecutor (built-in handlers)
 *   → ActionEngine (composition root)
 * ```
 *
 * - `createProductionActionEngine()` is a pure factory: it only wires the
 *   dependency graph (optionally seeded with injected engines for dependency
 *   injection); no action is planned or executed during construction.
 * - `getProductionActionEngine()` returns the application's single engine
 *   instance (module-level singleton).
 * - `planActions()` / `executeActions()` / `runAction()` are the entry points
 *   the application uses to plan intents and execute actions.
 *
 * No LLM and no reasoning live here — the planner is a deterministic rule
 * engine and every built-in handler delegates to an existing production
 * engine through an injected closure.
 *
 * Stop conditions (documented, per architecture rules): no Gmail/Calendar/
 * Drive/GitHub *write* services exist (only read/search surfaces), so no
 * send/create actions are provided; action, memory, conversation, digest, and
 * job state are pure in-memory per process (no database/storage exists for
 * them anywhere in the codebase), so actions operate on in-process state.
 */

import type { Conversation, ConversationMessage } from "@/lib/conversation/types";
import { createProductionConversationEngine, ConversationEngine } from "@/lib/conversation/production";
import type { CreateMessageInput } from "@/lib/conversation/types";
import { getProductionContextEngine } from "@/lib/context/production";
import type { ContextEngine } from "@/lib/context/engine";
import { getProductionDigestEngine, DigestEngine } from "@/lib/digest/production";
import type { BuildDigestOptions } from "@/lib/digest/production";
import type { Digest, DigestTemplate } from "@/lib/digest/types";
import type { RunSummary } from "@/lib/jobs/runner";
import { getProductionJobEngine, JobEngine } from "@/lib/jobs/production";
import { createProductionMemoryEngine, MemoryEngine } from "@/lib/memory/production";
import type { CreateMemoryInput, Memory } from "@/lib/memory/types";
import type { ListEventsResult } from "@/lib/services/calendar/types";
import type { ListFilesResult } from "@/lib/services/drive/types";
import type { ListMessagesResult } from "@/lib/services/gmail/types";
import type { SearchRepositoriesResult } from "@/lib/services/github";
import { ToolExecutor } from "@/lib/tools/executor";
import { createBuiltInReadTools } from "@/lib/tools/builtin";
import { ToolRegistry } from "@/lib/tools/registry";
import type { ExecutionResult } from "@/lib/tools/executor";
import type { ExecutionPlan } from "@/lib/tools/plan";
import type { Tool } from "@/lib/tools/types";
import {
  ActionPlanner,
  createActionPlan,
  type ActionPlan,
  type PlanIntent,
} from "./planner";
import {
  ActionExecutor,
  ActionHandlerRegistry,
  type ActionExecutionResult,
  type ActionExecuteOptions,
  type ActionHandlerEntry,
  type ActionStepResult,
} from "./executor";
import { ActionManager } from "./manager";
import { createBuiltInActionHandlers } from "./builtin";
import type {
  CreateMemoryActionInput,
  GenerateDigestActionInput,
  RunJobActionInput,
  SearchCalendarActionInput,
  SearchDriveActionInput,
  SearchGitHubActionInput,
  SearchGmailActionInput,
  UpdateConversationActionInput,
} from "./builtin";
import type { Action, CreateActionInput } from "./types";

/** Options accepted by the {@link ActionEngine} constructor. */
export interface ActionEngineOptions {
  /** Initial action manager (dependency injection); empty by default. */
  readonly manager?: ActionManager;
  /** Planner (dependency injection); a plain `ActionPlanner` by default. */
  readonly planner?: ActionPlanner;
  /** Executor (dependency injection); built from the handler registry. */
  readonly executor?: ActionExecutor;
  /** Handler registry (dependency injection); built-ins added unless provided. */
  readonly handlerRegistry?: ActionHandlerRegistry;
  /** Memory Engine reused by `create_memory` (fresh empty by default). */
  readonly memoryEngine?: MemoryEngine;
  /** Conversation Engine reused by `update_conversation` (fresh by default). */
  readonly conversationEngine?: ConversationEngine;
  /** Context Engine reused by the planner/digest (production singleton). */
  readonly contextEngine?: ContextEngine;
  /** Digest Engine reused by `generate_digest` (production singleton). */
  readonly digestEngine?: DigestEngine;
  /** Job Engine reused by `run_job` (production singleton). */
  readonly jobEngine?: JobEngine;
  /** Tool executor reused by `execute_tool_plan` (built from `toolRegistry`). */
  readonly toolExecutor?: ToolExecutor;
  /** Tool registry backing the default tool executor (built-in read tools). */
  readonly toolRegistry?: ToolRegistry;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
}

/** Options accepted by {@link ActionEngine.executePlan}. */
export interface ExecutePlanOptions {
  /** Injected current time; defaults to the engine clock. */
  readonly now?: string;
  /** Injected user id forwarded to handlers. */
  readonly userId?: string;
  /** Whole-run cancellation signal. */
  readonly signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * The AI Actions engine — the application composition root.
 *
 * Owns the immutable `ActionManager` (exposed readonly), the planner, the
 * executor, and the engines the built-in handlers work through. `ActionEngine`
 * itself is stateful by design (it is the composition root): the manager and
 * the memory/conversation engines it holds are *replaced* via successor
 * construction on every transition — the underlying models/repositories/
 * managers remain immutable and deterministic.
 */
export class ActionEngine {
  private _manager: ActionManager;
  private _memoryEngine: MemoryEngine;
  private _conversationEngine: ConversationEngine;

  /** The planner (converts intents into action plans). */
  readonly planner: ActionPlanner;
  /** The executor (runs plans through the handler registry). */
  readonly executor: ActionExecutor;
  /** The Context Engine reused by the planner/digest (never replaced). */
  readonly contextEngine: ContextEngine;
  /** The Digest Engine reused by `generate_digest` (never replaced). */
  readonly digestEngine: DigestEngine;
  /** The Job Engine reused by `run_job` (never replaced). */
  readonly jobEngine: JobEngine;
  /** The Tool Executor reused by `execute_tool_plan` (never replaced). */
  readonly toolExecutor: ToolExecutor;

  private readonly now: () => string;

  constructor(options: ActionEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this._memoryEngine = options.memoryEngine ?? createProductionMemoryEngine();
    this._conversationEngine =
      options.conversationEngine ?? createProductionConversationEngine();
    this.contextEngine = options.contextEngine ?? getProductionContextEngine();
    this.digestEngine = options.digestEngine ?? getProductionDigestEngine();
    this.jobEngine = options.jobEngine ?? getProductionJobEngine();

    const toolRegistry =
      options.toolRegistry ?? new ToolRegistry(createBuiltInReadTools());
    this.toolExecutor = options.toolExecutor ?? new ToolExecutor(toolRegistry);

    if (options.executor !== undefined) {
      this.executor = options.executor;
    } else {
      const handlers = createBuiltInActionHandlers(this.builtinDependencies(toolRegistry));
      const registry = (options.handlerRegistry ?? new ActionHandlerRegistry()).registerMany(
        handlers,
      );
      this.executor = new ActionExecutor(registry, { now: options.now });
    }

    this.planner =
      options.planner ??
      new ActionPlanner({
        listConversations: () => this._conversationEngine.listConversations(),
        listMemories: () => this._memoryEngine.listMemories(),
        listDigests: () => this.digestEngine.manager.list(),
        listJobs: () => this.jobEngine.manager.list(),
      });
    this._manager = options.manager ?? new ActionManager();
  }

  /** The current action manager (readonly view; never replaced in place). */
  get manager(): ActionManager {
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

  /** Number of stored actions. */
  count(): number {
    return this._manager.count();
  }

  /** Detached clones of every stored action, in insertion order. */
  listActions(): Action[] {
    return this._manager.list();
  }

  /** The stored action with the given id, or `undefined`. */
  findAction(id: string): Action | undefined {
    return this._manager.find(id);
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

  /**
   * Plan an intent into an immutable `ActionPlan` through the planner.
   * Pure — nothing is stored or executed.
   */
  plan(intent: PlanIntent): ActionPlan {
    return this.planner.plan(intent);
  }

  /**
   * Execute a planned `ActionPlan`: store its actions through the successor
   * manager, run them through the executor, and commit every state
   * transition (execute → complete/fail/cancel) back to the manager.
   * Returns the structured execution result; the receiver engine is updated
   * to the successor manager in place.
   */
  async executePlan(
    plan: ActionPlan,
    options: ExecutePlanOptions = {},
  ): Promise<{ result: ActionExecutionResult }> {
    const now = options.now ?? this.now();
    const result = await this.runActions(plan.actions, {
      now,
      userId: options.userId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      intent: plan.intent,
      conversationId: plan.conversationId,
      planId: plan.id,
    });
    return { result };
  }

  /**
   * Execute a list of actions directly (no plan object required): the
   * actions are validated into an inline plan (ids derived deterministically
   * from the actions), stored, executed, and committed. Returns the
   * structured execution result.
   *
   * Documented throw paths (the executor itself never throws):
   * - `createActionPlan` throws for actions with unknown/self/cyclic
   *   `dependsOn` references.
   * - `ActionDuplicateError` is thrown when an action id is already stored
   *   (e.g. re-executing the same actions against an accumulating engine —
   *   deterministic ids collide).
   */
  async executeActions(
    actions: readonly Action[],
    options: ExecutePlanOptions & { readonly intent?: string } = {},
  ): Promise<{ result: ActionExecutionResult }> {
    const now = options.now ?? this.now();
    const plan = createActionPlan({
      intent: options.intent ?? "manual",
      userId: options.userId ?? "",
      now,
      actions,
    });
    const result = await this.runActions(plan.actions, {
      now,
      userId: options.userId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      intent: plan.intent,
      planId: plan.id,
    });
    return { result };
  }

  /**
   * Execute a single action: store it, run it through the executor, and
   * commit the transition. Returns the single action's structured result.
   */
  async runAction(
    action: Action,
    options: ExecutePlanOptions = {},
  ): Promise<{ result: ActionStepResult }> {
    const now = options.now ?? this.now();
    const { result } = await this.executeActions([action], {
      ...options,
      now,
      intent: "manual",
    });
    const step = result.results[0];
    if (step === undefined) {
      throw new Error("runAction produced no result for the single action");
    }
    return { result: step };
  }

  /**
   * Store `actions`, execute them through the executor, and commit every
   * state transition to the successor manager.
   */
  private async runActions(
    actions: readonly Action[],
    options: {
      now: string;
      userId?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      intent: string;
      conversationId?: string;
      planId: string;
    },
  ): Promise<ActionExecutionResult> {
    // 1. Store every action through the successor manager (no-op-safe: a
    //    duplicate id throws, mirroring the repository contract).
    let repository = this._manager.repository;
    for (const action of actions) {
      const added = repository.add(action);
      repository = added.repository;
    }
    this._manager = new ActionManager(repository);

    // 2. Execute through the executor (never throws).
    const plan = createActionPlan({
      id: options.planId,
      intent: options.intent,
      userId: options.userId ?? "",
      now: options.now,
      ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
      actions,
    });
    const execution = await this.executor.executePlan(plan, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      now: options.now,
      ...(options.userId !== undefined ? { userId: options.userId } : {}),
    });

    // 3. Commit every transition to the successor manager.
    //
    // Steps that actually ran (`attemptsMade > 0`) go through the full
    // execute → settle lifecycle. Steps that never ran (`attemptsMade === 0`
    // — dependency failures and pre-execution cancellations) are settled
    // directly so their execution history is never falsified with a fake
    // start.
    for (const step of execution.results) {
      if (step.attemptsMade > 0) {
        const started = this._manager.executeAction(step.actionId, { at: options.now });
        this._manager = started.manager;
      }
      if (step.status === "completed") {
        const settled = this._manager.completeAction(step.actionId, {
          at: options.now,
          attempt: step.attempt,
          output: step.output,
          durationMs: step.durationMs,
        });
        this._manager = settled.manager;
      } else if (step.status === "failed") {
        const settled = this._manager.failAction(step.actionId, {
          at: options.now,
          attempt: step.attempt,
          error: step.error ?? { code: "unknown", message: "Action failed" },
          durationMs: step.durationMs,
        });
        this._manager = settled.manager;
      } else {
        const settled = this._manager.cancelAction(step.actionId, {
          at: options.now,
          attempt: step.attempt,
          error: step.error,
          durationMs: step.durationMs,
        });
        this._manager = settled.manager;
      }
    }

    return execution;
  }

  /** Build the built-in handler closures over this engine's engines. */
  private builtinDependencies(toolRegistry: ToolRegistry) {
    return {
      searchGmail: async (input: SearchGmailActionInput): Promise<ListMessagesResult> =>
        (await this.callTool(toolRegistry, "search.gmail", input)) as ListMessagesResult,
      searchCalendar: async (input: SearchCalendarActionInput): Promise<ListEventsResult> =>
        (await this.callTool(toolRegistry, "search.calendar", input)) as ListEventsResult,
      searchDrive: async (input: SearchDriveActionInput): Promise<ListFilesResult> =>
        (await this.callTool(toolRegistry, "search.drive", input)) as ListFilesResult,
      searchGitHub: async (input: SearchGitHubActionInput): Promise<SearchRepositoriesResult> =>
        (await this.callTool(toolRegistry, "search.github", input)) as SearchRepositoriesResult,
      storeMemory: (input: CreateMemoryInput): Memory => this.storeMemory(input),
      appendConversationMessage: (
        conversationId: string,
        input: CreateMessageInput,
      ): ConversationMessage => this.appendConversationMessage(conversationId, input),
      buildDigest: (template: DigestTemplate, opts: BuildDigestOptions): Promise<Digest> =>
        this.digestEngine.build(template, opts),
      runJob: (jobId: string, now?: string, signal?: AbortSignal): Promise<RunSummary> =>
        this.jobEngine.runManual(jobId, now, signal),
      executeTools: (plan: ExecutionPlan, timeoutMs?: number): Promise<ExecutionResult> =>
        this.toolExecutor.execute(plan, timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }

  /** Invoke a registered tool by id (throwing isolates into a failed action). */
  private async callTool(
    registry: ToolRegistry,
    toolId: string,
    input: unknown,
  ): Promise<unknown> {
    const tool: Tool | undefined = registry.get(toolId);
    if (tool === undefined) {
      throw new Error(`Tool "${toolId}" is not registered in the action engine`);
    }
    return tool.execute(input);
  }

  /**
   * Store a memory through the engine's memory engine (successor).
   *
   * Idempotent: storing a memory whose derived id already exists returns the
   * stored memory instead of throwing `MemoryDuplicateError`, so repeated
   * runs at an identical timestamp never fail the action.
   */
  private storeMemory(input: CreateMemoryInput): Memory {
    if (input.id !== undefined && this._memoryEngine.hasMemory(input.id)) {
      return this._memoryEngine.getMemory(input.id) as Memory;
    }
    const { engine, memory } = this._memoryEngine.remember(input);
    this._memoryEngine = engine;
    return memory;
  }

  /** Append a message through the engine's conversation engine (successor). */
  private appendConversationMessage(
    conversationId: string,
    input: CreateMessageInput,
  ): ConversationMessage {
    const { engine, message } = this._conversationEngine.appendMessage(conversationId, input);
    this._conversationEngine = engine;
    return message;
  }
}

/**
 * Build a fresh production action engine.
 *
 * Wires the planner, the executor (with the nine built-in handlers), and the
 * existing production engines (Context/Digest/Job singletons, fresh
 * Memory/Conversation engines, built-in read tools). Optional overrides seed
 * the graph for dependency injection. Pure — construction only; nothing is
 * planned or executed.
 */
export function createProductionActionEngine(options: ActionEngineOptions = {}): ActionEngine {
  return new ActionEngine(options);
}

/**
 * The application's single production action engine instance.
 * Created once at module load.
 */
const productionActionEngine = createProductionActionEngine();

/** Return the application's single production action engine instance. */
export function getProductionActionEngine(): ActionEngine {
  return productionActionEngine;
}

/**
 * Plan an intent through the production action engine.
 */
export function planActions(intent: PlanIntent): ActionPlan {
  return getProductionActionEngine().plan(intent);
}

/**
 * Execute a list of actions through the production action engine.
 */
export function executeActions(
  actions: readonly Action[],
  options: ExecutePlanOptions & { readonly intent?: string } = {},
): Promise<{ result: ActionExecutionResult }> {
  return getProductionActionEngine().executeActions(actions, options);
}

/**
 * Execute a single action through the production action engine.
 */
export function runAction(
  action: Action,
  options: ExecutePlanOptions = {},
): Promise<{ result: ActionStepResult }> {
  return getProductionActionEngine().runAction(action, options);
}

// Re-exported for convenience so callers can create actions without importing
// the model file directly.
export type {
  CreateMemoryActionInput,
  CreateActionInput,
  GenerateDigestActionInput,
  RunJobActionInput,
  SearchCalendarActionInput,
  SearchDriveActionInput,
  SearchGitHubActionInput,
  SearchGmailActionInput,
  UpdateConversationActionInput,
  Action,
  ActionExecuteOptions,
  ActionHandlerEntry,
  ActionExecutionResult,
  ActionStepResult,
  PlanIntent,
};
