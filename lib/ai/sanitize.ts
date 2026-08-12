/**
 * AI layer — LLM context sanitization.
 *
 * Everything sent to Groq passes through {@link sanitizeForLLM}:
 *
 * - Sensitive fields (`token`, `secret`, `password`, `authorization`,
 *   `credential`, `apiKey`, …) are stripped recursively — defense in depth
 *   on top of the services never exposing them in the first place.
 * - Unrelated internal ids (`nextPageToken`, `pageToken`) are also removed.
 * - String values are capped to keep the context bounded (no full message
 *   bodies unless a tool deliberately includes a bounded preview).
 *
 * The sanitized output is used ONLY for the LLM context; the result returned
 * to the frontend is the raw normalized tool data (which already contains no
 * secrets).
 */

/** Matches sensitive field names at any nesting level. */
const SENSITIVE_KEY = /token|secret|password|authorization|credential|api[_-]?key/i;

/** Default maximum length for a string sent to the LLM. */
export const DEFAULT_MAX_STRING_LENGTH = 600;

/** Default maximum depth to walk. */
const MAX_DEPTH = 6;

/**
 * Recursively sanitize a value for LLM consumption.
 *
 * - Object keys matching {@link SENSITIVE_KEY} are removed entirely.
 * - Strings longer than `maxStringLength` are truncated.
 * - Arrays are mapped element-wise; objects are rebuilt (never mutated).
 * - Cycles and depths beyond `maxDepth` yield `undefined` (dropped).
 */
export function sanitizeForLLM(
  value: unknown,
  options: { maxStringLength?: number; maxDepth?: number } = {},
): unknown {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;

  const seen = new WeakSet<object>();
  const walk = (current: unknown, depth: number): unknown => {
    if (depth > maxDepth) return undefined;
    if (current === null) return null;

    switch (typeof current) {
      case "string": {
        return truncateString(current, maxStringLength);
      }
      case "number":
      case "boolean":
        return current;
      case "object": {
        if (seen.has(current)) return undefined;
        seen.add(current);
        try {
          if (Array.isArray(current)) {
            const result: unknown[] = [];
            for (const item of current) {
              const sanitized = walk(item, depth + 1);
              if (sanitized !== undefined) result.push(sanitized);
            }
            return result;
          }
          const record = current as Record<string, unknown>;
          const result: Record<string, unknown> = {};
          for (const [key, subValue] of Object.entries(record)) {
            if (SENSITIVE_KEY.test(key)) continue;
            const sanitized = walk(subValue, depth + 1);
            if (sanitized !== undefined) result[key] = sanitized;
          }
          return result;
        } finally {
          seen.delete(current);
        }
      }
      default:
        return undefined;
    }
  };

  return walk(value, 0);
}

/** Truncate a string at a UTF-16-safe boundary near `maxLength`. */
function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
