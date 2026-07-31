// ──────────────────────────────────────────────
//  GitHub services barrel
//  Reusable HTTP layer (client/errors/utils) + repositories service.
// ──────────────────────────────────────────────

export * from "./githubService";
export * from "./githubClient";
export * from "./githubErrors";
export * from "./githubUtils";

export { default as githubService } from "./githubService";
export { default } from "./githubService";
