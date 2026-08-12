import { describe, it, expect, vi, afterEach } from "vitest";
import {
  GroqService,
  groqCompleteJson,
  isGroqConfigured,
  getGroqModel,
  mapGroqError,
  GROQ_CHAT_ENDPOINT,
  DEFAULT_GROQ_MODEL,
} from "@/lib/ai/groq";
import { AppError } from "@/lib/errors";

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeCompletionPayload(text = "Hello", model = DEFAULT_GROQ_MODEL) {
  return {
    id: "chatcmpl-test",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

// ──────────────────────────────────────────────
//  Configuration
// ──────────────────────────────────────────────

describe("Groq configuration", () => {
  it("isGroqConfigured is false when the key is missing", () => {
    // An empty string (not undefined) so the assertion is deterministic even
    // when a .env.local file provides a real key during tests.
    vi.stubEnv("GROQ_API_KEY", "");
    expect(isGroqConfigured()).toBe(false);
  });

  it("isGroqConfigured is true when the key is set", () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_test");
    expect(isGroqConfigured()).toBe(true);
  });

  it("isGroqConfigured is false for a blank key", () => {
    vi.stubEnv("GROQ_API_KEY", "   ");
    expect(isGroqConfigured()).toBe(false);
  });

  it("defaults the model to a supported Groq model", () => {
    vi.stubEnv("GROQ_MODEL", "");
    expect(getGroqModel()).toBe(DEFAULT_GROQ_MODEL);
  });

  it("honors a GROQ_MODEL override", () => {
    vi.stubEnv("GROQ_MODEL", "llama-3.1-8b-instant");
    expect(getGroqModel()).toBe("llama-3.1-8b-instant");
  });
});

// ──────────────────────────────────────────────
//  Error mapping
// ──────────────────────────────────────────────

describe("mapGroqError", () => {
  it("maps 401/403 to a groq authentication error", () => {
    const err = mapGroqError(401);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("groq_authentication_error");
  });

  it("maps 429 to rate_limited", () => {
    const err = mapGroqError(429);
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
  });

  it("maps 5xx to groq_server_error", () => {
    const err = mapGroqError(503);
    expect(err.code).toBe("groq_server_error");
  });

  it("extracts the API-provided message", () => {
    const err = mapGroqError(500, { error: { message: "Internal model failure" } });
    expect(err.message).toContain("Internal model failure");
  });
});

// ──────────────────────────────────────────────
//  Client behavior
// ──────────────────────────────────────────────

describe("GroqService.complete", () => {
  it("throws ai_not_configured when no API key is present", async () => {
    const client = new GroqService({ apiKey: "" });
    await expect(
      client.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "ai_not_configured", status: 503 });
  });

  it("posts to the chat completions endpoint with the right headers and body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeCompletionPayload()));
    const client = new GroqService({ apiKey: "gsk_secret", model: "test-model" });
    await client.complete({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.5,
      maxTokens: 200,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GROQ_CHAT_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer gsk_secret");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages).toHaveLength(2);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(200);
    expect(body.response_format).toBeUndefined();
  });

  it("requests json_object mode when jsonMode is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeCompletionPayload('{"ok": true}')));
    const client = new GroqService({ apiKey: "gsk_secret" });
    await client.complete({
      messages: [{ role: "user", content: "json please" }],
      jsonMode: true,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("returns text, model, and usage on success", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(makeCompletionPayload("The summary.", "llama-3.3-70b-versatile")),
    );
    const client = new GroqService({ apiKey: "gsk_secret" });
    const result = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("The summary.");
    expect(result.model).toBe("llama-3.3-70b-versatile");
    expect(result.usage?.totalTokens).toBe(15);
  });

  it("throws a mapped AppError on a non-OK status", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Rate limit hit" } }, 429),
    );
    const client = new GroqService({ apiKey: "gsk_secret" });
    await expect(
      client.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("throws AIError on a malformed JSON response body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const client = new GroqService({ apiKey: "gsk_secret" });
    await expect(
      client.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "ai_error" });
  });

  it("throws AIError when the content is empty", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeCompletionPayload("   ")));
    const client = new GroqService({ apiKey: "gsk_secret" });
    await expect(
      client.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "ai_error" });
  });

  it("throws AppError when the network request fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const client = new GroqService({ apiKey: "gsk_secret" });
    await expect(
      client.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "groq_error" });
  });
});

// ──────────────────────────────────────────────
//  JSON mode helper
// ──────────────────────────────────────────────

describe("groqCompleteJson", () => {
  it("parses valid JSON output", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeCompletionPayload('{"tool": "x"}')));
    const client = new GroqService({ apiKey: "gsk_secret" });
    const parsed = await groqCompleteJson(client, {
      messages: [{ role: "user", content: "pick" }],
    });
    expect(parsed).toEqual({ tool: "x" });
  });

  it("throws AIError on invalid JSON output", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeCompletionPayload("not json at all")));
    const client = new GroqService({ apiKey: "gsk_secret" });
    await expect(
      groqCompleteJson(client, { messages: [{ role: "user", content: "pick" }] }),
    ).rejects.toMatchObject({ code: "ai_error" });
  });
});
