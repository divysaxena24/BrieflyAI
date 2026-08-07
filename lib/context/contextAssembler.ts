/**
 * Context Engine — context assembly (pure formatting).
 *
 * Converts a `Context[]` into the final formatted context block consumed by
 * the prompt builder. This module performs no retrieval, ranking,
 * deduplication, compression, token estimation, or AI calls — it only renders
 * the exact layout below:
 *
 * ```text
 * === CONTEXT START ===
 *
 * [1]
 *
 * Source:
 * <source>
 *
 * Title:
 * <title>
 *
 * Time:
 * <timestamp>
 *
 * Content:
 * <content>
 *
 * ---------------------------------
 * ...
 * === CONTEXT END ===
 * ```
 */

import type { Context } from "./types";

const CONTEXT_START_MARKER = "=== CONTEXT START ===";
const CONTEXT_END_MARKER = "=== CONTEXT END ===";
const SEPARATOR = "-".repeat(32);
const EMPTY_MESSAGE = "(No context available)";
const UNKNOWN_TIME = "Unknown";

/**
 * Format a single context block as `[n]` … `Content:` lines.
 * `timestamp` is rendered as "Unknown" only when null or undefined.
 */
function formatContext(context: Context, number: number): string {
  return [
    `[${number}]`,
    "",
    "Source:",
    context.source,
    "",
    "Title:",
    context.title,
    "",
    "Time:",
    context.timestamp ?? UNKNOWN_TIME,
    "",
    "Content:",
    context.content,
  ].join("\n");
}

/**
 * Pure formatter that renders contexts into the context block layout.
 */
export class ContextAssembler {
  /**
   * Render `contexts` into a single formatted string.
   *
   * - Numbering starts at 1 and increments sequentially; input order is
   *   preserved (never sorted, filtered, or deduplicated).
   * - Contexts are separated by exactly 32 hyphens; no separator follows the
   *   final context.
   * - A null/undefined `timestamp` is rendered as "Unknown".
   * - An empty input renders the `(No context available)` placeholder between
   *   the start and end markers.
   * - `source`, `title`, `timestamp`, and `content` are preserved verbatim
   *   (no trimming, summarizing, escaping, or markdown conversion). An empty
   *   field value renders as an empty line, which together with the
   *   structural blank line produces two consecutive blank lines.
   *
   * The input array and its objects are never mutated; only a string is
   * returned.
   */
  assemble(contexts: Context[]): string {
    if (contexts.length === 0) {
      return `${CONTEXT_START_MARKER}\n\n${EMPTY_MESSAGE}\n\n${CONTEXT_END_MARKER}`;
    }

    const blocks = contexts
      .map((context, index) => formatContext(context, index + 1))
      .join(`\n\n${SEPARATOR}\n\n`);

    return `${CONTEXT_START_MARKER}\n\n${blocks}\n\n${CONTEXT_END_MARKER}`;
  }
}
