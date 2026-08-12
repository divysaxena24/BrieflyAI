/**
 * AI layer — tool planner.
 *
 * Implements the existing `Planner` contract (from `lib/tools/planner.ts`)
 * by selecting an AI tool for a user request:
 *
 * 1. When Groq is configured, ask it (in JSON mode) to pick a tool + input
 *    from the registered tool set, using each tool's description.
 * 2. The selection is validated against the registry, and the input is
 *    re-validated against the chosen tool's schema (invalid fields dropped).
 * 3. On any failure (Groq down, malformed JSON, invalid selection) it falls
 *    back to the deterministic `routeQuery` router — the request still works
 *    without the LLM.
 *
 * Returns a single-step immutable `ExecutionPlan` for the orchestrator's
 * `ToolExecutor`.
 */

import type { ExecutionPlan } from "@/lib/tools/plan";
import { createExecutionPlan } from "@/lib/tools/plan";
import type { Planner, PlannerContext } from "@/lib/tools/planner";
import type { ToolRegistry } from "@/lib/tools/registry";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { groqCompleteJson, productionGroqClient, type GroqClient } from "./groq";
import { routeQuery } from "./router";
import { AI_TOOL_IDS } from "./tools";

/** The JSON shape Groq is asked to return. */
interface ToolSelection {
  tool: string;
  input?: Record<string, unknown>;
}

/** Build the model prompt listing the available tools with descriptions. */
function buildSelectionPrompt(registry: ToolRegistry): string {
  const lines = registry
    .list()
    .map((tool) => `- ${tool.id}: ${tool.description}`)
    .join("\n");
  return [
    "You select ONE tool for a user request. Choose from this list:",
    lines,
    "",
    "Respond ONLY with JSON of the form {\"tool\": \"<tool id>\", \"input\": {...}}.",
    "Fill in input fields the user actually provided (e.g. a repository \"owner/repo\", a search query).",
    "If the user mentions a GitHub repo as \"owner/repo\", put it in input.repository.",
    "If no tool fits, respond with {\"tool\": \"\"}.",
  ].join("\n");
}

/**
 * Groq-backed planner with a deterministic fallback. Implements `Planner`.
 */
export class AIToolPlanner implements Planner {
  private readonly registry: ToolRegistry;
  private readonly groq: GroqClient;

  constructor(options: { registry: ToolRegistry; groq?: GroqClient }) {
    this.registry = options.registry;
    this.groq = options.groq ?? productionGroqClient;
  }

  async plan(context: PlannerContext): Promise<ExecutionPlan> {
    const available = context.availableToolIds;
    const validToolIds = new Set(available.length > 0 ? available : this.registry.list().map((tool) => tool.id));

    // 1) LLM-based selection (best effort — failures fall through).
    const selection = await this.selectWithGroq(context).catch((err: unknown) => {
      logger.warn("AIToolPlanner: Groq selection failed, using router", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (selection && validToolIds.has(selection.tool)) {
      const input = this.validateInput(selection.tool, selection.input ?? {});
      return this.singleStepPlan(selection.tool, input);
    }

    // 2) Deterministic router fallback.
    const route = routeQuery(context.query);
    if (route && validToolIds.has(route.toolId)) {
      const input = this.validateInput(route.toolId, route.input);
      return this.singleStepPlan(route.toolId, input);
    }

    throw new AppError(
      "I couldn't find an AI tool that matches your request.",
      400,
      "no_matching_tool",
    );
  }

  /** Ask Groq for a tool selection; returns null when it cannot decide. */
  private async selectWithGroq(context: PlannerContext): Promise<ToolSelection | null> {
    const systemPrompt = buildSelectionPrompt(this.registry);
    const userPrompt = [
      `User request: ${context.query}`,
      ...(context.history && context.history.length > 0
        ? [`Conversation history (newest last):\n${context.history.join("\n")}`]
        : []),
    ].join("\n");

    const parsed = await groqCompleteJson(this.groq, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      maxTokens: 150,
    });

    const toolId = typeof parsed.tool === "string" ? parsed.tool.trim() : "";
    if (!toolId || !AI_TOOL_IDS.includes(toolId)) return null;
    const rawInput = parsed.input;
    const input =
      rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : {};
    return { tool: toolId, input };
  }

  /** Re-validate the input against the tool's schema; drop invalid fields. */
  private validateInput(toolId: string, input: Record<string, unknown>): Record<string, unknown> {
    const tool = this.registry.get(toolId);
    if (!tool) return {};
    const parsed = tool.inputSchema.safeParse(input);
    if (parsed.success) return parsed.data as Record<string, unknown>;
    // Fall back to an empty input so the tool can use its defaults.
    const empty = tool.inputSchema.safeParse({});
    return empty.success ? (empty.data as Record<string, unknown>) : {};
  }

  private singleStepPlan(toolId: string, input: Record<string, unknown>): ExecutionPlan {
    return createExecutionPlan({
      id: `ai-plan-${Date.now()}`,
      steps: [{ stepId: "step-1", toolId, input, dependsOn: [] }],
    });
  }
}

export default AIToolPlanner;
