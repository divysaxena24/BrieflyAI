/**
 * Context Engine — development debugging helpers.
 *
 * Lightweight observability for the context pipeline, gated behind the
 * `CONTEXT_DEBUG=true` environment flag. Logging is routed through the
 * repository's shared logger (`lib/logger`).
 *
 * Privacy contract: these helpers never log user content. Callers pass only
 * counts, timings, enabled source ids, and pipeline stage names.
 */

import { logger } from "@/lib/logger";

/** Environment variable that enables context debug logging (value "true"). */
export const CONTEXT_DEBUG_ENV = "CONTEXT_DEBUG";

/**
 * The fixed pipeline stages of the Context Engine, in execution order.
 * Mirrors `ContextEngine.buildPrompt`'s orchestration.
 */
export const CONTEXT_PIPELINE_STAGES = [
  "retrieve",
  "rank",
  "deduplicate",
  "compress",
  "assemble",
  "prompt",
] as const;

/** Whether context debug logging is enabled (`CONTEXT_DEBUG=true`). */
export function isContextDebugEnabled(): boolean {
  return process.env[CONTEXT_DEBUG_ENV] === "true";
}

/**
 * Log a context-engine debug message through the shared logger — but only
 * when `CONTEXT_DEBUG=true`. A no-op otherwise.
 *
 * `meta` must contain only non-sensitive values (counts, timings, source
 * ids, stage names); user content is never passed here.
 */
export function logContextDebug(message: string, meta?: Record<string, unknown>): void {
  if (!isContextDebugEnabled()) return;
  logger.debug(`[context] ${message}`, meta ?? {});
}
