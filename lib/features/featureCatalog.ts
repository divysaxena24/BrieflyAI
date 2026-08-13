/**
 * Feature catalog — the single source of truth for the AI Features page.
 *
 * Every capability the AI Assistant offers is declared here as data, keyed
 * by the same platform ids used by the integrations config/store
 * (`lib/integrations/config.ts`), so connection status can be derived live
 * from `useIntegrationStatus()`.
 *
 * Status meanings:
 * - "supported"      — works with the current connection
 * - "requires-bot"   — needs a bot credential the current auth cannot provide
 *                      (e.g. reading Discord channels/messages over OAuth)
 * - "requires-setup" — works once extra setup is completed (e.g. adding a
 *                      Telegram bot to a chat)
 * - "coming-soon"    — planned, not yet available
 */

import {
  Mail,
  Inbox,
  Search,
  Star,
  Paperclip,
  FileText,
  MessageSquare,
  PenLine,
  Calendar,
  CalendarDays,
  CalendarRange,
  CalendarClock,
  Clock,
  LayoutList,
  Folder,
  FolderSearch,
  FileSearch,
  FolderOpen,
  Database,
  FolderGit2,
  Activity,
  CircleDot,
  GitPullRequest,
  GitCommit,
  BarChart3,
  Server,
  MessagesSquare,
  Bot,
  ListChecks,
  Send,
} from "lucide-react";
import {
  GmailMailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GithubIcon,
  DiscordIcon,
  TelegramSendIcon,
} from "@/components/dashboard/icons";

/** A Lucide-style icon component (consistent with the dashboard icon surface). */
export type FeatureIcon = React.ComponentType<{ size?: number; className?: string }>;

/** Feature availability status. */
export type FeatureStatus = "supported" | "requires-bot" | "requires-setup" | "coming-soon";

/** A single AI capability shown in the catalog. */
export interface FeatureItem {
  /** Feature name, e.g. "Summarize Inbox". */
  title: string;
  /** One-line description of what it does. */
  description: string;
  /** Availability status. */
  status: FeatureStatus;
  /** Example prompt the user can copy / try in the AI Assistant. */
  prompt: string;
  /** Icon rendered next to the feature. */
  icon: FeatureIcon;
}

/** An info banner shown at the top of an integration card. */
export interface FeatureBanner {
  /** Short banner title. */
  title: string;
  /** Full explanation text. */
  message: string;
}

/** One integration card in the catalog. */
export interface IntegrationFeatureGroup {
  /** Platform id — matches `integrationPlatforms` in lib/integrations/config.ts. */
  id: string;
  /** Display name, e.g. "Gmail". */
  name: string;
  /** Integration description. */
  description: string;
  /** Integration icon. */
  icon: FeatureIcon;
  /** Accent color used for the icon chip. */
  accentColor: string;
  /** Optional informational banner (e.g. Discord bot limitation). */
  banner?: FeatureBanner;
  /** The capabilities offered by this integration. */
  features: FeatureItem[];
}

/** Create a supported feature item with its icon. */
export function supportedFeature(
  title: string,
  description: string,
  prompt: string,
  icon: FeatureIcon,
): FeatureItem {
  return { title, description, status: "supported", prompt, icon };
}

/** Create a bot-required feature item. */
export function botRequiredFeature(
  title: string,
  description: string,
  prompt: string,
  icon: FeatureIcon,
): FeatureItem {
  return { title, description, status: "requires-bot", prompt, icon };
}

/** Create a requires-setup feature item. */
export function requiresSetupFeature(
  title: string,
  description: string,
  prompt: string,
  icon: FeatureIcon,
): FeatureItem {
  return { title, description, status: "requires-setup", prompt, icon };
}

/** Create a coming-soon feature item. */
export function comingSoonFeature(
  title: string,
  description: string,
  prompt: string,
  icon: FeatureIcon,
): FeatureItem {
  return { title, description, status: "coming-soon", prompt, icon };
}

/**
 * The full feature catalog, rendered entirely from this data. Add a new
 * capability here and it appears on the Features page automatically.
 */
export const featureCatalog: readonly IntegrationFeatureGroup[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, summarize, and organize your Gmail inbox with AI-powered email intelligence.",
    icon: GmailMailIcon,
    accentColor: "#ea4335",
    features: [
      supportedFeature("Summarize Inbox", "Get a concise summary of your latest inbox activity and priorities.", "Summarize my inbox", Inbox),
      supportedFeature("Unread Emails", "Find and summarize the emails you haven't read yet.", "Summarize my unread emails", Mail),
      supportedFeature("Search Emails", "Search your inbox for specific senders, topics, or keywords.", "Search emails from Amazon", Search),
      supportedFeature("Important Emails", "Surface important emails and why each one matters.", "Show today's important emails", Star),
      supportedFeature("Recent Emails", "List the most recent emails in your inbox.", "Show my recent emails", MessageSquare),
      supportedFeature("Email Threads", "Summarize an email thread and its decisions.", "Summarize email thread", FileText),
      supportedFeature("Find Attachments", "Locate emails that contain attachments.", "Find emails with attachments", Paperclip),
      supportedFeature("Draft Analysis", "Review a draft for clarity, tone, and completeness.", "Analyze this email draft", PenLine),
    ],
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Manage your schedule, meetings, and free time with AI-powered calendar intelligence.",
    icon: GoogleCalendarIcon,
    accentColor: "#34a853",
    features: [
      supportedFeature("Today's Meetings", "See a chronological run-through of today's meetings.", "What's on my calendar today?", Calendar),
      supportedFeature("Tomorrow's Meetings", "Preview tomorrow's meetings and calls.", "What meetings do I have tomorrow?", CalendarDays),
      supportedFeature("Weekly Schedule", "Get a high-level summary of your week.", "Give me a schedule summary for this week", CalendarRange),
      supportedFeature("Upcoming Events", "List your upcoming events in chronological order.", "What's coming up this week?", CalendarClock),
      supportedFeature("Event Details", "Pull full details for a specific event or meeting.", "What are the details of my next meeting?", Clock),
      supportedFeature("Free Time Detection", "Find open slots in your calendar.", "Am I free after 3 PM?", LayoutList),
    ],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Search and read files, documents, and folders across your Google Drive.",
    icon: GoogleDriveIcon,
    accentColor: "#fbbc04",
    features: [
      supportedFeature("Recent Files", "List your recently modified Drive files.", "Show my recent Drive files", Folder),
      supportedFeature("Search Files", "Find files by name, owner, or topic.", "Search my Drive for roadmaps", FolderSearch),
      supportedFeature("File Summary", "Summarize a document's metadata and contents.", "Summarize this Drive document", FileSearch),
      supportedFeature("Shared Files", "Find files shared with you.", "Show files shared with me", FolderOpen),
      supportedFeature("Large Files", "Surface large files that use the most storage.", "Which Drive files are largest?", Database),
    ],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Monitor repositories, pull requests, issues, and commits across your projects.",
    icon: GithubIcon,
    accentColor: "#24292f",
    features: [
      supportedFeature("Repository Summary", "Summarize a repository's purpose, language, and health.", "Summarize my GitHub repositories", FolderGit2),
      supportedFeature("Recent Activity", "See recent pushes, PRs, and issues in a repository.", "What happened in my briefly repo?", Activity),
      supportedFeature("Open Issues", "Summarize open issues grouped by theme.", "What are the important open GitHub issues?", CircleDot),
      supportedFeature("Pull Requests", "Review recent pull requests and their status.", "Show my recent pull requests", GitPullRequest),
      supportedFeature("Latest Commits", "List the latest commits on a branch.", "Show the latest commits", GitCommit),
      supportedFeature("Repository Statistics", "Get stars, forks, and activity signals for a repo.", "Give me stats for my repository", BarChart3),
    ],
  },
  {
    id: "discord",
    name: "Discord",
    description: "Track community discussions and announcements from the servers you belong to.",
    icon: DiscordIcon,
    accentColor: "#5865f2",
    banner: {
      title: "Discord OAuth limitation",
      message:
        "Discord OAuth only supports reading the servers you belong to. Reading channels and messages requires connecting a Discord Bot.",
    },
    features: [
      supportedFeature("List Servers", "List the Discord servers (guilds) you belong to.", "Show my Discord servers", Server),
      supportedFeature("Summarize Servers", "Summarize your Discord server list and membership.", "Summarize my Discord servers", ListChecks),
      botRequiredFeature("Read Channels", "List the channels in a Discord server.", "Show channels in my Discord server", MessagesSquare),
      botRequiredFeature("Read Messages", "Read recent messages from a Discord channel.", "Show recent Discord messages", MessageSquare),
      botRequiredFeature("Search Messages", "Search messages across Discord channels.", "Search Discord messages for updates", Search),
      botRequiredFeature("Extract Action Items", "Extract action items from Discord conversations.", "Extract action items from Discord", Bot),
    ],
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Monitor channels and group chats for updates, announcements, and action items.",
    icon: TelegramSendIcon,
    accentColor: "#26a5e4",
    banner: {
      title: "Bot setup required",
      message: "Telegram bots can only access chats where the bot has been added or has received a message.",
    },
    features: [
      supportedFeature("List Accessible Chats", "List the chats and groups your bot can access.", "Show my Telegram chats", Send),
      supportedFeature("Recent Messages", "Read the most recent messages from a chat.", "Show me recent Telegram messages", MessageSquare),
      supportedFeature("Search Messages", "Search messages across your accessible chats.", "Search Telegram messages", Search),
    ],
  },
];

/** Platform ids present in the catalog, for connection-status lookups. */
export const CATALOG_PLATFORM_IDS: readonly string[] = featureCatalog.map((group) => group.id);

/** Count every feature across the catalog. */
export function totalFeatureCount(): number {
  return featureCatalog.reduce((total, group) => total + group.features.length, 0);
}

/** Count supported features across the catalog. */
export function supportedFeatureCount(): number {
  return featureCatalog.reduce(
    (total, group) => total + group.features.filter((f) => f.status === "supported").length,
    0,
  );
}
