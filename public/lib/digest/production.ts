/**
 * Daily AI Digest — production composition point.
 *
 * The single place the application composes the digest framework. The
 * pipeline is wired from the existing engines — nothing is reimplemented:
 *
 * ```text
 * DigestDataSources
 *   → Context Engine (production singleton)
 *   → Memory Engine  (production singleton)
 *   → Conversation Engine (production singleton)
 *   → Job Engine     (production singleton)
 *   → Tool Executor  (built-in read tools)
 *   → DigestBuilder  → DigestTemplates → DigestEngine → DigestManager
 * ```
 *
 * - `createProductionDigestEngine()` is a pure factory: it only wires the
 *   dependency graph (optionally seeded with injected engines for dependency
 *   injection); no digest is built during construction.
 * - `getProductionDigestEngine()` returns the application's single engine
 *   instance (module-level singleton).
 * - `buildMorningDigest()` / `buildEveningDigest()` / `buildWeeklyDigest()`
 *   are the entry points the application uses to produce a digest.
 *
 * No LLM and no AI summarization live here: digests are deterministic
 * aggregations of gathered signals (see `lib/digest/builder.ts`).
 *
 * Boundary with the Background Jobs layer (Phase 5F): `lib/jobs/production.ts`
 * owns the *hourly background digest job* (`bg-daily-digest`) and its minimal
 * structured `BackgroundDigest` summary, executed by the Job Runner. This
 * layer (`lib/digest`) owns the *structured daily digest framework* (sections,
 * items, templates, delivery) and is built on demand through the
 * `DigestEngine`. The two share data sources (Context/Memory/Conversation/Job
 * engines + built-in search tools) but are not wired to each other: the
 * background job still produces its one-line summary, and this layer is not
 * invoked from the job handler. Wiring the `DigestEngine` into the background
 * digest handler is the natural Phase 5H integration point.
 *
 * Stop conditions (documented, per architecture rules): memory, conversation,
 * and job state are pure in-memory per process (no database/storage exists
 * for them anywhere in the codebase), so digests aggregate in-process state;
 * real delivery channels (Gmail/Discord/Slack/notifications) are not
 * implemented — the delivery layer only formats and dispatches through an
 * injected publisher.
 */

import { ToolExecutor } from "@/lib/tools/executor";
import { ToolRegistry } from "@/lib/tools/registry";
import { createBuiltInReadTools } from "@/lib/tools/builtin";
import { getProductionContextEngine } from "@/lib/context/production";
import { getProductionMemoryEngine } from "@/lib/memory/production";
import { getProductionConversationEngine } from "@/lib/conversation/production";
import { getProductionJobEngine } from "@/lib/jobs/production";
import { DigestBuilder, type DigestDataSources } from "./builder";
import { DigestDeliveryEngine, type DigestPublisher } from "./delivery";
import { DigestManager } from "./manager";
import {
  EVENING_TEMPLATE,
  MORNING_TEMPLATE,
  WEEKLY_TEMPLATE,
} from "./templates";
import type { Digest, DigestTemplate } from "./types";

/** Token budget forwarded to the Context Engine when gathering. */
export const DIGEST_CONTEXT_TOKEN_BUDGET = 4000;

/** Timeout applied to the digest tool plan. */
export const DIGEST_TOOL_TIMEOUT_MS = 5000;

/** Options accepted by {@link DigestEngine.build}. */
export interface BuildDigestOptions {
  /** Application-level user id the digest is built for. */
  readonly userId: string;
  /** ISO-8601 UTC timestamp of the digest; defaults to the engine clock. */
  readonly now?: string;
  /** Free-text query; defaults per template kind. */
  readonly query?: string;
}

/**
 * Build the production digest data sources over the production singletons
 * and the built-in read tools. The Context/Memory/Conversation engines are
 * reused as-is; the Job Engine's registered jobs feed the "Pending Actions"
 * section; the Tool Executor runs the built-in search tools.
 */
export function createProductionDigestSources(): DigestDataSources {
  const toolExecutor = new ToolExecutor(new ToolRegistry(createBuiltInReadTools()));
  return {
    listMemories: () => getProductionMemoryEngine().listMemories(),
    listConversations: () => getProductionConversationEngine().listConversations(),
    buildContextPrompt: (query, userId) =>
      getProductionContextEngine().buildPrompt({
        retrievalQuery: { userId, query },
        tokenBudget: DIGEST_CONTEXT_TOKEN_BUDGET,
        userQuery: query,
      }),
    listJobs: () => getProductionJobEngine().manager.list(),
    executeTools: (plan) => toolExecutor.execute(plan, { timeoutMs: DIGEST_TOOL_TIMEOUT_MS }),
  };
}

/** Options accepted by the {@link DigestEngine} constructor. */
export interface DigestEngineOptions {
  /** Initial digest manager (dependency injection); empty by default. */
  readonly manager?: DigestManager;
  /** Data sources (dependency injection); production sources by default. */
  readonly sources?: DigestDataSources;
  /** Delivery engine (dependency injection); built from `publisher`. */
  readonly deliveryEngine?: DigestDeliveryEngine;
  /** Publisher backing the default delivery engine. */
  readonly publisher?: DigestPublisher;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
}

/**
 * The digest engine — the application composition root.
 *
 * Owns the immutable `DigestManager` (exposed readonly) and the builder,
 * delivery engine, and templates. `DigestEngine` itself is stateful by design
 * (it is the composition root): the manager it holds is *replaced* via
 * successor construction on every build — the underlying models/repositories/
 * managers remain immutable and deterministic.
 */
export class DigestEngine {
  private _manager: DigestManager;
  private _deliveryEngine: DigestDeliveryEngine;

  /** The digest builder (reads the injected data sources). */
  readonly builder: DigestBuilder;

  private readonly now: () => string;
  private readonly publisher?: DigestPublisher;
  private readonly injectedDeliveryEngine: boolean;

  constructor(options: DigestEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    const sources = options.sources ?? createProductionDigestSources();
    this.builder = new DigestBuilder(sources);
    this._manager = options.manager ?? new DigestManager();
    this.publisher = options.publisher;
    this.injectedDeliveryEngine = options.deliveryEngine !== undefined;
    this._deliveryEngine =
      options.deliveryEngine ??
      new DigestDeliveryEngine(this._manager, {
        now: options.now,
        publisher: options.publisher,
      });
  }

  /** The current digest manager (readonly view; never replaced in place). */
  get manager(): DigestManager {
    return this._manager;
  }

  /**
   * The delivery engine (format + dispatch abstraction).
   *
   * Note: when the engine was constructed without an injected delivery
   * engine, this getter returns a NEW instance after every {@link build} —
   * the delivery engine tracks the engine's current manager so delivering a
   * freshly built digest records on the manager that holds it. Re-read this
   * getter after building (do not cache the instance across builds).
   */
  get deliveryEngine(): DigestDeliveryEngine {
    return this._deliveryEngine;
  }

  /** Number of stored digests. */
  count(): number {
    return this._manager.count();
  }

  /** Detached clones of every stored digest, in insertion order. */
  listDigests(): Digest[] {
    return this._manager.list();
  }

  /** The stored digest with the given id, or `undefined`. */
  findDigest(id: string): Digest | undefined {
    return this._manager.find(id);
  }

  /**
   * Build a digest from `template` at `now` (default: the injected clock),
   * store it (draft) through the successor manager, and return it. The
   * receiver engine is never mutated.
   */
  async build(
    template: DigestTemplate,
    options: BuildDigestOptions,
  ): Promise<Digest> {
    const now = options.now ?? this.now();
    const digest = await this.builder.build({
      template,
      userId: options.userId,
      now,
      query: options.query,
    });
    // The builder returns a fully-formed digest (metadata + sections +
    // derived statistics); store it as-is through the immutable repository
    // (successor pattern) rather than rebuilding it from an input object.
    const { digest: stored, repository } = this._manager.repository.add(digest);
    this._manager = new DigestManager(repository);
    // Keep the self-built delivery engine in sync with the current manager so
    // delivering a freshly built digest records on the manager that holds it.
    // An injected delivery engine stays untouched (caller-owned).
    if (!this.injectedDeliveryEngine) {
      this._deliveryEngine = new DigestDeliveryEngine(this._manager, {
        now: this.now,
        publisher: this.publisher,
      });
    }
    return stored;
  }

  /** Build and store a morning digest. */
  buildMorningDigest(options: BuildDigestOptions): Promise<Digest> {
    return this.build(MORNING_TEMPLATE, options);
  }

  /** Build and store an evening digest. */
  buildEveningDigest(options: BuildDigestOptions): Promise<Digest> {
    return this.build(EVENING_TEMPLATE, options);
  }

  /** Build and store a weekly digest. */
  buildWeeklyDigest(options: BuildDigestOptions): Promise<Digest> {
    return this.build(WEEKLY_TEMPLATE, options);
  }
}

/**
 * Build a fresh production digest engine.
 *
 * Wires the production data sources (Context/Memory/Conversation/Job Engine
 * singletons + built-in tool executor) into a `DigestBuilder`, the delivery
 * engine, and an empty `DigestManager`. Optional overrides seed the graph for
 * dependency injection. Pure — construction only; no digest is built.
 */
export function createProductionDigestEngine(options: DigestEngineOptions = {}): DigestEngine {
  return new DigestEngine(options);
}

/**
 * The application's single production digest engine instance.
 * Created once at module load.
 */
const productionDigestEngine = createProductionDigestEngine();

/** Return the application's single production digest engine instance. */
export function getProductionDigestEngine(): DigestEngine {
  return productionDigestEngine;
}

/**
 * Build a morning digest through the production engine.
 */
export function buildMorningDigest(options: BuildDigestOptions): Promise<Digest> {
  return getProductionDigestEngine().buildMorningDigest(options);
}

/**
 * Build an evening digest through the production engine.
 */
export function buildEveningDigest(options: BuildDigestOptions): Promise<Digest> {
  return getProductionDigestEngine().buildEveningDigest(options);
}

/**
 * Build a weekly digest through the production engine.
 */
export function buildWeeklyDigest(options: BuildDigestOptions): Promise<Digest> {
  return getProductionDigestEngine().buildWeeklyDigest(options);
}
