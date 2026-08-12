/**
 * AI layer — tool result contract.
 *
 * Every AI tool returns a predictable normalized result:
 *
 * ```text
 * { success: true, tool: "gmail.summarizeInbox", data: {...}, sources: [...], generatedAt: "..." }
 * ```
 *
 * - Tools never return OAuth tokens, refresh tokens, or API keys (the
 *   underlying services never expose them; the shape has no such fields).
 * - Errors are thrown as `AppError` (project convention) and surfaced by the
 *   API layer — they are never encoded as `success: false` results.
 */

/** The six integration families the AI tools operate on. */
export type IntegrationName = "gmail" | "calendar" | "drive" | "github" | "discord" | "telegram";

/** A source reference the user can follow up on (never a secret). */
export interface AIToolSource {
  /** Integration family the item came from. */
  integration: IntegrationName;
  /** Item kind, e.g. "message", "event", "file", "issue". */
  type: string;
  /** Stable item id (integration-scoped; not a token). */
  id: string;
  /** Human-readable title, when available. */
  title?: string;
  /** Direct URL to the item, when the service provides one. */
  url?: string;
}

/** The normalized successful result of an AI tool execution. */
export interface AIToolSuccess {
  success: true;
  /** The tool id that produced this result, e.g. "gmail.summarizeInbox". */
  tool: string;
  /** Tool-specific normalized payload. */
  data: Record<string, unknown>;
  /** Source references preserved for the frontend. */
  sources: readonly AIToolSource[];
  /** ISO timestamp of when the tool ran. */
  generatedAt: string;
}

/** The result type every AI tool returns on success. */
export type AIToolResult = AIToolSuccess;

/** Build a normalized success result for `tool`. */
export function toolSuccess(
  tool: string,
  data: Record<string, unknown>,
  sources: readonly AIToolSource[] = [],
  now: () => string = () => new Date().toISOString(),
): AIToolResult {
  return {
    success: true,
    tool,
    data,
    sources,
    generatedAt: now(),
  };
}

/** Cap a string to `maxLength` characters (context-size safety). */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
