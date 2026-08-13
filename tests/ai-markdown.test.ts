import { describe, it, expect } from "vitest";
import { parseResponse, parseInline, classifySection } from "@/components/ai/markdown";
import { splitLabel } from "@/components/ai/InsightSection";

describe("parseResponse", () => {
  it("uses a level-1 heading as the title and keeps its content as leading", () => {
    const parsed = parseResponse("# Inbox Summary\n\nYou have 12 unread emails.");
    expect(parsed.title).toBe("Inbox Summary");
    expect(parsed.leading.length).toBe(1);
    expect(parsed.empty).toBe(false);
  });

  it("keeps level-2 headings as sections and falls back to a null title", () => {
    const parsed = parseResponse("## Important emails\n\n- **Odoo Hackathon**: Aug 16");
    expect(parsed.title).toBeNull();
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].title).toBe("Important emails");
  });

  it("splits heading-based sections and classifies them", () => {
    const parsed = parseResponse(
      [
        "# Inbox Summary",
        "You have 12 unread emails.",
        "## Key Insights",
        "- **Odoo Hackathon**: Deadline Aug 16",
        "- **ICPC Registration**: Open now",
        "## Recommended Actions",
        "- Apply to DigiValet",
        "- Register for ICPC",
        "## Recent Emails",
        "- email one",
        "- email two",
      ].join("\n"),
    );
    expect(parsed.title).toBe("Inbox Summary");
    expect(parsed.sections).toHaveLength(3);
    expect(parsed.sections[0].kind).toBe("insights");
    expect(parsed.sections[1].kind).toBe("actions");
    expect(parsed.sections[2].kind).toBe("generic");
  });

  it("parses bullet lists into list items", () => {
    const parsed = parseResponse("## Details\n\n- one\n- two\n- three");
    const section = parsed.sections[0];
    const list = section.blocks.find((b) => b.kind === "list");
    expect(list?.kind).toBe("list");
    if (list?.kind === "list") expect(list.items).toHaveLength(3);
  });

  it("marks empty responses as empty", () => {
    expect(parseResponse("").empty).toBe(true);
    expect(parseResponse("   ").empty).toBe(true);
    expect(parseResponse(null).empty).toBe(true);
  });

  it("marks bare no-data phrases as empty", () => {
    expect(parseResponse("No data found.").empty).toBe(true);
    expect(parseResponse("No results").empty).toBe(true);
  });

  it("keeps a friendly no-data sentence as content", () => {
    const parsed = parseResponse("No meetings tomorrow — enjoy your free day!");
    expect(parsed.empty).toBe(false);
  });
});

describe("parseInline", () => {
  it("converts bold, italic, code and links to segments", () => {
    const segments = parseInline("**Label:** see [here](https://example.com) and `code`");
    const kinds = segments.map((s) => s.kind);
    expect(kinds).toContain("bold");
    expect(kinds).toContain("text");
    expect(kinds).toContain("link");
    expect(kinds).toContain("code");
    const link = segments.find((s) => s.kind === "link");
    expect(link && link.kind === "link" ? link.url : null).toBe("https://example.com");
  });
});

describe("splitLabel", () => {
  it("extracts a leading bold label from an insight item", () => {
    const segments = parseInline("**Odoo Hackathon**: Deadline Aug 16");
    const { label, rest } = splitLabel(segments);
    expect(label).toBe("Odoo Hackathon");
    expect(rest.map((s) => ("text" in s ? s.text : "")).join("").trim()).toBe("Deadline Aug 16");
  });

  it("returns no label for plain items", () => {
    const segments = parseInline("Apply to DigiValet");
    expect(splitLabel(segments).label).toBeNull();
  });
});

describe("classifySection", () => {
  it("classifies common heading names", () => {
    expect(classifySection("Recommended Actions")).toBe("actions");
    expect(classifySection("Key Insights")).toBe("insights");
    expect(classifySection("Sources")).toBe("sources");
    expect(classifySection("Recent Emails")).toBe("generic");
  });
});
