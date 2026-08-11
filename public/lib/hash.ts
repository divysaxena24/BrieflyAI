/**
 * Shared deterministic hashing — Phase 5J STEP 1.
 *
 * The FNV-1a hash was previously duplicated verbatim in the memory,
 * conversation, jobs, digest, actions, and workflows type modules. This is
 * the single canonical implementation; new code (persistence, events,
 * delivery, API ids) uses it instead of re-implementing.
 *
 * The previous phases' private copies are intentionally left untouched (per
 * the phase rules — "do not modify previous phases unless absolutely
 * necessary"); their implementations are byte-identical to this one, so
 * migrating them later is a pure mechanical import swap.
 *
 * Deterministic 32-bit FNV-1a hash of `value`, rendered as lowercase hex.
 * No `Date.now()`, no `Math.random()` — hashing is a pure function.
 */

/** Deterministic 32-bit FNV-1a hash of `value`, rendered as lowercase hex. */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** FNV-1a offset basis (exposed for tests and diagnostics). */
export const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a prime (exposed for tests and diagnostics). */
export const FNV_PRIME = 0x01000193;
