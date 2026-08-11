/**
 * Engine API validators (Phase 5J STEP 4).
 *
 * Request schemas for the memory/conversation/digest/job/action/workflow/
 * persistence API routes. The schemas validate the *wire* shape; the
 * engines' own creators are the authoritative structural validators (e.g.
 * `createWorkflow` validates steps/cycles).
 */

import { z } from "zod";

/** Shared: an ISO-8601 UTC timestamp string. */
export const isoTimestamp = z.string().min(1);

/** ── Memories ─────────────────────────────────────────────────────────── */

export const createMemorySchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  kind: z.enum(["fact", "preference", "task", "knowledge", "conversation", "context"]).optional(),
  source: z.enum(["user", "assistant", "system", "tool", "derived"]).optional(),
  importance: z.enum(["low", "normal", "high", "critical"]).optional(),
  tier: z.enum(["short-term", "long-term"]).optional(),
  tags: z.array(z.string()).optional(),
  createdAt: isoTimestamp,
});

export const memoryPatchSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  kind: z.enum(["fact", "preference", "task", "knowledge", "conversation", "context"]).optional(),
  importance: z.enum(["low", "normal", "high", "critical"]).optional(),
  tier: z.enum(["short-term", "long-term"]).optional(),
  state: z.enum(["active", "archived"]).optional(),
  tags: z.array(z.string()).optional(),
  updatedAt: isoTimestamp.optional(),
});

/** ── Conversations ────────────────────────────────────────────────────── */

export const startConversationSchema = z.object({
  id: z.string().min(1),
  createdAt: isoTimestamp,
  title: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

export const appendMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().min(1),
  createdAt: isoTimestamp,
});

export const conversationActionSchema = z.object({
  action: z.enum(["append", "rename", "archive", "restore", "close", "delete"]),
  /** Payload for `append`. */
  message: appendMessageSchema.optional(),
  /** Payload for `rename`. */
  title: z.string().min(1).optional(),
});

/** ── Digests ──────────────────────────────────────────────────────────── */

export const buildDigestSchema = z.object({
  kind: z.enum(["morning", "evening", "weekly"]).default("morning"),
  query: z.string().optional(),
  now: isoTimestamp.optional(),
});

export const digestActionSchema = z.object({
  action: z.enum(["publish", "read", "unread", "archive", "restore", "delete"]),
  now: isoTimestamp.optional(),
});

/** ── Jobs ─────────────────────────────────────────────────────────────── */

export const registerJobSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  trigger: z.enum(["manual", "scheduled", "recurring", "startup", "shutdown"]).default("manual"),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
  schedule: z
    .object({
      at: isoTimestamp.optional(),
      everyMs: z.number().int().positive().optional(),
      startsAt: isoTimestamp.optional(),
    })
    .optional(),
  maxAttempts: z.number().int().positive().optional(),
  createdAt: isoTimestamp,
  scheduledAt: isoTimestamp.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const jobActionSchema = z.object({
  action: z.enum(["run", "cancel", "retry", "archive", "restore", "unregister"]),
  now: isoTimestamp.optional(),
});

/** ── Actions ──────────────────────────────────────────────────────────── */

/** The closed set of engine action types (mirrors `ActionType`). */
export const actionTypeEnum = z.enum([
  "search_gmail",
  "search_calendar",
  "search_drive",
  "search_github",
  "create_memory",
  "update_conversation",
  "generate_digest",
  "run_job",
  "execute_tool_plan",
  "custom",
]);

/** An explicit action request within a plan intent (mirrors `PlanActionRequest`). */
export const actionRequestSchema = z.object({
  type: actionTypeEnum,
  input: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
  name: z.string().min(1).optional(),
  dependsOn: z.array(actionTypeEnum).optional(),
});

export const planIntentSchema = z.object({
  text: z.string().min(1),
  userId: z.string().min(1),
  now: isoTimestamp,
  conversationId: z.string().min(1).optional(),
  requests: z.array(actionRequestSchema).optional(),
});

export const runActionSchema = z.object({
  name: z.string().min(1),
  type: actionTypeEnum,
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoTimestamp,
});

export const actionActionSchema = z.object({
  action: z.enum(["cancel", "retry", "archive", "restore", "delete"]),
  now: isoTimestamp.optional(),
});

/** ── Workflows ────────────────────────────────────────────────────────── */

/** A workflow step's action payload, discriminated by `kind` (see `toWorkflowAction`). */
export const workflowStepActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("action"),
    intent: z.string().min(1).optional(),
    requests: z.array(actionRequestSchema).optional(),
  }),
  z.object({ kind: z.literal("job"), jobId: z.string().min(1) }),
  z.object({ kind: z.literal("tool"), plan: z.record(z.string(), z.unknown()) }),
  z.object({
    kind: z.literal("digest"),
    template: z.record(z.string(), z.unknown()).optional(),
    query: z.string().optional(),
  }),
]);

export const registerWorkflowSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
  trigger: z
    .object({
      kind: z.enum(["manual", "scheduled", "conversation", "memory", "digest", "job", "action", "tool"]).default("manual"),
      event: z.string().optional(),
      schedule: z
        .object({
          at: isoTimestamp.optional(),
          everyMs: z.number().int().positive().optional(),
          startsAt: isoTimestamp.optional(),
        })
        .optional(),
      conversationId: z.string().optional(),
      memoryId: z.string().optional(),
      digestId: z.string().optional(),
      jobId: z.string().optional(),
      actionId: z.string().optional(),
      toolId: z.string().optional(),
    })
    .optional(),
  steps: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      action: workflowStepActionSchema,
      dependsOn: z.array(z.string()).optional(),
      priority: z.enum(["low", "normal", "high", "critical"]).optional(),
      maxAttempts: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
  ),
  createdAt: isoTimestamp,
  scheduledAt: isoTimestamp.optional(),
  enabled: z.boolean().optional(),
});

export const workflowActionSchema = z.object({
  action: z.enum(["run", "disable", "enable", "archive", "restore", "delete"]),
  now: isoTimestamp.optional(),
});

export const triggerWorkflowSchema = z.object({
  kind: z.enum(["manual", "scheduled", "conversation", "memory", "digest", "job", "action", "tool"]),
  entityId: z.string().optional(),
  event: z.string().optional(),
  now: isoTimestamp,
  signal: z.record(z.string(), z.unknown()).optional(),
});

/** ── Persistence ──────────────────────────────────────────────────────── */

export const persistenceActionSchema = z.object({
  action: z.enum(["save", "load", "clear"]),
  /** Namespace (defaults to the authenticated user id). */
  scope: z.string().min(1).optional(),
});
