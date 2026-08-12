/**
 * AI layer — orchestrator.
 *
 * The end-to-end flow for a natural-language request:
 *
 * ```text
 * query → AIToolPlanner (Groq, router fallback)
 *      → ToolExecutor (real integration services)
 *      → normalized tool result
 *      → Groq natural-language response
 *      → frontend
 * ```
 *
 * - Tool data comes from the existing production services (never mocked,
 *   never invented).
 * - The context sent to Groq is sanitized (`sanitizeForLLM`) — no tokens,
 *   no internal ids, bounded sizes.
 * - Groq failures degrade gracefully: the real tool data is still returned
 *   with `response: null` and an `aiError` detail. Tool execution failures
 *   throw `AppError` (project convention).
 */

import { ToolExecutor } from "@/lib/tools/executor";
import type { Planner, PlannerContext } from "@/lib/tools/planner";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { productionGroqClient, type GroqClient } from "./groq";
import { AIToolPlanner } from "./planner";
import { buildToolInstruction } from "./prompts";
import { sanitizeForLLM } from "./sanitize";
import { createAIToolRegistry, type AIToolSource, type AIToolResult } from "./tools";

/** Input accepted by {@link AIOrchestrator.handle}. */
export interface AIRequestInput {
  /** The user's natural-language request. */
  query: string;
  /** Optional prior conversation turns (newest last), forwarded to Groq. */
  history?: readonly string[];
}

/** The result returned to the frontend. */
export interface AIOrchestratorResult {
  success: true;
  /** The AI tool that ran, e.g. "gmail.summarizeInbox". */
  tool: string;
  /** The normalized tool data. */
  data: Record<string, unknown>;
  /** Source references (integration, type, id, title, url). */
  sources: readonly AIToolSource[];
  /** The natural-language response (null when Groq summarization failed). */
  response: string | null;
  /** Human-readable note (e.g. tool limitations). */
  note?: string;
  /** Groq failure detail when the LLM step failed but tool data succeeded. */
  aiError?: { code: string; message: string };
  /** ISO timestamp of the tool execution. */
  generatedAt: string;
}

/** Options accepted by the {@link AIOrchestrator} constructor. */
export interface AIOrchestratorOptions {
  /** Tool registry (defaults to the 20 AI tools). */
  registry?: ReturnType<typeof createAIToolRegistry>;
  /** Planner (defaults to `AIToolPlanner` over the registry). */
  planner?: Planner;
  /** Groq client (defaults to the production client). */
  groq?: GroqClient;
}

/**
 * Orchestrates plan → execute → respond for a single AI request.
 */
export class AIOrchestrator {
  private readonly registry: ReturnType<typeof createAIToolRegistry>;
  private readonly planner: Planner;
  private readonly groq: GroqClient;

  constructor(options: AIOrchestratorOptions = {}) {
    this.registry = options.registry ?? createAIToolRegistry();
    this.groq = options.groq ?? productionGroqClient;
    this.planner =
      options.planner ?? new AIToolPlanner({ registry: this.registry, groq: this.groq });
  }

  /** Handle one request and return the normalized result + AI response. */
  async handle(input: AIRequestInput): Promise<AIOrchestratorResult> {
    const query = input.query.trim();
    if (!query) throw new AppError("Message is required", 400, "invalid_request");

    // 1) Plan: pick the tool.
    const context: PlannerContext = {
      // Tools resolve the authenticated user from the request context
      // themselves (request-scoped services) — no user id is needed here.
      userId: "",
      query,
      history: input.history ? [...input.history] : [],
      availableToolIds: this.registry.list().map((tool) => tool.id),
    };
    const plan = await this.planner.plan(context);

    // 2) Execute the single-step plan.
    const execution = await new ToolExecutor(this.registry).execute(plan);
    const step = execution.results[0];
    if (step.status !== "success" || !step.output) {
      const message = step.error?.message ?? "Tool execution failed";
      const code = step.error?.code ?? "tool_execution_error";
      // Preserve the underlying AppError status (e.g. 401 for a session that
      // needs reconnecting, 404 for a repo that was not found) instead of
      // flattening every failure into a 502. A missing repo must never look
      // like an internal server error.
      const status = step.error?.status ?? 502;
      throw new AppError(message, status, code);
    }
    const result = step.output as AIToolResult;

    // 3) Natural-language response from Groq over sanitized tool data.
    const safeData = sanitizeForLLM(result.data);
    const response = await this.generateResponse({
      toolId: result.tool,
      data: safeData,
      query,
      history: input.history,
    });

    return {
      success: true,
      tool: result.tool,
      data: result.data,
      sources: result.sources,
      response: response.text,
      ...(response.aiError ? { aiError: response.aiError } : {}),
      note: pickNote(result.data),
      generatedAt: result.generatedAt,
    };
  }

  /** Ask Groq for the natural-language answer; degrade gracefully on failure. */
  private async generateResponse(args: {
    toolId: string;
    data: unknown;
    query: string;
    history?: readonly string[];
  }): Promise<{ text: string | null; aiError?: { code: string; message: string } }> {
    const messages = [
      { role: "system" as const, content: buildToolInstruction(args.toolId) },
      ...(args.history && args.history.length > 0
        ? [
            {
              role: "assistant" as const,
              content: `Previous conversation:\n${args.history.join("\n")}`,
            },
          ]
        : []),
      {
        role: "user" as const,
        content: `User request: ${args.query}\n\nTool data (JSON):\n${JSON.stringify(args.data)}`,
      },
    ];

    try {
      const completion = await this.groq.complete({
        messages,
        temperature: 0.3,
        maxTokens: 700,
      });
      return { text: completion.text.trim() };
    } catch (err) {
      logger.warn("AIOrchestrator: Groq response failed; returning tool data only", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof AppError) {
        return {
          text: null,
          aiError: { code: err.code ?? "ai_error", message: err.message },
        };
      }
      return { text: null, aiError: { code: "ai_error", message: "AI summarization failed" } };
    }
  }
}

/** Extract a human-readable tool note (e.g. a data limitation) from a result. */
function pickNote(data: Record<string, unknown>): string | undefined {
  if (typeof data.note === "string" && data.note.length > 0) return data.note;
  if (typeof data.message === "string" && data.message.length > 0) return data.message;
  return undefined;
}

/** Handle an AI request through the default production orchestrator. */
export async function handleAIRequest(input: AIRequestInput): Promise<AIOrchestratorResult> {
  return productionOrchestrator.handle(input);
}

/** The application's single orchestrator instance. */
const productionOrchestrator = new AIOrchestrator();

export default AIOrchestrator;
