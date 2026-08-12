/**
 * AI layer — public exports.
 *
 * Server-only by design: everything here reads `process.env` (the Groq key)
 * or resolves the authenticated user's integrations from the request
 * context. Never import from client components.
 */
export * from "./groq";
export * from "./sanitize";
export * from "./prompts";
export * from "./router";
export * from "./planner";
export * from "./orchestrator";
export * from "./tools";
