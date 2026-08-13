/**
 * AI response rendering — integration metadata + friendly copy.
 *
 * Centralizes the mapping from tool ids / integration names to icons,
 * colors, titles, and the friendly empty/error messages the renderer shows
 * instead of raw backend errors.
 */

import type { ComponentType } from "react";
import {
  GmailMailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GithubIcon,
  DiscordIcon,
  TelegramSendIcon,
} from "@/components/dashboard/icons";
import type { IntegrationName } from "./types";

export interface IntegrationMeta {
  integration: IntegrationName;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Icon tile background (light + dark). */
  iconBg: string;
  /** Icon color (light + dark). */
  iconColor: string;
  /** Chip colors used for badges. */
  chipBg: string;
  chipColor: string;
}

export const INTEGRATIONS: Record<IntegrationName, IntegrationMeta> = {
  gmail: {
    integration: "gmail",
    label: "Gmail",
    icon: GmailMailIcon,
    iconBg: "bg-red-50 dark:bg-red-950/40",
    iconColor: "text-red-600 dark:text-red-400",
    chipBg: "bg-red-50 dark:bg-red-950/40",
    chipColor: "text-red-600 dark:text-red-400",
  },
  calendar: {
    integration: "calendar",
    label: "Calendar",
    icon: GoogleCalendarIcon,
    iconBg: "bg-emerald-50 dark:bg-emerald-950/40",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    chipBg: "bg-emerald-50 dark:bg-emerald-950/40",
    chipColor: "text-emerald-600 dark:text-emerald-400",
  },
  drive: {
    integration: "drive",
    label: "Drive",
    icon: GoogleDriveIcon,
    iconBg: "bg-amber-50 dark:bg-amber-950/40",
    iconColor: "text-amber-600 dark:text-amber-400",
    chipBg: "bg-amber-50 dark:bg-amber-950/40",
    chipColor: "text-amber-600 dark:text-amber-400",
  },
  github: {
    integration: "github",
    label: "GitHub",
    icon: GithubIcon,
    iconBg: "bg-zinc-100 dark:bg-zinc-800",
    iconColor: "text-zinc-600 dark:text-zinc-300",
    chipBg: "bg-zinc-100 dark:bg-zinc-800",
    chipColor: "text-zinc-600 dark:text-zinc-300",
  },
  discord: {
    integration: "discord",
    label: "Discord",
    icon: DiscordIcon,
    iconBg: "bg-indigo-50 dark:bg-indigo-950/40",
    iconColor: "text-indigo-600 dark:text-indigo-400",
    chipBg: "bg-indigo-50 dark:bg-indigo-950/40",
    chipColor: "text-indigo-600 dark:text-indigo-400",
  },
  telegram: {
    integration: "telegram",
    label: "Telegram",
    icon: TelegramSendIcon,
    iconBg: "bg-sky-50 dark:bg-sky-950/40",
    iconColor: "text-sky-600 dark:text-sky-400",
    chipBg: "bg-sky-50 dark:bg-sky-950/40",
    chipColor: "text-sky-600 dark:text-sky-400",
  },
};

export const INTEGRATION_ORDER: IntegrationName[] = [
  "gmail",
  "calendar",
  "drive",
  "github",
  "discord",
  "telegram",
];

/** Resolve an integration meta from a tool id (e.g. "gmail.summarizeInbox" → gmail). */
export function integrationOf(toolId?: string): IntegrationName | null {
  if (!toolId) return null;
  const prefix = toolId.split(".")[0] as IntegrationName;
  return prefix in INTEGRATIONS ? prefix : null;
}

export function integrationLabel(integration: string | null | undefined): string {
  if (!integration) return "Integration";
  const meta = INTEGRATIONS[integration as IntegrationName];
  return meta ? meta.label : integration;
}

/** Friendly label for a tool id, e.g. "gmail.summarizeInbox" → "Inbox summary". */
export function toolLabel(toolId?: string | null): string {
  if (!toolId) return "AI response";
  const labels: Record<string, string> = {
    "gmail.summarizeInbox": "Inbox Summary",
    "gmail.findImportantEmails": "Important Emails",
    "gmail.findUnreadEmails": "Unread Emails",
    "gmail.searchEmails": "Email Search",
    "gmail.summarizeThread": "Thread Summary",
    "calendar.todaySchedule": "Today's Schedule",
    "calendar.upcomingMeetings": "Upcoming Meetings",
    "calendar.meetingPreparation": "Meeting Prep",
    "calendar.scheduleSummary": "Schedule Summary",
    "drive.searchFiles": "Drive Search",
    "drive.recentFiles": "Recent Files",
    "drive.summarizeDocument": "Document Summary",
    "github.repositorySummary": "Repository Summary",
    "github.recentActivity": "Repository Activity",
    "github.openIssuesSummary": "Open Issues",
    "discord.listGuilds": "Discord Servers",
    "discord.botRequired": "Discord Bot Required",
    "telegram.chatSummary": "Chat Summary",
    "telegram.recentMessages": "Recent Messages",
    "telegram.newsDigest": "News Digest",
  };
  return labels[toolId] ?? toolId;
}

/** Capitalized card title derived from the tool, e.g. "Inbox summary" → "Inbox Summary". */
export function toolTitle(toolId?: string | null): string {
  const label = toolLabel(toolId);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Error codes that mean the user needs to re-establish an integration
 * connection (expired session, revoked token, disconnected platform).
 */
export function isReconnectError(code: string | null | undefined): boolean {
  return [
    "reconnect_required",
    "authentication_required",
    "missing_refresh_token",
    "discord_not_connected",
    "telegram_not_connected",
    "google_not_connected",
    "github_not_connected",
    "token_not_found",
  ].includes(code ?? "");
}

/** Friendly copy per error code — never exposes raw backend errors. */
const CODE_MESSAGES: Record<string, string> = {
  ai_not_configured: "The AI service isn't configured on the server yet.",
  groq_authentication_error:
    "The AI provider rejected the API key — ask an admin to check the server configuration.",
  groq_permission_error:
    "The AI provider blocked this request. The configured model may not be enabled for the project.",
  rate_limited:
    "The AI provider is rate-limiting requests right now. Please try again in a minute.",
  groq_server_error: "The AI provider is having a temporary issue. Please try again shortly.",
  groq_error: "The AI provider couldn't complete the request. Please try again.",
  ai_error: "The AI summary couldn't be generated, but the retrieved data is shown below.",
  invalid_request: "That request couldn't be processed. Please try rephrasing it.",
  no_matching_tool:
    "I couldn't find an AI tool that matches that request. Try something like “Summarize my inbox”.",
  tool_execution_error: "The data couldn't be retrieved from the integration.",
};

/** Suggestions shown alongside "no results" empty states. */
export function emptySuggestions(integration: IntegrationName | null): string[] {
  switch (integration) {
    case "gmail":
      return ["Try searching a sender or subject", "Ask about unread emails"];
    case "calendar":
      return ["Ask about tomorrow", "Ask about next week"];
    case "drive":
      return ["Search “resume”", "Search “CV”", "Search “portfolio”"];
    case "github":
      return ["Ask about open issues", "Ask about recent activity"];
    case "discord":
      return ["Ask about your servers"];
    case "telegram":
      return ["Ask about a specific chat"];
    default:
      return [];
  }
}

/** Friendly empty-state copy per integration. */
export function emptyMessage(integration: IntegrationName | null): string {
  switch (integration) {
    case "gmail":
      return "No matching emails found.";
    case "calendar":
      return "No meetings in that time range — enjoy your free time!";
    case "drive":
      return "Couldn't find any matching Drive files.";
    case "github":
      return "No matching GitHub activity found.";
    case "discord":
      return "Nothing to show for your Discord servers yet.";
    case "telegram":
      return "No Telegram messages to show.";
    default:
      return "Nothing found for that request.";
  }
}

/** Friendly no-match copy when a search tool returns nothing. */
export function noResultsMessage(integration: IntegrationName | null): string {
  switch (integration) {
    case "gmail":
      return "Couldn't find any matching emails.";
    case "drive":
      return "Couldn't find any matching Drive files.";
    case "calendar":
      return "No events matched that search.";
    case "github":
      return "Couldn't find any matching GitHub items.";
    case "discord":
      return "Couldn't find any matching Discord content.";
    case "telegram":
      return "Couldn't find any matching Telegram messages.";
    default:
      return "Couldn't find anything matching that search.";
  }
}

/**
 * Convert a backend error into a friendly message. Never shows raw codes,
 * HTTP statuses, `undefined`/`null`, or stack traces.
 */
export function friendlyError(
  message: string | null | undefined,
  code?: string | null,
  integration?: IntegrationName | null,
): string {
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];

  const raw = (message ?? "").trim();
  // Search tools that legitimately return nothing should read as "no results",
  // not as errors.
  if (raw && /\bno\b.*\b(found|match|results)\b|\bnot\s+found\b|no\s+results/i.test(raw)) {
    return noResultsMessage(integration ?? null);
  }

  // Reject anything that looks like a raw backend artifact.
  const looksRaw =
    !raw ||
    /^(invalid value|not found|undefined|null|error)$/i.test(raw) ||
    /^\d{3}$/.test(raw) ||
    /\b(undefined|null|\[object\s|stack trace|at\s+[A-Za-z].*\(.*:\d+:\d+\))/i.test(raw);
  if (looksRaw) {
    return "Something went wrong while fetching your data. Please try again.";
  }
  return raw;
}
