import { describe, it, expect } from "vitest";
import { PromptBuilder } from "@/lib/context/promptBuilder";
import { ContextAssembler } from "@/lib/context/contextAssembler";
import type { Context } from "@/lib/context/types";

const SYSTEM_HEADER = "================ SYSTEM ================";
const HISTORY_HEADER = "================ HISTORY ================";
const CONTEXT_HEADER = "================ CONTEXT ================";
const USER_HEADER = "================ USER ================";
const ASSISTANT_HEADER = "================ ASSISTANT ================";

const DEFAULT_SYSTEM_PROMPT = [
  "You are BrieflyAI, an intelligent AI assistant.",
  "Answer only using the provided context whenever possible.",
  "If the context is insufficient, clearly say so instead of inventing information.",
].join("\n");

const builder = new PromptBuilder();

/** Build a valid Context fixture (for assembling a genuine context block). */
function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    id: "ctx-1",
    source: "gmail",
    title: "Interview",
    content: "Your interview is scheduled for Monday.",
    timestamp: "2026-08-08T10:00:00Z",
    relevance: 0.5,
    tokenEstimate: 10,
    truncated: false,
    compressed: false,
    metadata: { kind: "email", entityId: "e1" },
    permissions: null,
    ...overrides,
  };
}

describe("PromptBuilder SYSTEM section", () => {
  it("renders a custom system prompt under the SYSTEM header", () => {
    const output = builder.build({ context: "c", userQuery: "q", systemPrompt: "You are a test assistant." });
    expect(output).toContain(`${SYSTEM_HEADER}\n\nYou are a test assistant.`);
  });

  it("uses the default system prompt when omitted", () => {
    const output = builder.build({ context: "c", userQuery: "q" });
    expect(output).toContain(`${SYSTEM_HEADER}\n\n${DEFAULT_SYSTEM_PROMPT}`);
  });

  it("uses the default system prompt when explicitly undefined", () => {
    const output = builder.build({ context: "c", userQuery: "q", systemPrompt: undefined });
    expect(output).toContain(`${SYSTEM_HEADER}\n\n${DEFAULT_SYSTEM_PROMPT}`);
  });

  it("preserves a multiline system prompt verbatim", () => {
    const systemPrompt = "Line one\nLine two\nLine three";
    expect(builder.build({ context: "c", userQuery: "q", systemPrompt })).toContain(
      `${SYSTEM_HEADER}\n\n${systemPrompt}`,
    );
  });

  it("preserves an empty-string system prompt instead of falling back", () => {
    const output = builder.build({ context: "c", userQuery: "q", systemPrompt: "" });
    // Empty content renders as an empty line between the header and the next section.
    expect(output).toContain(`${SYSTEM_HEADER}\n\n\n\n${HISTORY_HEADER}`);
    expect(output).not.toContain(DEFAULT_SYSTEM_PROMPT);
  });

  it("preserves a unicode system prompt", () => {
    const systemPrompt = "日本語のプロンプト 🎯";
    expect(builder.build({ context: "c", userQuery: "q", systemPrompt })).toContain(
      `${SYSTEM_HEADER}\n\n${systemPrompt}`,
    );
  });
});

describe("PromptBuilder HISTORY section", () => {
  it("prints the placeholder when history is omitted", () => {
    expect(builder.build({ context: "c", userQuery: "q" })).toContain(
      `${HISTORY_HEADER}\n\n(No conversation history)`,
    );
  });

  it("prints the placeholder when history is an empty array", () => {
    expect(builder.build({ context: "c", userQuery: "q", history: [] })).toContain(
      `${HISTORY_HEADER}\n\n(No conversation history)`,
    );
  });

  it("renders a single history entry", () => {
    expect(builder.build({ context: "c", userQuery: "q", history: ["User: hi"] })).toContain(
      `${HISTORY_HEADER}\n\nUser: hi`,
    );
  });

  it("renders multiple entries each on its own line", () => {
    expect(builder.build({ context: "c", userQuery: "q", history: ["User: hi", "Assistant: hello"] })).toContain(
      `${HISTORY_HEADER}\n\nUser: hi\nAssistant: hello`,
    );
  });

  it("preserves history order and never reverses it", () => {
    const history = ["first", "second", "third"];
    const output = builder.build({ context: "c", userQuery: "q", history });
    expect(output.indexOf("first")).toBeLessThan(output.indexOf("second"));
    expect(output.indexOf("second")).toBeLessThan(output.indexOf("third"));
  });

  it("preserves a multiline history entry verbatim", () => {
    const entry = "line one\nline two";
    expect(builder.build({ context: "c", userQuery: "q", history: [entry] })).toContain(
      `${HISTORY_HEADER}\n\n${entry}`,
    );
  });

  it("preserves an empty-string history entry as an empty line", () => {
    const output = builder.build({ context: "c", userQuery: "q", history: ["a", "", "b"] });
    expect(output).toContain(`${HISTORY_HEADER}\n\na\n\nb`);
  });

  it("never trims history entries", () => {
    const history = ["  padded  ", "  indented"];
    expect(builder.build({ context: "c", userQuery: "q", history })).toContain(
      `${HISTORY_HEADER}\n\n  padded  \n  indented`,
    );
  });

  it("treats a non-empty history array as provided even if it holds empty strings", () => {
    // [""] passes the length check, so it renders an empty content line
    // (the same empty-value quirk as an empty user query) instead of the
    // "(No conversation history)" placeholder.
    const output = builder.build({ context: "c", userQuery: "q", history: [""] });
    expect(output).toContain(`${HISTORY_HEADER}\n\n\n\n${CONTEXT_HEADER}`);
    expect(output).not.toContain("(No conversation history)");
  });
});

describe("PromptBuilder CONTEXT section", () => {
  it("prints the placeholder for an empty context", () => {
    expect(builder.build({ context: "", userQuery: "q" })).toContain(`${CONTEXT_HEADER}\n\n(No context)`);
  });

  it("preserves an assembled context block exactly", () => {
    const block = new ContextAssembler().assemble([makeContext()]);
    expect(builder.build({ context: block, userQuery: "q" })).toContain(`${CONTEXT_HEADER}\n\n${block}`);
  });

  it("preserves a multiline context block", () => {
    const context = "=== CONTEXT START ===\n\n[1]\n\nSource:\ngmail\n\n=== CONTEXT END ===";
    expect(builder.build({ context, userQuery: "q" })).toContain(`${CONTEXT_HEADER}\n\n${context}`);
  });

  it("preserves a unicode context block", () => {
    const context = "ミーティング 🗓️ の内容";
    expect(builder.build({ context, userQuery: "q" })).toContain(`${CONTEXT_HEADER}\n\n${context}`);
  });

  it("preserves a long context block", () => {
    const context = "x".repeat(5000);
    expect(builder.build({ context, userQuery: "q" })).toContain(`${CONTEXT_HEADER}\n\n${context}`);
  });

  it("preserves internal blank lines in the context block", () => {
    const context = "line one\n\n\nline two";
    expect(builder.build({ context, userQuery: "q" })).toContain(`${CONTEXT_HEADER}\n\n${context}`);
  });

  it("preserves header-looking context text verbatim", () => {
    const context = `${SYSTEM_HEADER}\n${HISTORY_HEADER}\n${ASSISTANT_HEADER}`;
    expect(builder.build({ context, userQuery: "q" })).toContain(`${CONTEXT_HEADER}\n\n${context}`);
  });

  it("does not replace a whitespace-only context with the placeholder", () => {
    const output = builder.build({ context: "  ", userQuery: "q" });
    expect(output).toContain(`${CONTEXT_HEADER}\n\n  `);
    expect(output).not.toContain(`${CONTEXT_HEADER}\n\n(No context)`);
  });
});

describe("PromptBuilder USER section", () => {
  it("renders a normal query", () => {
    expect(builder.build({ context: "c", userQuery: "What's on my calendar?" })).toContain(
      `${USER_HEADER}\n\nWhat's on my calendar?`,
    );
  });

  it("still prints the USER section for an empty query, followed by an empty line", () => {
    const output = builder.build({ context: "c", userQuery: "" });
    expect(output).toContain(USER_HEADER);
    expect(output.endsWith(`${USER_HEADER}\n\n\n\n${ASSISTANT_HEADER}`)).toBe(true);
  });

  it("preserves a multiline query verbatim", () => {
    const query = "first line\nsecond line";
    expect(builder.build({ context: "c", userQuery: query })).toContain(`${USER_HEADER}\n\n${query}`);
  });

  it("preserves a unicode query", () => {
    const query = "今日の予定は？ 📅";
    expect(builder.build({ context: "c", userQuery: query })).toContain(`${USER_HEADER}\n\n${query}`);
  });

  it("never trims the query", () => {
    expect(builder.build({ context: "c", userQuery: "  hi there  " })).toContain(
      `${USER_HEADER}\n\n  hi there  `,
    );
  });
});

describe("PromptBuilder formatting", () => {
  it("includes all five section headers", () => {
    const output = builder.build({ context: "c", userQuery: "q", history: ["h"], systemPrompt: "s" });
    for (const header of [SYSTEM_HEADER, HISTORY_HEADER, CONTEXT_HEADER, USER_HEADER, ASSISTANT_HEADER]) {
      expect(output).toContain(header);
    }
  });

  it("orders the sections SYSTEM → HISTORY → CONTEXT → USER → ASSISTANT", () => {
    const output = builder.build({ context: "c", userQuery: "q", history: ["h"], systemPrompt: "s" });
    const positions = [SYSTEM_HEADER, HISTORY_HEADER, CONTEXT_HEADER, USER_HEADER, ASSISTANT_HEADER].map(
      (header) => output.indexOf(header),
    );
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("places exactly one blank line between non-empty sections", () => {
    const output = builder.build({ context: "c", userQuery: "q", history: ["h"], systemPrompt: "s" });
    expect(output).not.toContain("\n\n\n");
    expect(output).toContain("\n\n");
  });

  it("ends with no trailing newline", () => {
    const output = builder.build({ context: "c", userQuery: "q" });
    expect(output.endsWith("\n")).toBe(false);
  });

  it("ends with no trailing whitespace", () => {
    const output = builder.build({ context: "c", userQuery: "q", history: ["h"], systemPrompt: "s" });
    expect(/\s$/.test(output)).toBe(false);
  });

  it("ends immediately after the ASSISTANT header", () => {
    const output = builder.build({ context: "c", userQuery: "q" });
    expect(output.endsWith(ASSISTANT_HEADER)).toBe(true);
    expect(output.slice(0, -ASSISTANT_HEADER.length).endsWith("\n\n")).toBe(true);
  });

  it("renders the exact golden prompt for fully provided values", () => {
    const context = "=== CONTEXT START ===\n\n[1]\n\nSource:\ngmail\n\nTitle:\nInterview\n\nTime:\n2026-08-08T10:00:00Z\n\nContent:\nYour interview is scheduled for Monday.\n\n=== CONTEXT END ===";
    const output = builder.build({
      systemPrompt: "You are a test assistant.",
      history: ["User: hi", "Assistant: hello"],
      context,
      userQuery: "What's on my calendar?",
    });
    expect(output).toBe(
      [
        SYSTEM_HEADER,
        "",
        "You are a test assistant.",
        "",
        HISTORY_HEADER,
        "",
        "User: hi",
        "Assistant: hello",
        "",
        CONTEXT_HEADER,
        "",
        context,
        "",
        USER_HEADER,
        "",
        "What's on my calendar?",
        "",
        ASSISTANT_HEADER,
      ].join("\n"),
    );
  });

  it("renders the exact golden prompt for all-default values", () => {
    const output = builder.build({ context: "", userQuery: "" });
    expect(output).toBe(
      [
        SYSTEM_HEADER,
        "",
        ...DEFAULT_SYSTEM_PROMPT.split("\n"),
        "",
        HISTORY_HEADER,
        "",
        "(No conversation history)",
        "",
        CONTEXT_HEADER,
        "",
        "(No context)",
        "",
        USER_HEADER,
        "",
        "",
        "",
        ASSISTANT_HEADER,
      ].join("\n"),
    );
  });
});

describe("PromptBuilder determinism", () => {
  it("produces identical output for the same input across calls", () => {
    const options = { context: "c", userQuery: "q", history: ["h1", "h2"], systemPrompt: "s" };
    expect(builder.build(options)).toBe(builder.build(options));
  });

  it("produces identical output for equal but distinct option objects", () => {
    const a = builder.build({ context: "c", userQuery: "q", history: ["h"], systemPrompt: "s" });
    const b = builder.build({ context: "c", userQuery: "q", history: ["h"], systemPrompt: "s" });
    expect(a).toBe(b);
  });
});

describe("PromptBuilder immutability", () => {
  it("does not mutate the options object", () => {
    const options = { systemPrompt: "s", context: "c", userQuery: "q", history: ["h1", "h2"] };
    builder.build(options);
    expect(options).toEqual({ systemPrompt: "s", context: "c", userQuery: "q", history: ["h1", "h2"] });
  });

  it("does not mutate the history array", () => {
    const history = ["h1", "h2"];
    builder.build({ context: "c", userQuery: "q", history });
    expect(history).toEqual(["h1", "h2"]);
  });

  it("does not mutate the string inputs", () => {
    const systemPrompt = "s";
    const context = "c";
    const userQuery = "q";
    builder.build({ systemPrompt, context, userQuery });
    expect(systemPrompt).toBe("s");
    expect(context).toBe("c");
    expect(userQuery).toBe("q");
  });
});

describe("PromptBuilder edge cases", () => {
  it("preserves markdown characters", () => {
    const query = "**bold** `code` [link](https://x.com)";
    expect(builder.build({ context: "c", userQuery: query })).toContain(`${USER_HEADER}\n\n${query}`);
  });

  it("preserves HTML-like content", () => {
    const context = "<b>hi</b> <script>alert(1)</script>";
    expect(builder.build({ context, userQuery: "q" })).toContain(`${CONTEXT_HEADER}\n\n${context}`);
  });

  it("preserves emojis", () => {
    const query = "🚀✨🔥";
    expect(builder.build({ context: "c", userQuery: query })).toContain(`${USER_HEADER}\n\n${query}`);
  });

  it("preserves special characters", () => {
    const query = "quotes \" ' and <angle> & ampersand \\\\ backslash\ttab";
    expect(builder.build({ context: "c", userQuery: query })).toContain(`${USER_HEADER}\n\n${query}`);
  });

  it("handles a very long prompt", () => {
    const output = builder.build({
      context: "c".repeat(2000),
      userQuery: "q".repeat(2000),
      history: Array.from({ length: 100 }, (_, i) => `h${i}`),
      systemPrompt: "s".repeat(500),
    });
    expect(output.length).toBeGreaterThan(5000);
    expect(output.endsWith(ASSISTANT_HEADER)).toBe(true);
  });

  it("preserves 500 history entries in order", () => {
    const history = Array.from({ length: 500 }, (_, i) => `entry-${i}`);
    const output = builder.build({ context: "c", userQuery: "q", history });
    expect(output.indexOf("entry-0")).toBeGreaterThan(output.indexOf(HISTORY_HEADER));
    expect(output.indexOf("entry-499")).toBeGreaterThan(output.indexOf("entry-498"));
    expect(output.indexOf("entry-0")).toBeLessThan(output.indexOf("entry-499"));
  });

  it("preserves a query that contains a section header", () => {
    const query = ASSISTANT_HEADER;
    const output = builder.build({ context: "c", userQuery: query });
    expect(output).toContain(`${USER_HEADER}\n\n${ASSISTANT_HEADER}`);
    expect(output.split(ASSISTANT_HEADER).length - 1).toBe(2);
    expect(output.endsWith(ASSISTANT_HEADER)).toBe(true);
  });

  it("preserves markdown inside history entries", () => {
    const history = ["**bold**", "[link](https://x.com)", "`code`"];
    expect(builder.build({ context: "c", userQuery: "q", history })).toContain(
      `${HISTORY_HEADER}\n\n${history.join("\n")}`,
    );
  });
});
