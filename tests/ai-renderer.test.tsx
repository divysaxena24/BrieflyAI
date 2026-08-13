import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResponseRenderer } from "@/components/ai/ResponseRenderer";

const SAMPLE_RESPONSE = [
  "## Important emails",
  "- **Odoo Hackathon**: Deadline Aug 16",
  "- **ICPC Registration**: Open now",
  "## Recommended Actions",
  "- Apply to DigiValet",
  "- Register for ICPC",
  "## Summary",
  "You have 12 unread emails today.",
].join("\n");

describe("ResponseRenderer", () => {
  it("renders structured markup without raw markdown", () => {
    const html = renderToStaticMarkup(
      <ResponseRenderer
        content={SAMPLE_RESPONSE}
        tool="gmail.summarizeInbox"
        sources={[
          { integration: "gmail", type: "message", id: "1", title: "Odoo Hackathon", url: "https://mail.google.com" },
        ]}
      />,
    );
    // Card title derived from the tool when no level-1 heading exists.
    expect(html).toContain("Inbox Summary");
    // Section headings are rendered as <h3> (not "##" text).
    expect(html).toContain("Important emails");
    expect(html).toContain("Recommended Actions");
    expect(html).not.toContain("##");
    expect(html).not.toContain("**");
    // Sources are rendered as links.
    expect(html).toContain("https://mail.google.com");
  });

  it("renders a friendly empty state for empty content", () => {
    const html = renderToStaticMarkup(
      <ResponseRenderer content="" tool="calendar.todaySchedule" />,
    );
    expect(html).not.toContain("No data");
    expect(html).toContain("enjoy your free time");
  });

  it("renders a friendly error state instead of raw backend errors", () => {
    const html = renderToStaticMarkup(
      <ResponseRenderer
        content=""
        tool="drive.searchFiles"
        aiError={{ code: "groq_error", message: "502 Bad Gateway" }}
      />,
    );
    expect(html).not.toContain("502");
    expect(html).not.toContain("Bad Gateway");
  });
});
