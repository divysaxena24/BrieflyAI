import type { IntegrationConfig, McpTool } from "./types";

// ──────────────────────────────────────────────
//  Platform MCP tools (placeholders for now)
// ──────────────────────────────────────────────

export const mcpToolsByPlatform: Record<string, McpTool[]> = {
  gmail: [
    { id: "gmail-read", name: "Read Emails", description: "Read and list emails from your Gmail inbox" },
    { id: "gmail-search", name: "Search Emails", description: "Search across your Gmail messages" },
    { id: "gmail-draft", name: "Draft Email", description: "Compose email drafts with AI assistance" },
    { id: "gmail-send", name: "Send Email", description: "Send emails directly from BrieflyAI" },
  ],
  "google-calendar": [
    { id: "gcal-read", name: "Read Events", description: "Read calendar events and schedules" },
    { id: "gcal-create", name: "Create Event", description: "Create calendar events with AI" },
  ],
  github: [
    { id: "gh-repos", name: "Repositories", description: "Browse and manage GitHub repositories" },
    { id: "gh-prs", name: "Pull Requests", description: "Review and manage pull requests" },
    { id: "gh-issues", name: "Issues", description: "Track and manage GitHub issues" },
    { id: "gh-commits", name: "Commits", description: "View commit history and diffs" },
  ],
  discord: [
    { id: "discord-read", name: "Read Channels", description: "Read Discord channel messages" },
  ],
  telegram: [
    { id: "tg-read", name: "Read Chats", description: "Read Telegram chat messages" },
  ],
  "google-drive": [
    { id: "gdrive-search", name: "Search Files", description: "Search across Drive files and documents" },
    { id: "gdrive-read", name: "Read Documents", description: "Read Google Docs, Sheets, and Slides" },
  ],
};

// ──────────────────────────────────────────────
//  Platform integration configuration
// ──────────────────────────────────────────────

export const integrationPlatforms: IntegrationConfig[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, summarize, and organize your Gmail inbox. AI-powered email classification and daily digests.",
    category: "Email",
    authenticationType: "google-oauth",
    status: "not-connected",
    permissions: "read",
    lastSync: null,
    account: null,
    accentColor: "#ea4335",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Sync calendar events, manage schedules, and get AI-powered meeting reminders.",
    category: "Calendar",
    authenticationType: "google-oauth",
    status: "not-connected",
    permissions: "read",
    lastSync: null,
    account: null,
    accentColor: "#34a853",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Search and read documents, spreadsheets, and presentations from your Drive.",
    category: "Storage",
    authenticationType: "google-oauth",
    status: "not-connected",
    permissions: "read",
    lastSync: null,
    account: null,
    accentColor: "#fbbc04",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Monitor repositories, pull requests, issues, and commits across your projects.",
    category: "Development",
    authenticationType: "oauth",
    status: "not-connected",
    permissions: "read",
    lastSync: null,
    account: null,
    accentColor: "#24292f",
  },
  {
    id: "discord",
    name: "Discord",
    description: "Track community discussions, announcements, and key decisions from your servers.",
    category: "Community",
    authenticationType: "oauth",
    status: "not-connected",
    permissions: "read",
    lastSync: null,
    account: null,
    accentColor: "#5865f2",
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Monitor channels and group chats for updates, announcements, and action items.",
    category: "Messaging",
    authenticationType: "bot-token",
    status: "not-connected",
    permissions: "read",
    lastSync: null,
    account: null,
    accentColor: "#26a5e4",
  },
];
