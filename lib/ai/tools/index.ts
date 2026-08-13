/**
 * AI layer — AI tools composition.
 *
 * `createAITools()` returns all integration AI tools (Gmail, Calendar,
 * Drive, GitHub, Discord, Telegram) in a fixed order, each wrapping the
 * existing production service. `createAIToolRegistry()` wraps them in the
 * existing immutable `ToolRegistry`.
 *
 * Discord exposes only OAuth-supported capabilities (listing the user's
 * servers) plus a canned "Discord Bot Required" explanation for channel /
 * message reads, which need a bot token that OAuth does not provide.
 *
 * The tools are pure data retrieval + normalization; the Groq natural-language
 * summaries are produced by the orchestrator.
 *
 * Named re-exports only — `export *` is avoided here because several tool
 * modules export same-named helpers (e.g. `toEventSummary`,
 * `toMessageSummary`) that would collide in a barrel.
 */

import type { Tool } from "@/lib/tools/types";
import { ToolRegistry } from "@/lib/tools/registry";
import {
  GmailSummarizeInboxTool,
  GmailFindImportantEmailsTool,
  GmailFindUnreadEmailsTool,
  GmailSearchEmailsTool,
  GmailSummarizeThreadTool,
} from "./gmailTools";
import {
  CalendarTodayScheduleTool,
  CalendarUpcomingMeetingsTool,
  CalendarMeetingPreparationTool,
  CalendarScheduleSummaryTool,
} from "./calendarTools";
import {
  DriveSearchFilesTool,
  DriveRecentFilesTool,
  DriveSummarizeDocumentTool,
} from "./driveTools";
import {
  GitHubRepositorySummaryTool,
  GitHubRecentActivityTool,
  GitHubOpenIssuesSummaryTool,
} from "./githubTools";
import { DiscordListGuildsTool, DiscordBotRequiredTool } from "./discordTools";
import {
  TelegramChatSummaryTool,
  TelegramRecentMessagesTool,
  TelegramNewsDigestTool,
} from "./telegramTools";

/** All AI tool ids, in registration order. */
export const AI_TOOL_IDS: readonly string[] = [
  // Gmail
  "gmail.summarizeInbox",
  "gmail.findImportantEmails",
  "gmail.findUnreadEmails",
  "gmail.searchEmails",
  "gmail.summarizeThread",
  // Calendar
  "calendar.todaySchedule",
  "calendar.upcomingMeetings",
  "calendar.meetingPreparation",
  "calendar.scheduleSummary",
  // Drive
  "drive.searchFiles",
  "drive.recentFiles",
  "drive.summarizeDocument",
  // GitHub
  "github.repositorySummary",
  "github.recentActivity",
  "github.openIssuesSummary",
  // Discord
  "discord.listGuilds",
  "discord.botRequired",
  // Telegram
  "telegram.chatSummary",
  "telegram.recentMessages",
  "telegram.newsDigest",
] as const;

/** Create the AI tools, each with its production service default. */
export function createAITools(): readonly Tool[] {
  return [
    // Gmail
    new GmailSummarizeInboxTool(),
    new GmailFindImportantEmailsTool(),
    new GmailFindUnreadEmailsTool(),
    new GmailSearchEmailsTool(),
    new GmailSummarizeThreadTool(),
    // Calendar
    new CalendarTodayScheduleTool(),
    new CalendarUpcomingMeetingsTool(),
    new CalendarMeetingPreparationTool(),
    new CalendarScheduleSummaryTool(),
    // Drive
    new DriveSearchFilesTool(),
    new DriveRecentFilesTool(),
    new DriveSummarizeDocumentTool(),
    // GitHub
    new GitHubRepositorySummaryTool(),
    new GitHubRecentActivityTool(),
    new GitHubOpenIssuesSummaryTool(),
    // Discord
    new DiscordListGuildsTool(),
    new DiscordBotRequiredTool(),
    // Telegram
    new TelegramChatSummaryTool(),
    new TelegramRecentMessagesTool(),
    new TelegramNewsDigestTool(),
  ];
}

/** Build a registry containing exactly the AI tools. */
export function createAIToolRegistry(): ToolRegistry {
  return new ToolRegistry(createAITools());
}

export * from "./types";

// Tool classes.
export {
  GmailSummarizeInboxTool,
  GmailFindImportantEmailsTool,
  GmailFindUnreadEmailsTool,
  GmailSearchEmailsTool,
  GmailSummarizeThreadTool,
  CalendarTodayScheduleTool,
  CalendarUpcomingMeetingsTool,
  CalendarMeetingPreparationTool,
  CalendarScheduleSummaryTool,
  DriveSearchFilesTool,
  DriveRecentFilesTool,
  DriveSummarizeDocumentTool,
  GitHubRepositorySummaryTool,
  GitHubRecentActivityTool,
  GitHubOpenIssuesSummaryTool,
  DiscordListGuildsTool,
  DiscordBotRequiredTool,
  TelegramChatSummaryTool,
  TelegramRecentMessagesTool,
  TelegramNewsDigestTool,
};

// Tool service interfaces (unique names — safe to re-export).
export type { GmailToolService } from "./gmailTools";
export type {
  CalendarToolService,
  TodayScheduleInput,
  UpcomingMeetingsInput,
  MeetingPreparationInput,
  ScheduleSummaryInput,
} from "./calendarTools";
export type { DriveToolService } from "./driveTools";
export type { GitHubToolService, ResolvedRepository } from "./githubTools";
export type { DiscordToolService } from "./discordTools";
export type { TelegramToolService, ResolvedChat } from "./telegramTools";
