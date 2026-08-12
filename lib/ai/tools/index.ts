/**
 * AI layer — AI tools composition.
 *
 * `createAITools()` returns all 20 integration AI tools (Gmail, Calendar,
 * Drive, GitHub, Discord, Telegram) in a fixed order, each wrapping the
 * existing production service. `createAIToolRegistry()` wraps them in the
 * existing immutable `ToolRegistry`.
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
import {
  DiscordChannelSummaryTool,
  DiscordRecentMessagesTool,
  DiscordExtractActionItemsTool,
} from "./discordTools";
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
  "discord.channelSummary",
  "discord.recentMessages",
  "discord.extractActionItems",
  // Telegram
  "telegram.chatSummary",
  "telegram.recentMessages",
  "telegram.newsDigest",
] as const;

/** Create the 20 AI tools, each with its production service default. */
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
    new DiscordChannelSummaryTool(),
    new DiscordRecentMessagesTool(),
    new DiscordExtractActionItemsTool(),
    // Telegram
    new TelegramChatSummaryTool(),
    new TelegramRecentMessagesTool(),
    new TelegramNewsDigestTool(),
  ];
}

/** Build a registry containing exactly the 20 AI tools. */
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
  DiscordChannelSummaryTool,
  DiscordRecentMessagesTool,
  DiscordExtractActionItemsTool,
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
export type { DiscordToolService, ResolvedChannel } from "./discordTools";
export type { TelegramToolService, ResolvedChat } from "./telegramTools";
