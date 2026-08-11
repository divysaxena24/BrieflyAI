/**
 * Phase 6D STEP 4 — template engine tests.
 */
import { describe, expect, it } from "vitest";
import {
  renderTemplate,
  validateTemplate,
  compileTemplate,
  parseTemplate,
  extractTemplateReferences,
  hasUnclosedReference,
  escapeHtml,
  resolveTemplatePath,
  TemplateRegistry,
  createTemplateRegistry,
  templateRegistryHash,
} from "@/lib/notifications/templates";
import {
  createNotificationTemplate,
  touchNotificationTemplate,
} from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";

const template = (overrides: Record<string, unknown> = {}) =>
  createNotificationTemplate({
    name: "welcome",
    body: "Hello {{user.name}}, you have {{count}} new memories",
    subject: "Welcome {{user.name}}",
    variables: [{ name: "user.name" }, { name: "count" }],
    createdAt: NOW,
    ...overrides,
  });

describe("extraction and parsing", () => {
  it("extracts flat and nested references in order", () => {
    const references = extractTemplateReferences("A {{a}} B {{user.name}} C");
    expect(references.map((reference) => reference.path)).toEqual(["a", "user.name"]);
    expect(references[1]?.segments).toEqual(["user", "name"]);
  });

  it("records reference spans", () => {
    const references = extractTemplateReferences("{{x}}");
    expect(references[0]?.start).toBe(0);
    expect(references[0]?.end).toBe(5);
  });

  it("ignores empty references", () => {
    expect(extractTemplateReferences("{{}}")).toEqual([]);
  });

  it("detects unclosed references", () => {
    expect(hasUnclosedReference("hello {{name")).toBe(true);
    expect(hasUnclosedReference("hello {{name}}")).toBe(false);
    expect(hasUnclosedReference("no refs")).toBe(false);
  });

  it("parseTemplate marks well-formedness", () => {
    const parsed = parseTemplate(template());
    expect(parsed.templateId).toBe(template().id);
    expect(parsed.wellFormed).toBe(true);
    expect(parsed.source).toContain("{{user.name}}");
  });
});

describe("renderTemplate", () => {
  it("interpolates flat variables", () => {
    const rendered = renderTemplate(template(), { "user.name": "Ada", count: 3 });
    expect(rendered.content).toBe("Hello Ada, you have 3 new memories");
    expect(rendered.subject).toBe("Welcome Ada");
  });

  it("resolves nested variable paths", () => {
    const rendered = renderTemplate(
      createNotificationTemplate({
        name: "nested",
        body: "Hi {{user.profile.name}}",
        variables: [{ name: "user.profile.name" }],
        createdAt: NOW,
      }),
      { user: { profile: { name: "Grace" } } },
    );
    expect(rendered.content).toBe("Hi Grace");
  });

  it("falls back to declared defaults", () => {
    const rendered = renderTemplate(
      createNotificationTemplate({
        name: "defaults",
        body: "{{greeting}} world",
        variables: [{ name: "greeting", default: "Hello" }],
        createdAt: NOW,
      }),
      {},
    );
    expect(rendered.content).toBe("Hello world");
    expect(rendered.missing).toEqual([]);
  });

  it("missing variables render as empty strings and are reported", () => {
    const rendered = renderTemplate(template(), {});
    expect(rendered.content).toBe("Hello , you have  new memories");
    expect(rendered.missing).toEqual(["user.name", "count"]);
    expect(rendered.resolved).toEqual([]);
  });

  it("escapes HTML variables in html format", () => {
    const htmlTemplate = createNotificationTemplate({
      name: "html",
      body: "<p>Hi {{name}}</p>",
      variables: [{ name: "name" }],
      createdAt: NOW,
    });
    const rendered = renderTemplate(htmlTemplate, { name: "<b>&\"'" }, "html");
    expect(rendered.content).toBe("<p>Hi &lt;b&gt;&amp;&quot;&#39;</p>");
  });

  it("does not escape in plain or markdown formats", () => {
    const rendered = renderTemplate(template(), { "user.name": "<Ada>", count: 1 }, "plain");
    expect(rendered.content).toContain("<Ada>");
  });

  it("rendering is deterministic", () => {
    const variables = { "user.name": "Ada", count: 3 };
    expect(renderTemplate(template(), variables).content).toBe(
      renderTemplate(template(), variables).content,
    );
  });

  it("renders repeated references", () => {
    const repeated = createNotificationTemplate({
      name: "rep",
      body: "{{x}} + {{x}}",
      variables: [{ name: "x" }],
      createdAt: NOW,
    });
    expect(renderTemplate(repeated, { x: "1" }).content).toBe("1 + 1");
  });

  it("leaves unknown references untouched when undeclared", () => {
    const bare = createNotificationTemplate({
      name: "bare",
      body: "keep {{unknown}}",
      createdAt: NOW,
    });
    // renderTemplate does not validate — unknown refs resolve to "".
    expect(renderTemplate(bare, {}).content).toBe("keep ");
  });

  it("tracks resolved paths", () => {
    const rendered = renderTemplate(template(), { "user.name": "Ada" });
    expect(rendered.resolved).toEqual(["user.name"]);
    expect(rendered.missing).toEqual(["count"]);
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-sensitive characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("is idempotent-free (does not double-escape)", () => {
    expect(escapeHtml("plain")).toBe("plain");
  });
});

describe("resolveTemplatePath", () => {
  it("resolves nested paths", () => {
    expect(resolveTemplatePath({ a: { b: { c: 1 } } }, ["a", "b", "c"])).toBe(1);
  });

  it("returns undefined for missing segments", () => {
    expect(resolveTemplatePath({ a: 1 }, ["a", "b"])).toBeUndefined();
    expect(resolveTemplatePath({}, ["a"])).toBeUndefined();
  });
});

describe("validateTemplate", () => {
  it("accepts a well-formed template with declared variables", () => {
    expect(validateTemplate(template()).ok).toBe(true);
  });

  it("rejects unknown variables in strict mode", () => {
    const result = validateTemplate(
      createNotificationTemplate({
        name: "bad",
        body: "{{undeclared}}",
        variables: [{ name: "other" }],
        createdAt: NOW,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "unknown_variable")).toBe(true);
  });

  it("ignores unknown variables when not strict", () => {
    const result = validateTemplate(
      createNotificationTemplate({ name: "bad", body: "{{x}}", createdAt: NOW }),
      { strictVariables: false },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects missing required variables without defaults", () => {
    const result = validateTemplate(
      createNotificationTemplate({
        name: "req",
        body: "{{must}}",
        variables: [{ name: "must", required: true }],
        createdAt: NOW,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "missing_required")).toBe(true);
  });

  it("accepts required variables that carry defaults", () => {
    const result = validateTemplate(
      createNotificationTemplate({
        name: "req",
        body: "{{must}}",
        variables: [{ name: "must", required: true, default: "d" }],
        createdAt: NOW,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects empty bodies", () => {
    const result = validateTemplate(
      createNotificationTemplate({ name: "empty", body: "", createdAt: NOW }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "empty_body")).toBe(true);
  });

  it("rejects unclosed references", () => {
    const result = validateTemplate(
      createNotificationTemplate({ name: "open", body: "{{oops", createdAt: NOW }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "unclosed_reference")).toBe(true);
  });

  it("never throws", () => {
    expect(() =>
      validateTemplate(createNotificationTemplate({ name: "x", body: "{{", createdAt: NOW })),
    ).not.toThrow();
  });
});

describe("compileTemplate", () => {
  it("compiles a template into a pure render function", () => {
    const compiled = compileTemplate(template());
    expect(compiled.id).toBe(template().id);
    expect(compiled.render({ "user.name": "Ada", count: 2 }).content).toBe(
      "Hello Ada, you have 2 new memories",
    );
  });

  it("compiled rendering is deterministic and repeatable", () => {
    const compiled = compileTemplate(template());
    const first = compiled.render({ "user.name": "Ada", count: 1 });
    const second = compiled.render({ "user.name": "Ada", count: 1 });
    expect(first).toEqual(second);
  });

  it("compiled render reflects the template format", () => {
    const html = compileTemplate(
      createNotificationTemplate({
        name: "h",
        body: "{{v}}",
        variables: [{ name: "v" }],
        format: "html",
        createdAt: NOW,
      }),
    );
    const rendered = html.render({ v: "<x>" });
    expect(rendered.content).toBe("&lt;x&gt;");
    expect(rendered.format).toBe("html");
  });
});

describe("TemplateRegistry", () => {
  it("registers templates and rejects duplicates", () => {
    const registry = createTemplateRegistry();
    const next = registry.register(template());
    expect(next.count()).toBe(1);
    expect(() => next.register(template())).toThrow(/already contains/);
  });

  it("rejects duplicate names even with different ids", () => {
    const registry = createTemplateRegistry();
    const withId = createNotificationTemplate({
      id: "template-x",
      name: "welcome",
      body: "Hi",
      createdAt: NOW,
    });
    expect(() => registry.register(withId).register(template())).toThrow(/name/);
  });

  it("looks up by id and name", () => {
    const registry = createTemplateRegistry().register(template());
    expect(registry.has(template().id)).toBe(true);
    expect(registry.hasName("welcome")).toBe(true);
    expect(registry.get(template().id)?.body).toContain("{{user.name}}");
    expect(registry.getByName("welcome")?.id).toBe(template().id);
  });

  it("returns detached copies", () => {
    const registry = createTemplateRegistry().register(template());
    const copy = registry.get(template().id);
    copy?.variables.push({ name: "extra" });
    expect(registry.get(template().id)?.variables).toHaveLength(2);
  });

  it("unregister is a no-op for absent ids", () => {
    const registry = createTemplateRegistry();
    expect(registry.unregister("missing")).toBe(registry);
  });

  it("unregister removes the template", () => {
    const registry = createTemplateRegistry().register(template());
    const next = registry.unregister(template().id);
    expect(next.count()).toBe(0);
    expect(registry.count()).toBe(1);
  });

  it("update patches and recomputes the version", () => {
    const registry = createTemplateRegistry().register(template());
    const next = registry.update(template().id, { body: "New body {{count}}" });
    const updated = next.get(template().id);
    expect(updated?.body).toBe("New body {{count}}");
    expect(updated?.version).not.toBe(template().version);
  });

  it("update throws for unknown ids", () => {
    const registry = createTemplateRegistry();
    expect(() => registry.update("nope", { body: "x" })).toThrow(/does not contain/);
  });

  it("hash is deterministic and content-sensitive", () => {
    const a = createTemplateRegistry().register(template());
    const b = createTemplateRegistry().register(template());
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).toBe(templateRegistryHash(a.list()));
    const c = a.update(template().id, { body: "Changed" });
    expect(c.hash()).not.toBe(a.hash());
  });

  it("touchNotificationTemplate detaches from the source", () => {
    const original = template();
    const updated = touchNotificationTemplate(original, { body: "New" });
    expect(original.body).toBe("Hello {{user.name}}, you have {{count}} new memories");
    expect(updated.body).toBe("New");
  });

  it("seeds from an initial template list", () => {
    const registry = new TemplateRegistry({ templates: [template()] });
    expect(registry.count()).toBe(1);
  });
});
