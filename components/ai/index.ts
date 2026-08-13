/**
 * AI response rendering — reusable, structured response components.
 *
 * The LLM returns markdown; these components parse it into structured
 * sections and render them as polished UI (never raw markdown).
 */
export { ResponseRenderer } from "./ResponseRenderer";
export type { ResponseRendererProps } from "./ResponseRenderer";
export { ResponseHeader } from "./ResponseHeader";
export { SummarySection, SummaryFromParagraphs } from "./SummarySection";
export { InsightSection, splitLabel } from "./InsightSection";
export { ActionSection } from "./ActionSection";
export { InfoList } from "./InfoList";
export { SourceList } from "./SourceList";
export { ErrorState } from "./ErrorState";
export { EmptyState } from "./EmptyState";
export { ExpandableSection } from "./ExpandableSection";
export { AiResponseSkeleton } from "./AiResponseSkeleton";
export { RichText, RichLine } from "./RichText";
export { parseResponse, parseInline } from "./markdown";
export {
  INTEGRATIONS,
  integrationLabel,
  integrationOf,
  toolLabel,
  toolTitle,
  friendlyError,
  isReconnectError,
  emptyMessage,
  noResultsMessage,
} from "./meta";
export type { AISource, ContentBlock, InlineSegment, IntegrationName, ParsedResponse, ParsedSection, SectionKind } from "./types";
