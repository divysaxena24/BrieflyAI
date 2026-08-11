/**
 * Notification & Delivery System — template engine (Phase 6D STEP 4).
 *
 * A pure, deterministic template engine over the `NotificationTemplate`
 * model:
 *
 * - **Formats**: plain text, markdown and HTML. Rendering a template in a
 *   format produces the interpolated content in that format (HTML variables
 *   are HTML-escaped; markdown/plain are not).
 * - **Interpolation**: `{{name}}` and nested `{{user.name}}` paths resolve
 *   against a caller-supplied variables object. Missing variables fall back
 *   to the declared default or the empty string (deterministic).
 * - **Validation**: a template is validated against its declared variables
 *   and well-formedness (balanced `{{ }}`, no unknown variables when
 *   strict). Never throws — returns a structured result.
 * - **Compilation**: `compile` parses a template once into a `CompiledTemplate`
 *   (a pure render function + an id + the referenced variable paths);
 *   rendering the compiled form avoids re-parsing.
 * - **Versioning**: content versions come from the types module
 *   (`templateVersionFor`); the engine never duplicates that logic.
 * - **Registry**: an immutable, successor-based `TemplateRegistry` of named
 *   templates (register/get/list/has, no duplication).
 *
 * No wall clock is read; no side effects happen; everything is immutable.
 */

import { hashString } from "@/lib/hash";
import {
  createNotificationTemplate,
  touchNotificationTemplate,
  type NotificationFormat,
  type NotificationTemplate,
  type NotificationTemplateVariable,
} from "./types";

/** The default variable delimiter markers. */
export const TEMPLATE_OPEN = "{{";
export const TEMPLATE_CLOSE = "}}";

/** A resolved variable reference inside a template. */
export interface TemplateVariableReference {
  /** Dot-path, e.g. "user.name". */
  readonly path: string;
  /** Segments of the path, e.g. ["user", "name"]. */
  readonly segments: readonly string[];
  /** 0-based position of the opening delimiter in the source. */
  readonly start: number;
  /** 0-based position just past the closing delimiter. */
  readonly end: number;
}

/** A parsed template (immutable). */
export interface ParsedTemplate {
  readonly templateId: string;
  readonly source: string;
  readonly references: readonly TemplateVariableReference[];
  /** Whether every reference has a matching declared variable. */
  readonly wellFormed: boolean;
}

/** A compiled template: an id + a pure render function. */
export interface CompiledTemplate {
  readonly id: string;
  /** Render the template against variables (deterministic). */
  render: (variables: Readonly<Record<string, unknown>>) => RenderedTemplate;
}

/** The rendered output of a template. */
export interface RenderedTemplate {
  readonly templateId: string;
  /** Interpolated content in the requested format. */
  readonly content: string;
  /** Interpolated subject (subject templates only). */
  readonly subject?: string;
  /** The format the content was rendered in. */
  readonly format: NotificationFormat;
  /** Variable paths that resolved to a value. */
  readonly resolved: readonly string[];
  /** Variable paths that fell back to a default/empty string. */
  readonly missing: readonly string[];
}

/** A validation issue (well-formedness or variable mismatch). */
export interface TemplateValidationIssue {
  readonly code: "unclosed_reference" | "unknown_variable" | "missing_required" | "empty_body";
  readonly message: string;
  /** The offending variable path, when applicable. */
  readonly path?: string;
}

/** Structured validation result of a template. */
export interface TemplateValidationResult {
  readonly ok: boolean;
  readonly issues: readonly TemplateValidationIssue[];
}

/** Options accepted by {@link validateTemplate}. */
export interface TemplateValidationOptions {
  /** When true, unknown variables are errors (default: true). */
  readonly strictVariables?: boolean;
  /** When true, missing required variables are errors (default: true). */
  readonly strictRequired?: boolean;
}

/** Extract every `{{path}}` reference from `source` (deterministic). */
export function extractTemplateReferences(source: string): readonly TemplateVariableReference[] {
  const references: TemplateVariableReference[] = [];
  let cursor = 0;
  for (;;) {
    const open = source.indexOf(TEMPLATE_OPEN, cursor);
    if (open === -1) break;
    const close = source.indexOf(TEMPLATE_CLOSE, open + TEMPLATE_OPEN.length);
    if (close === -1) break;
    const rawPath = source
      .slice(open + TEMPLATE_OPEN.length, close)
      .trim();
    if (rawPath.length > 0) {
      references.push({
        path: rawPath,
        segments: rawPath.split("."),
        start: open,
        end: close + TEMPLATE_CLOSE.length,
      });
    }
    cursor = close + TEMPLATE_CLOSE.length;
  }
  return Object.freeze(references);
}

/** Whether `source` has an unclosed reference (no matching `}}`). */
export function hasUnclosedReference(source: string): boolean {
  const open = source.indexOf(TEMPLATE_OPEN);
  if (open === -1) return false;
  const close = source.indexOf(TEMPLATE_CLOSE, open + TEMPLATE_OPEN.length);
  return close === -1;
}

/** Parse a template into its references (immutable). */
export function parseTemplate(template: NotificationTemplate): ParsedTemplate {
  const references = extractTemplateReferences(template.body);
  const declared = new Set(template.variables.map((variable) => variable.name));
  return Object.freeze({
    templateId: template.id,
    source: template.body,
    references,
    wellFormed: references.every((reference) => declared.has(reference.path)),
  });
}

/** Look up a dot-path in a variables object (deterministic). */
export function resolveTemplatePath(
  variables: Readonly<Record<string, unknown>>,
  segments: readonly string[],
): unknown {
  let current: unknown = variables;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

/**
 * Resolve a reference to a string value, using declared defaults.
 *
 * Lookup order (deterministic): the flat key `variables["user.name"]`
 * first, then the nested path `variables["user"]["name"]`, then the
 * declared default, then the empty string.
 */
function resolveReference(
  reference: TemplateVariableReference,
  variables: Readonly<Record<string, unknown>>,
  declared: Readonly<Record<string, NotificationTemplateVariable>>,
): { value: string; resolved: boolean } {
  const flat = variables[reference.path];
  if (flat !== undefined && flat !== null) {
    return { value: String(flat), resolved: true };
  }
  const found = resolveTemplatePath(variables, reference.segments);
  if (found !== undefined && found !== null) {
    return { value: String(found), resolved: true };
  }
  const declaration = declared[reference.path];
  if (declaration?.default !== undefined) {
    return { value: declaration.default, resolved: true };
  }
  return { value: "", resolved: false };
}

/** Escape a value for HTML output. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render `template` against `variables` in `format` (deterministic). */
export function renderTemplate(
  template: NotificationTemplate,
  variables: Readonly<Record<string, unknown>>,
  format: NotificationFormat = template.format,
): RenderedTemplate {
  const references = extractTemplateReferences(template.body);
  const declared = Object.fromEntries(
    template.variables.map((variable) => [variable.name, variable]),
  );
  const resolved: string[] = [];
  const missing: string[] = [];
  let content = template.body;
  // Bookkeeping in source order, interpolation right-to-left so earlier
  // replacements never shift later spans.
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const reference = references[index];
    const outcome = resolveReference(reference, variables, declared);
    if (outcome.resolved) {
      resolved.unshift(reference.path);
    } else {
      missing.unshift(reference.path);
    }
    const rendered =
      format === "html" ? escapeHtml(outcome.value) : outcome.value;
    content =
      content.slice(0, reference.start) + rendered + content.slice(reference.end);
  }
  const subject = template.subject
    ? interpolateSubject(template.subject, variables, declared, format)
    : undefined;
  return Object.freeze({
    templateId: template.id,
    content,
    ...(subject !== undefined ? { subject } : {}),
    format,
    resolved: Object.freeze(resolved),
    missing: Object.freeze(missing),
  });
}

/** Interpolate a subject line (same semantics as the body). */
function interpolateSubject(
  subject: string,
  variables: Readonly<Record<string, unknown>>,
  declared: Readonly<Record<string, NotificationTemplateVariable>>,
  format: NotificationFormat,
): string {
  const references = extractTemplateReferences(subject);
  let output = subject;
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const reference = references[index];
    const outcome = resolveReference(reference, variables, declared);
    const rendered = format === "html" ? escapeHtml(outcome.value) : outcome.value;
    output =
      output.slice(0, reference.start) + rendered + output.slice(reference.end);
  }
  return output;
}

/** Validate a template's well-formedness and variables (never throws). */
export function validateTemplate(
  template: NotificationTemplate,
  options: TemplateValidationOptions = {},
): TemplateValidationResult {
  const issues: TemplateValidationIssue[] = [];
  const strictVariables = options.strictVariables ?? true;
  const strictRequired = options.strictRequired ?? true;

  if (template.body.length === 0) {
    issues.push({ code: "empty_body", message: "Template body must not be empty" });
  }
  if (hasUnclosedReference(template.body)) {
    issues.push({
      code: "unclosed_reference",
      message: "Template contains an unclosed {{ reference",
    });
  }

  const declared = new Map(template.variables.map((variable) => [variable.name, variable]));
  const references = extractTemplateReferences(template.body);
  for (const reference of references) {
    if (!declared.has(reference.path)) {
      if (strictVariables) {
        issues.push({
          code: "unknown_variable",
          message: `Template references undeclared variable "{{${reference.path}}}"`,
          path: reference.path,
        });
      }
    } else {
      const declaration = declared.get(reference.path);
      if (strictRequired && declaration?.required === true && declaration.default === undefined) {
        issues.push({
          code: "missing_required",
          message: `Required variable "{{${reference.path}}}" has no default`,
          path: reference.path,
        });
      }
    }
  }

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

/** Compile a template once; renders are pure functions. */
export function compileTemplate(template: NotificationTemplate): CompiledTemplate {
  // Parse eagerly so validation failures surface at compile time, then bind
  // the pure render over the immutable template. Render never re-parses.
  parseTemplate(template);
  return Object.freeze({
    id: template.id,
    render: (variables: Readonly<Record<string, unknown>>): RenderedTemplate =>
      renderTemplate(template, variables, template.format),
  });
}

/** Options accepted by the {@link TemplateRegistry} constructor. */
export interface TemplateRegistryOptions {
  readonly templates?: readonly NotificationTemplate[];
}

/** Deterministic registry hash (content-sensitive). */
export function templateRegistryHash(templates: readonly NotificationTemplate[]): string {
  return hashString(
    templates
      .map((template) => `${template.id}:${template.version}`)
      .join(":"),
  );
}

/**
 * An immutable registry of named templates. `register` returns a successor
 * registry; duplicate ids and duplicate names throw.
 */
export class TemplateRegistry {
  readonly templates: readonly NotificationTemplate[];

  constructor(options: TemplateRegistryOptions = {}) {
    const templates = [...(options.templates ?? [])].map(cloneTemplateRecord);
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const template of templates) {
      if (seenIds.has(template.id)) {
        throw new Error(`Template registry already contains "${template.id}"`);
      }
      if (seenNames.has(template.name)) {
        throw new Error(`Template registry already contains name "${template.name}"`);
      }
      seenIds.add(template.id);
      seenNames.add(template.name);
    }
    this.templates = Object.freeze(templates);
  }

  /** Build a successor registry over `templates`. */
  private next(templates: readonly NotificationTemplate[]): TemplateRegistry {
    return new TemplateRegistry({ templates });
  }

  /** Number of registered templates. */
  count(): number {
    return this.templates.length;
  }

  /** Whether a template with `id` is registered. */
  has(id: string): boolean {
    return this.templates.some((template) => template.id === id);
  }

  /** Whether a template with `name` is registered. */
  hasName(name: string): boolean {
    return this.templates.some((template) => template.name === name);
  }

  /** The registered template with `id`, or `undefined` (detached copy). */
  get(id: string): NotificationTemplate | undefined {
    const template = this.templates.find((candidate) => candidate.id === id);
    return template === undefined ? undefined : cloneTemplateRecord(template);
  }

  /** The registered template with `name`, or `undefined` (detached copy). */
  getByName(name: string): NotificationTemplate | undefined {
    const template = this.templates.find((candidate) => candidate.name === name);
    return template === undefined ? undefined : cloneTemplateRecord(template);
  }

  /** Return a successor registry with `template` registered. */
  register(template: NotificationTemplate): TemplateRegistry {
    if (this.has(template.id)) {
      throw new Error(`Template registry already contains "${template.id}"`);
    }
    if (this.hasName(template.name)) {
      throw new Error(`Template registry already contains name "${template.name}"`);
    }
    return this.next([...this.templates, cloneTemplateRecord(template)]);
  }

  /** Register a template from raw input (single construction path). */
  registerFromInput(input: Parameters<typeof createNotificationTemplate>[0]): TemplateRegistry {
    return this.register(createNotificationTemplate(input));
  }

  /** Return a successor registry without the template `id` (no-op when absent). */
  unregister(id: string): TemplateRegistry {
    if (!this.has(id)) return this;
    return this.next(this.templates.filter((template) => template.id !== id));
  }

  /** Return a successor registry with the template `id` replaced by `template`. */
  replace(template: NotificationTemplate): TemplateRegistry {
    if (!this.has(template.id)) {
      throw new Error(`Template registry does not contain "${template.id}"`);
    }
    return this.next(
      this.templates.map((candidate) => (candidate.id === template.id ? cloneTemplateRecord(template) : candidate)),
    );
  }

  /** Return a successor registry with a patch applied to the template `id`. */
  update(
    id: string,
    patch: Parameters<typeof touchNotificationTemplate>[1],
  ): TemplateRegistry {
    const template = this.get(id);
    if (template === undefined) {
      throw new Error(`Template registry does not contain "${id}"`);
    }
    return this.replace(touchNotificationTemplate(template, patch));
  }

  /** Detached copies of every registered template, in registration order. */
  list(): NotificationTemplate[] {
    return this.templates.map(cloneTemplateRecord);
  }

  /** A deterministic content hash of the registry. */
  hash(): string {
    return templateRegistryHash(this.templates);
  }
}

/** Build a fresh template registry. */
export function createTemplateRegistry(options: TemplateRegistryOptions = {}): TemplateRegistry {
  return new TemplateRegistry(options);
}

/** Detached copy of a template record. */
function cloneTemplateRecord(template: NotificationTemplate): NotificationTemplate {
  return {
    id: template.id,
    name: template.name,
    format: template.format,
    ...(template.subject !== undefined ? { subject: template.subject } : {}),
    body: template.body,
    variables: template.variables.map((variable) => ({ ...variable })),
    version: template.version,
    createdAt: template.createdAt,
  };
}
