/**
 * Observability & Monitoring — logging infrastructure (Phase 6C STEP 2).
 *
 * A successor-based, immutable structured logger:
 *
 * - Every `LogEntry` is deep-frozen and never mutated.
 * - Logging returns a successor `Logger` carrying the new entry — the
 *   receiver is never changed.
 * - Child loggers (`child(scope)`) derive a nested scope while sharing the
 *   parent's correlation chain.
 * - Correlation ids, request ids and every engine id are optional, caller
 *   supplied and carried on the entry.
 * - Filtering, summaries, statistics and snapshots are pure projections.
 * - JSON serialization is deterministic (stable key order).
 *
 * This module never writes to the console — it only records structured,
 * immutable entries.
 */

import { hashString } from "@/lib/hash";

/** Structured severity of a log entry, lowest to highest. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Every log level in stable ascending order. */
export const LOG_LEVELS: readonly LogLevel[] = Object.freeze([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

/** Numeric ordering used for level filtering (higher = more severe). */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
});

/**
 * Correlation identifiers threaded through a log lineage. Every field is
 * optional so a root logger can be created without any ids; child loggers
 * inherit and may extend them.
 */
export interface LogCorrelation {
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly workflowId?: string;
  readonly workerId?: string;
  readonly actionId?: string;
  readonly toolId?: string;
  readonly conversationId?: string;
  readonly memoryId?: string;
  readonly jobId?: string;
  readonly digestId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

/** A named logging scope (service/component) with optional correlation. */
export interface LogScope {
  /** Component/service name, e.g. "workers", "digest", "api". */
  readonly name: string;
  /** Optional nested scope label (e.g. "worker-<id>"). */
  readonly label?: string;
  /** Correlation id fixed for this scope. */
  readonly correlationId?: string;
}

/** Free-form structured context attached to an entry. */
export type LogContext = Readonly<Record<string, unknown>>;

/** Small immutable metadata block (tags) on every entry. */
export interface LogMetadata {
  readonly tags: readonly string[];
}

/** Input accepted by {@link createLogEntry}. */
export interface CreateLogEntryInput {
  readonly level: LogLevel;
  readonly message: string;
  readonly scope: LogScope;
  /** Timestamp (ISO-8601 UTC), caller supplied. */
  readonly timestamp: string;
  readonly correlation?: LogCorrelation;
  readonly context?: LogContext;
  readonly metadata?: Partial<LogMetadata>;
}

/** An immutable structured log entry. */
export interface LogEntry {
  /** Stable entry id: `log-<hash(level:scope:message:timestamp)>`. */
  readonly id: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly scope: LogScope;
  readonly timestamp: string;
  readonly correlation: LogCorrelation;
  readonly context: LogContext;
  readonly metadata: LogMetadata;
}

/** Lightweight projection of an entry for lists/overviews. */
export interface LogReference {
  readonly id: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
}

/** Per-level counts over a set of entries. */
export interface LogStatistics {
  readonly total: number;
  readonly byLevel: Readonly<Record<LogLevel, number>>;
}

/** Compact summary of a set of entries. */
export interface LogSummary {
  readonly count: number;
  readonly firstAt?: string;
  readonly lastAt?: string;
  readonly levels: readonly LogLevel[];
}

/** Point-in-time snapshot of a logger. */
export interface LogSnapshot {
  readonly at: string;
  readonly entries: readonly LogEntry[];
  readonly statistics: LogStatistics;
  readonly summary: LogSummary;
}

/** Options accepted by the {@link Logger} constructor / factory. */
export interface LoggerOptions {
  /** Existing entries (deep-copied); empty by default. */
  readonly entries?: readonly LogEntry[];
  /** The logger's default scope; `{ name: "app" }` by default. */
  readonly scope?: LogScope;
  /** The logger's default correlation chain. */
  readonly correlation?: LogCorrelation;
  /** Entries below this level are dropped on insertion. */
  readonly minimumLevel?: LogLevel;
  /** Maximum retained entries (oldest dropped); unbounded when undefined. */
  readonly maxEntries?: number;
}

/** Deterministic id for a log entry. */
export function logEntryIdFor(input: {
  readonly level: LogLevel;
  readonly scope: LogScope;
  readonly message: string;
  readonly timestamp: string;
}): string {
  return `log-${hashString(
    `${input.level}:${input.scope.name}:${input.scope.label ?? ""}:${input.message}:${input.timestamp}`,
  )}`;
}

/** Build a new immutable log entry (deep-frozen). */
export function createLogEntry(input: CreateLogEntryInput): LogEntry {
  return Object.freeze({
    id: logEntryIdFor({
      level: input.level,
      scope: input.scope,
      message: input.message,
      timestamp: input.timestamp,
    }),
    level: input.level,
    message: input.message,
    scope: Object.freeze({ ...input.scope }),
    timestamp: input.timestamp,
    correlation: Object.freeze({ ...(input.correlation ?? {}) }),
    context: Object.freeze({ ...(input.context ?? {}) }),
    metadata: Object.freeze({ tags: Object.freeze([...(input.metadata?.tags ?? [])]) }),
  });
}

/** Return a deep, detached copy of an entry (never frozen). */
export function cloneLogEntry(entry: LogEntry): LogEntry {
  return {
    id: entry.id,
    level: entry.level,
    message: entry.message,
    scope: { ...entry.scope },
    timestamp: entry.timestamp,
    correlation: { ...entry.correlation },
    context: { ...entry.context },
    metadata: { tags: [...entry.metadata.tags] },
  };
}

/** Deep-freeze an entry in place and return it (idempotent). */
export function freezeLogEntry(entry: LogEntry): LogEntry {
  Object.freeze(entry.scope);
  Object.freeze(entry.correlation);
  Object.freeze(entry.context);
  Object.freeze(entry.metadata);
  Object.freeze(entry.metadata.tags);
  return Object.freeze(entry);
}

/** Stable hash of an entry's identity. */
export function hashLogEntry(entry: LogEntry): string {
  return hashString(`${entry.id}:${entry.message}`);
}

/** Aggregate statistics over a set of entries. */
export function logStatistics(entries: readonly LogEntry[]): LogStatistics {
  const byLevel: Record<LogLevel, number> = {
    trace: 0,
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    fatal: 0,
  };
  for (const entry of entries) {
    byLevel[entry.level] += 1;
  }
  return Object.freeze({ total: entries.length, byLevel: Object.freeze(byLevel) });
}

/** Compact summary over a set of entries. */
export function logSummary(entries: readonly LogEntry[]): LogSummary {
  const first = entries[0];
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const levels = [...new Set(entries.map((entry) => entry.level))].sort(
    (left, right) => LOG_LEVEL_ORDER[left] - LOG_LEVEL_ORDER[right],
  );
  return Object.freeze({
    count: entries.length,
    ...(first !== undefined ? { firstAt: first.timestamp } : {}),
    ...(last !== undefined ? { lastAt: last.timestamp } : {}),
    levels: Object.freeze(levels),
  });
}

/** Project every entry to a lightweight reference. */
export function logReferences(entries: readonly LogEntry[]): readonly LogReference[] {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        id: entry.id,
        level: entry.level,
        message: entry.message,
        timestamp: entry.timestamp,
      }),
    ),
  );
}

/** Options accepted by {@link Logger.log}. */
export interface LogOptions {
  readonly correlation?: LogCorrelation;
  readonly context?: LogContext;
  readonly metadata?: Partial<LogMetadata>;
}

/** Input accepted by {@link Logger.child}. */
export interface ChildScopeInput {
  /** Nested scope label, e.g. the worker/action id. */
  readonly label?: string;
  readonly correlation?: LogCorrelation;
}

/**
 * An immutable structured logger. `log()` returns a successor logger plus
 * the created entry; the receiver is never mutated. Entries below
 * `minimumLevel` are dropped (the successor is unchanged). `maxEntries`
 * keeps the retained window bounded by dropping the oldest entries.
 */
export class Logger {
  readonly entries: readonly LogEntry[];
  readonly scope: LogScope;
  readonly correlation: LogCorrelation;

  private readonly minimumLevel: LogLevel;
  private readonly maxEntries: number | undefined;

  constructor(options: LoggerOptions = {}) {
    this.entries = Object.freeze([...(options.entries ?? [])].map(cloneLogEntry));
    this.scope = Object.freeze({ ...(options.scope ?? { name: "app" }) });
    this.correlation = Object.freeze({ ...(options.correlation ?? {}) });
    this.minimumLevel = options.minimumLevel ?? "trace";
    this.maxEntries = options.maxEntries;
  }

  /** Build a successor logger from partial state. */
  private next(partial: { entries: readonly LogEntry[] }): Logger {
    return new Logger({
      entries: partial.entries,
      scope: this.scope,
      correlation: this.correlation,
      minimumLevel: this.minimumLevel,
      maxEntries: this.maxEntries,
    });
  }

  /** The number of retained entries. */
  count(): number {
    return this.entries.length;
  }

  /** Whether an entry with `entryId` is retained. */
  has(entryId: string): boolean {
    return this.entries.some((entry) => entry.id === entryId);
  }

  /** The retained entry with `entryId`, or `undefined`. */
  find(entryId: string): LogEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    return entry === undefined ? undefined : cloneLogEntry(entry);
  }

  /** Detached copies of every retained entry, oldest first. */
  list(): LogEntry[] {
    return this.entries.map(cloneLogEntry);
  }

  /** Retained entries filtered by minimum level and scope name. */
  filter(options: { minimumLevel?: LogLevel; scope?: string } = {}): LogEntry[] {
    const min = LOG_LEVEL_ORDER[options.minimumLevel ?? this.minimumLevel];
    return this.entries
      .filter((entry) => LOG_LEVEL_ORDER[entry.level] >= min)
      .filter((entry) => options.scope === undefined || entry.scope.name === options.scope)
      .map(cloneLogEntry);
  }

  /** Statistics over the retained entries. */
  statistics(): LogStatistics {
    return logStatistics(this.entries);
  }

  /** Compact summary of the retained entries. */
  summary(): LogSummary {
    return logSummary(this.entries);
  }

  /** Point-in-time snapshot at `at`. */
  snapshot(at: string): LogSnapshot {
    return Object.freeze({
      at,
      entries: this.list(),
      statistics: this.statistics(),
      summary: this.summary(),
    });
  }

  /**
   * Record an entry and return the successor logger. Entries below the
   * logger's `minimumLevel` are dropped (the receiver is returned
   * unchanged, still never mutated).
   */
  log(
    level: LogLevel,
    message: string,
    timestamp: string,
    options: LogOptions = {},
  ): { logger: Logger; entry?: LogEntry } {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minimumLevel]) {
      return { logger: this };
    }
    const entry = createLogEntry({
      level,
      message,
      scope: this.scope,
      timestamp,
      correlation: mergeCorrelation(this.correlation, options.correlation),
      context: options.context,
      metadata: options.metadata,
    });
    let entries = [...this.entries, entry];
    if (this.maxEntries !== undefined && entries.length > this.maxEntries) {
      entries = entries.slice(entries.length - this.maxEntries);
    }
    return { logger: this.next({ entries }), entry };
  }

  /** Record a `trace` entry. */
  trace(message: string, timestamp: string, options?: LogOptions): { logger: Logger; entry?: LogEntry } {
    return this.log("trace", message, timestamp, options);
  }

  /** Record a `debug` entry. */
  debug(message: string, timestamp: string, options?: LogOptions): { logger: Logger; entry?: LogEntry } {
    return this.log("debug", message, timestamp, options);
  }

  /** Record an `info` entry. */
  info(message: string, timestamp: string, options?: LogOptions): { logger: Logger; entry?: LogEntry } {
    return this.log("info", message, timestamp, options);
  }

  /** Record a `warn` entry. */
  warn(message: string, timestamp: string, options?: LogOptions): { logger: Logger; entry?: LogEntry } {
    return this.log("warn", message, timestamp, options);
  }

  /** Record an `error` entry. */
  error(message: string, timestamp: string, options?: LogOptions): { logger: Logger; entry?: LogEntry } {
    return this.log("error", message, timestamp, options);
  }

  /** Record a `fatal` entry. */
  fatal(message: string, timestamp: string, options?: LogOptions): { logger: Logger; entry?: LogEntry } {
    return this.log("fatal", message, timestamp, options);
  }

  /**
   * Return a child logger scoped under `input.label` (e.g. a worker id).
   * The child shares the parent's retained entries and correlation chain,
   * merged with any caller-supplied ids.
   */
  child(input: ChildScopeInput = {}): Logger {
    return new Logger({
      entries: this.entries,
      scope: {
        name: this.scope.name,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(this.scope.correlationId !== undefined
          ? { correlationId: this.scope.correlationId }
          : {}),
      },
      correlation: mergeCorrelation(this.correlation, input.correlation),
      minimumLevel: this.minimumLevel,
      maxEntries: this.maxEntries,
    });
  }

  /**
   * Deterministic JSON serialization of the retained entries. Key order is
   * stable (level, message, scope, timestamp, correlation, context, tags),
   * so identical loggers serialize identically.
   */
  toJson(): string {
    return JSON.stringify(
      this.entries.map((entry) => ({
        level: entry.level,
        message: entry.message,
        scope: { name: entry.scope.name, ...(entry.scope.label ? { label: entry.scope.label } : {}) },
        timestamp: entry.timestamp,
        ...(Object.keys(entry.correlation).length > 0 ? { correlation: entry.correlation } : {}),
        ...(Object.keys(entry.context).length > 0 ? { context: entry.context } : {}),
        ...(entry.metadata.tags.length > 0 ? { tags: entry.metadata.tags } : {}),
      })),
    );
  }
}

/** Merge a parent correlation chain with optional additions (later wins). */
function mergeCorrelation(
  base: LogCorrelation,
  extra: LogCorrelation | undefined,
): LogCorrelation {
  return Object.freeze({ ...base, ...(extra ?? {}) });
}

/** Options accepted by {@link LoggerFactory.create}. */
export interface LoggerFactoryOptions {
  readonly scope?: LogScope;
  readonly correlation?: LogCorrelation;
  readonly minimumLevel?: LogLevel;
  readonly maxEntries?: number;
}

/**
 * Creates loggers with shared defaults. Stateless — every `create` returns
 * a fresh, independent logger.
 */
export class LoggerFactory {
  private readonly options: LoggerFactoryOptions;

  constructor(options: LoggerFactoryOptions = {}) {
    this.options = Object.freeze({ ...options });
  }

  /** Build a fresh logger with the factory's defaults. */
  create(options: LoggerFactoryOptions = {}): Logger {
    return new Logger({
      scope: options.scope ?? this.options.scope ?? { name: "app" },
      correlation: options.correlation ?? this.options.correlation,
      minimumLevel: options.minimumLevel ?? this.options.minimumLevel ?? "trace",
      maxEntries: options.maxEntries ?? this.options.maxEntries,
    });
  }

  /** Build a fresh logger for a named scope. */
  scoped(name: string, options: Omit<LoggerFactoryOptions, "scope"> = {}): Logger {
    return this.create({ ...options, scope: { name } });
  }
}
