import { describe, it, expect } from "vitest";
import { ContextAssembler } from "@/lib/context/contextAssembler";
import type { Context } from "@/lib/context/types";

/** Build a valid Context fixture. */
function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    id: "ctx-1",
    source: "gmail",
    title: "Title",
    content: "Content",
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

const START = "=== CONTEXT START ===";
const END = "=== CONTEXT END ===";
const SEP = "-".repeat(32);
const assembler = new ContextAssembler();

describe("ContextAssembler empty input", () => {
  it("returns exactly the empty-input layout", () => {
    expect(assembler.assemble([])).toBe(`${START}\n\n(No context available)\n\n${END}`);
  });

  it("includes the no-context placeholder", () => {
    expect(assembler.assemble([])).toContain("(No context available)");
  });

  it("contains no context blocks for empty input", () => {
    const output = assembler.assemble([]);
    expect(output).not.toContain("[1]");
    expect(output).not.toContain("Source:");
  });
});

describe("ContextAssembler single context", () => {
  it("formats a single context exactly", () => {
    const output = assembler.assemble([makeContext()]);
    expect(output).toBe(
      [
        START,
        "",
        "[1]",
        "",
        "Source:",
        "gmail",
        "",
        "Title:",
        "Title",
        "",
        "Time:",
        "2026-08-08T10:00:00Z",
        "",
        "Content:",
        "Content",
        "",
        END,
      ].join("\n"),
    );
  });

  it("numbers the first context as [1]", () => {
    expect(assembler.assemble([makeContext()])).toContain("[1]");
  });

  it("includes the start marker", () => {
    expect(assembler.assemble([makeContext()])).toContain(START);
  });

  it("includes the end marker", () => {
    expect(assembler.assemble([makeContext()])).toContain(END);
  });
});

describe("ContextAssembler multiple contexts", () => {
  it("numbers contexts sequentially", () => {
    const output = assembler.assemble([makeContext({ id: "a" }), makeContext({ id: "b" }), makeContext({ id: "c" })]);
    expect(output).toContain("[1]");
    expect(output).toContain("[2]");
    expect(output).toContain("[3]");
  });

  it("renders the exact two-context layout", () => {
    const output = assembler.assemble([
      makeContext({ source: "gmail", title: "Interview Invitation", content: "Your interview is scheduled for Monday.", timestamp: "2026-08-08T10:00:00Z" }),
      makeContext({ source: "github", title: "PR #42", content: "Authentication bug fixed.", timestamp: "2026-08-07T14:22:00Z", metadata: { kind: "pr", entityId: "42" } }),
    ]);
    expect(output).toBe(
      [
        START,
        "",
        "[1]",
        "",
        "Source:",
        "gmail",
        "",
        "Title:",
        "Interview Invitation",
        "",
        "Time:",
        "2026-08-08T10:00:00Z",
        "",
        "Content:",
        "Your interview is scheduled for Monday.",
        "",
        SEP,
        "",
        "[2]",
        "",
        "Source:",
        "github",
        "",
        "Title:",
        "PR #42",
        "",
        "Time:",
        "2026-08-07T14:22:00Z",
        "",
        "Content:",
        "Authentication bug fixed.",
        "",
        END,
      ].join("\n"),
    );
  });

  it("places exactly n - 1 separators for n contexts", () => {
    const output = assembler.assemble(Array.from({ length: 4 }, (_, i) => makeContext({ id: `c${i}` })));
    expect(output.split(SEP).length - 1).toBe(3);
  });

  it("never places a separator after the final context", () => {
    const output = assembler.assemble([makeContext({ id: "a" }), makeContext({ id: "b" })]);
    expect(output.endsWith(END)).toBe(true);
    // The separator must appear between the blocks, not after the last content.
    expect(output.indexOf(SEP)).toBeGreaterThan(output.indexOf("[1]"));
    expect(output.lastIndexOf(SEP)).toBeLessThan(output.indexOf(END));
    expect(output.slice(output.lastIndexOf(SEP) + SEP.length)).toMatch(/^\n\n\[2\]/);
  });

  it("preserves the original input order", () => {
    const first = makeContext({ id: "x", content: "first-content" });
    const second = makeContext({ id: "y", content: "second-content" });
    const output = assembler.assemble([first, second]);
    expect(output.indexOf("first-content")).toBeLessThan(output.indexOf("second-content"));
  });
});

describe("ContextAssembler timestamps", () => {
  it("prints a valid timestamp verbatim", () => {
    expect(assembler.assemble([makeContext({ timestamp: "2026-08-08T10:00:00Z" })])).toContain("Time:\n2026-08-08T10:00:00Z");
  });

  it("prints Unknown for a null timestamp", () => {
    expect(assembler.assemble([makeContext({ timestamp: null })])).toContain("Time:\nUnknown");
  });

  it("prints Unknown for an undefined timestamp", () => {
    expect(assembler.assemble([makeContext({ timestamp: undefined })])).toContain("Time:\nUnknown");
  });

  it("never prints the literal 'null' or 'undefined'", () => {
    const output = assembler.assemble([makeContext({ timestamp: null }), makeContext({ timestamp: undefined })]);
    expect(output).not.toContain("Time:\nnull");
    expect(output).not.toContain("Time:\nundefined");
  });

  it("prints an empty-string timestamp as an empty value", () => {
    const output = assembler.assemble([makeContext({ timestamp: "" })]);
    expect(output).toContain("Time:\n\n\nContent:");
  });
});

describe("ContextAssembler content preservation", () => {
  it("handles empty content", () => {
    const output = assembler.assemble([makeContext({ content: "" })]);
    const lines = output.split("\n");
    // Content label, empty value line, blank separator line, then the end marker.
    expect(lines[lines.length - 4]).toBe("Content:");
    expect(lines[lines.length - 3]).toBe("");
    expect(lines[lines.length - 2]).toBe("");
    expect(lines[lines.length - 1]).toBe(END);
  });

  it("preserves multiline content", () => {
    const output = assembler.assemble([makeContext({ content: "line one\nline two\nline three" })]);
    expect(output).toContain("Content:\nline one\nline two\nline three");
  });

  it("preserves unicode content", () => {
    const content = "héllo wörld 日本語 🎉";
    expect(assembler.assemble([makeContext({ content })])).toContain(`Content:\n${content}`);
  });

  it("preserves long content", () => {
    const content = "x".repeat(5000);
    expect(assembler.assemble([makeContext({ content })])).toContain(`Content:\n${content}`);
  });

  it("preserves leading and trailing whitespace in content", () => {
    const content = "  padded  \n\t";
    expect(assembler.assemble([makeContext({ content })])).toContain(`Content:\n${content}`);
  });
});

describe("ContextAssembler field correctness", () => {
  it("prints the correct source", () => {
    expect(assembler.assemble([makeContext({ source: "discord" })])).toContain("Source:\ndiscord");
  });

  it("prints the correct title", () => {
    expect(assembler.assemble([makeContext({ title: "Weekly Sync" })])).toContain("Title:\nWeekly Sync");
  });

  it("prints the correct timestamp", () => {
    expect(assembler.assemble([makeContext({ timestamp: "2026-01-02T03:04:05Z" })])).toContain("Time:\n2026-01-02T03:04:05Z");
  });

  it("prints the correct content", () => {
    expect(assembler.assemble([makeContext({ content: "unique body text" })])).toContain("Content:\nunique body text");
  });
});

describe("ContextAssembler formatting", () => {
  it("starts with the exact start marker line", () => {
    expect(assembler.assemble([makeContext()]).startsWith(START)).toBe(true);
  });

  it("ends with the exact end marker line", () => {
    expect(assembler.assemble([makeContext()]).endsWith(END)).toBe(true);
  });

  it("includes the required blank lines", () => {
    const output = assembler.assemble([makeContext()]);
    expect(output).toContain(`${START}\n\n[1]`);
    expect(output).toContain("Content:\nContent\n\n" + END);
  });

  it("uses exactly 32 hyphens as the separator", () => {
    const output = assembler.assemble([makeContext({ id: "a" }), makeContext({ id: "b" })]);
    expect(output).toContain(SEP);
    expect(SEP.length).toBe(32);
  });

  it("has no trailing whitespace", () => {
    const output = assembler.assemble([makeContext(), makeContext({ id: "b" })]);
    expect(/\s$/.test(output)).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const contexts = [makeContext({ id: "a" }), makeContext({ id: "b", content: "two" })];
    expect(assembler.assemble(contexts)).toBe(assembler.assemble(contexts));
  });
});

describe("ContextAssembler edge cases", () => {
  it("handles an empty source", () => {
    // Empty value line + blank separator line between labels.
    expect(assembler.assemble([makeContext({ source: "" })])).toContain("Source:\n\n\nTitle:");
  });

  it("handles an empty title", () => {
    // Empty value line + blank separator line between labels.
    expect(assembler.assemble([makeContext({ title: "" })])).toContain("Title:\n\n\nTime:");
  });

  it("handles a null timestamp as Unknown", () => {
    expect(assembler.assemble([makeContext({ timestamp: null })])).toContain("Time:\nUnknown");
  });

  it("preserves markdown characters in content", () => {
    const content = "**bold** and `code` and [link](https://x.com)";
    expect(assembler.assemble([makeContext({ content })])).toContain(`Content:\n${content}`);
  });

  it("preserves HTML-like content", () => {
    const content = "<b>hi</b> <script>alert(1)</script>";
    expect(assembler.assemble([makeContext({ content })])).toContain(`Content:\n${content}`);
  });

  it("preserves emojis", () => {
    const content = "🚀✨🔥";
    expect(assembler.assemble([makeContext({ content })])).toContain(`Content:\n${content}`);
  });

  it("preserves special characters", () => {
    const content = "quotes \" ' and <angle> & ampersand \\ backslash";
    expect(assembler.assemble([makeContext({ content })])).toContain(`Content:\n${content}`);
  });

  it("handles many contexts", () => {
    const contexts = Array.from({ length: 100 }, (_, i) => makeContext({ id: `c${i}`, content: `body-${i}` }));
    const output = assembler.assemble(contexts);
    expect(output).toContain("[1]");
    expect(output).toContain("[100]");
    expect(output.split(SEP).length - 1).toBe(99);
    for (let i = 0; i < 100; i += 1) {
      expect(output).toContain(`body-${i}`);
    }
    expect(output.indexOf("body-0")).toBeLessThan(output.indexOf("body-99"));
  });
});

describe("ContextAssembler immutability", () => {
  it("does not mutate the input array", () => {
    const contexts = [makeContext({ id: "a" }), makeContext({ id: "b" })];
    assembler.assemble(contexts);
    expect(contexts).toHaveLength(2);
    expect(contexts.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("does not mutate context objects", () => {
    const context = makeContext({ content: "original" });
    assembler.assemble([context]);
    expect(context.content).toBe("original");
    expect(context.source).toBe("gmail");
    expect(context.title).toBe("Title");
    expect(context.timestamp).toBe("2026-08-08T10:00:00Z");
  });

  it("does not mutate metadata", () => {
    const metadata = { kind: "email" as const, entityId: "e1", threadId: "t1" };
    assembler.assemble([makeContext({ metadata })]);
    expect(metadata).toEqual({ kind: "email", entityId: "e1", threadId: "t1" });
  });

  it("does not mutate permissions", () => {
    const permissions = { integrationId: "i1", platform: "gmail", scopes: ["read"], level: "read" as const };
    assembler.assemble([makeContext({ permissions })]);
    expect(permissions).toEqual({ integrationId: "i1", platform: "gmail", scopes: ["read"], level: "read" });
  });
});
