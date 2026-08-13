/**
 * AI layer — deterministic query router.
 *
 * Maps a natural-language request to an AI tool. This is the guaranteed,
 * no-LLM fallback used when the Groq-backed planner is unavailable, and it
 * also seeds the orchestrator's tool set. First match wins; keywords are
 * matched against a lowercased query.
 *
 * Tools whose inputs the router cannot fill (e.g. `gmail.summarizeThread`
 * needs a thread id) are not routed from free-form text — the Groq planner
 * may still select them when the input is present in the query.
 */

export interface ToolRoute {
  /** The tool id to invoke. */
  toolId: string;
  /** Input for the tool (validated later against its schema). */
  input: Record<string, unknown>;
}

const has = (query: string, ...terms: string[]): boolean =>
  terms.some((term) => query.includes(term));

/** Extract a repository slug ("owner/repo") from a query, if present. */
function extractRepository(query: string): string | undefined {
  const match = query.match(/[\w.-]+\/[\w.-]+/);
  return match ? match[0] : undefined;
}

/** Extract a trailing search topic after the verbs (e.g. "find emails about X"). */
function extractTopic(query: string): string {
  const cleaned = query
    .replace(/\b(please|can you|could you|show me|give me|tell me|help me|i need|need)\b/g, "")
    .replace(/\b(search|find|look for|look up|get)\b/g, "")
    .replace(
      /\b(emails?|mail|inbox|gmail|messages?|files?|documents?|drive|github|repo|discord|telegram|about|for|regarding|related to|on|my|your|the)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

/**
 * Route a query to a tool. Returns `null` when no rule matches.
 */
export function routeQuery(query: string): ToolRoute | null {
  const q = query.toLowerCase();

  // ── Gmail ───────────────────────────────────────────
  const isEmailContext = has(q, "email") || has(q, "mail") || has(q, "inbox") || has(q, "gmail");
  if (has(q, "unread") && isEmailContext) {
    return { toolId: "gmail.findUnreadEmails", input: {} };
  }
  if (has(q, "important") && isEmailContext) {
    return { toolId: "gmail.findImportantEmails", input: {} };
  }
  if (has(q, "inbox")) {
    return { toolId: "gmail.summarizeInbox", input: {} };
  }
  if (has(q, "summarize") && (has(q, "inbox") || has(q, "my emails") || has(q, "email"))) {
    return { toolId: "gmail.summarizeInbox", input: {} };
  }
  if (has(q, "search", "find") && isEmailContext) {
    const topic = extractTopic(q);
    if (topic) {
      return { toolId: "gmail.searchEmails", input: { query: topic } };
    }
    return { toolId: "gmail.searchEmails", input: { query: q } };
  }
  // thread id pattern: "summarize thread abc123"
  if (has(q, "thread")) {
    const idMatch = q.match(/thread[\s:=]+([a-z0-9]+)/i) ?? q.match(/\b([a-z0-9]{10,})\b/);
    if (idMatch) {
      return { toolId: "gmail.summarizeThread", input: { threadId: idMatch[1] } };
    }
    return null;
  }

  // ── Calendar ────────────────────────────────────────
  if (has(q, "prepare") && (has(q, "meeting") || has(q, "call"))) {
    return { toolId: "calendar.meetingPreparation", input: {} };
  }
  if (has(q, "today") && (has(q, "schedule") || has(q, "calendar") || has(q, "meeting") || has(q, "agenda"))) {
    return { toolId: "calendar.todaySchedule", input: {} };
  }
  if (has(q, "summary") && (has(q, "schedule") || has(q, "calendar") || has(q, "week"))) {
    return { toolId: "calendar.scheduleSummary", input: {} };
  }
  if (has(q, "upcoming") || has(q, "next") || has(q, "tomorrow") || has(q, "this week") || has(q, "meetings")) {
    if (has(q, "meeting") || has(q, "call") || has(q, "appointment") || has(q, "schedule") || has(q, "calendar")) {
      const days = has(q, "tomorrow") ? 2 : has(q, "this week") ? 7 : 7;
      return { toolId: "calendar.upcomingMeetings", input: { days } };
    }
  }

  // ── Drive ───────────────────────────────────────────
  if (has(q, "recent") && (has(q, "file") || has(q, "drive") || has(q, "document"))) {
    return { toolId: "drive.recentFiles", input: {} };
  }
  if (has(q, "summarize") && (has(q, "document") || has(q, "file"))) {
    return { toolId: "drive.summarizeDocument", input: {} };
  }
  if (has(q, "drive") && (has(q, "search") || has(q, "find") || has(q, "looking"))) {
    const topic = extractTopic(q);
    if (topic) return { toolId: "drive.searchFiles", input: { query: topic } };
  }

  // ── GitHub ──────────────────────────────────────────
  const repository = extractRepository(q);
  if (has(q, "github") || has(q, "repo") || repository) {
    if (has(q, "issue")) {
      return { toolId: "github.openIssuesSummary", input: repository ? { repository } : {} };
    }
    if (has(q, "activity") || has(q, "what happened") || has(q, "recent")) {
      return { toolId: "github.recentActivity", input: repository ? { repository } : {} };
    }
    if (has(q, "summary") || has(q, "summarize") || has(q, "overview") || has(q, "about")) {
      return { toolId: "github.repositorySummary", input: repository ? { repository } : {} };
    }
  }

  // ── Discord ─────────────────────────────────────────
  // Discord's OAuth connection can only list the user's servers (guilds).
  // Reading channels/messages is bot-only, so those requests are answered
  // with the canned "Discord Bot Required" explanation instead of an
  // unsupported tool call (which would 401 + trigger a false reconnect).
  const isChannelMention = /#[a-z0-9_-]+/.test(q);
  const isDiscordContext =
    has(q, "discord") || isChannelMention || has(q, "server") || has(q, "guild");
  if (isDiscordContext) {
    // Channel/message reads are bot-only — answer with the canned explanation
    // (word-boundary matching so e.g. "ready"/"/recently" don't misfire).
    const wantsMessages =
      isChannelMention ||
      has(
        q,
        "message",
        "messages",
        "channel",
        "channels",
        "conversation",
        "conversations",
        "action item",
        "action items",
        "todo",
        "unread",
        "what happened",
      ) ||
      /\b(read|recent|activity|chat|chats)\b/.test(q);
    if (wantsMessages) {
      return { toolId: "discord.botRequired", input: {} };
    }
    // Supported: the user's Discord server (guild) list.
    if (has(q, "server", "servers", "guild", "guilds", "joined", "am i in", "member", "which", "summary", "summarize")) {
      return { toolId: "discord.listGuilds", input: {} };
    }
    // A bare Discord mention with no clear channel intent — list the servers.
    return { toolId: "discord.listGuilds", input: {} };
  }

  // ── Telegram ────────────────────────────────────────
  if (has(q, "telegram")) {
    if (has(q, "digest") || has(q, "news") || has(q, "update")) {
      return { toolId: "telegram.newsDigest", input: {} };
    }
    if (has(q, "summary") || has(q, "summarize") || has(q, "what happened")) {
      return { toolId: "telegram.chatSummary", input: {} };
    }
    if (has(q, "message") || has(q, "recent") || has(q, "activity")) {
      return { toolId: "telegram.recentMessages", input: {} };
    }
  }

  return null;
}
