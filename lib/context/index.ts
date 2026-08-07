/**
 * Context Engine — public exports.
 *
 * Re-exports the core type definitions and the production composition entry
 * point (`createContextEngine`). No runtime logic lives here.
 */
export * from "./types";
export { createContextEngine } from "./createContextEngine";
