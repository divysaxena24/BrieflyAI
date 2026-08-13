"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/dashboard";
import { AiSparklesIcon, MessageIcon } from "@/components/dashboard/icons";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

interface SourceRef {
  integration: string;
  type: string;
  id: string;
  title?: string;
  url?: string;
}

interface AIResponseData {
  success: boolean;
  tool: string;
  data: Record<string, unknown>;
  sources: SourceRef[];
  response: string | null;
  note?: string;
  aiError?: { code: string; message: string };
  generatedAt: string;
}

type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool?: string;
      sources?: SourceRef[];
      note?: string;
      aiError?: { code: string; message: string };
      error?: string;
      /** Machine-readable error code from the API (e.g. reconnect_required). */
      errorCode?: string;
    };

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/** Friendly label for an integration family. */
/**
 * Error codes that mean the user needs to re-establish an integration
 * connection (expired session, revoked token, disconnected platform).
 */
function isReconnectError(code: string): boolean {
  return [
    "reconnect_required",
    "authentication_required",
    "missing_refresh_token",
    "discord_not_connected",
    "telegram_not_connected",
    "google_not_connected",
    "github_not_connected",
    "token_not_found",
  ].includes(code);
}

function integrationLabel(integration: string): string {
  const labels: Record<string, string> = {
    gmail: "Gmail",
    calendar: "Calendar",
    drive: "Drive",
    github: "GitHub",
    discord: "Discord",
    telegram: "Telegram",
  };
  return labels[integration] ?? integration;
}

/** Friendly label for a tool id, e.g. "gmail.summarizeInbox". */
function toolLabel(toolId: string): string {
  const labels: Record<string, string> = {
    "gmail.summarizeInbox": "Inbox summary",
    "gmail.findImportantEmails": "Important emails",
    "gmail.findUnreadEmails": "Unread emails",
    "gmail.searchEmails": "Email search",
    "gmail.summarizeThread": "Thread summary",
    "calendar.todaySchedule": "Today's schedule",
    "calendar.upcomingMeetings": "Upcoming meetings",
    "calendar.meetingPreparation": "Meeting prep",
    "calendar.scheduleSummary": "Schedule summary",
    "drive.searchFiles": "Drive search",
    "drive.recentFiles": "Recent files",
    "drive.summarizeDocument": "Document summary",
    "github.repositorySummary": "Repository summary",
    "github.recentActivity": "Repository activity",
    "github.openIssuesSummary": "Open issues",
    "discord.listGuilds": "Discord servers",
    "discord.botRequired": "Discord bot required",
    "telegram.chatSummary": "Chat summary",
    "telegram.recentMessages": "Recent messages",
    "telegram.newsDigest": "News digest",
  };
  return labels[toolId] ?? toolId;
}

const SUGGESTIONS = [
  "Summarize my inbox",
  "What's on my calendar today?",
  "What meetings do I have tomorrow?",
  "Prepare me for my next meeting",
  "Find my recent Drive files",
  "What are the important open GitHub issues?",
  "Which Discord servers am I in?",
  "Summarize my Discord servers",
  "Summarize my Telegram updates",
];

// ──────────────────────────────────────────────
//  Component
// ──────────────────────────────────────────────

export default function AiChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Pre-fill the input from ?q=… (e.g. the Features page "Try Now" links),
  // so the user can review and send the suggested prompt.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q")?.trim();
    if (q) setInput(q);
  }, []);

  const send = async (text?: string) => {
    const query = (text ?? input).trim();
    if (!query || isLoading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: query }]);
    setIsLoading(true);
    setActiveTool(null);

    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: query }),
      });
      const payload = (await res.json()) as {
        success?: boolean;
        message?: string;
        data?: AIResponseData;
        errors?: Array<{ message?: string; code?: string }>;
      };

      if (!res.ok || !payload.success || !payload.data) {
        const detail = payload.errors?.[0]?.message ?? payload.message ?? "Something went wrong.";
        const code = payload.errors?.[0]?.code;
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "", error: detail, errorCode: code },
        ]);
        return;
      }

      const data = payload.data;
      setActiveTool(data.tool);
      const responseText =
        data.response ?? "I retrieved the data but couldn't summarize it right now.";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: responseText,
          tool: data.tool,
          sources: data.sources ?? [],
          note: data.note,
          aiError: data.aiError,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "",
          error: err instanceof Error ? err.message : "Network error — please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="AI Assistant"
        description="Ask about your connected integrations — your inbox, calendar, Drive, GitHub, Discord, and Telegram."
        badge="Groq-powered"
      />

      <div className="flex h-[calc(100vh-15rem)] min-h-[28rem] flex-col overflow-hidden rounded-3xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
        {/* ── Messages ── */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          {messages.length === 0 && !isLoading && (
            <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-4 py-12 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-brand-600 via-brand-500 to-accent-500 text-white shadow-lg shadow-brand-500/25">
                <MessageIcon size={24} className="h-6 w-6" />
              </div>
              <div>
                <p className="text-base font-bold text-zinc-900 dark:text-white">
                  Ask anything about your integrations
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  I&apos;ll pick the right tool, fetch your real data, and summarize it for you.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => void send(suggestion)}
                    className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-all hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:border-brand-700 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, index) => (
            <ChatBubble key={index} message={message} />
          ))}

          {isLoading && (
            <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
              <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500 [animation-delay:150ms]" />
              <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500 [animation-delay:300ms]" />
              <span>{activeTool ? `Running ${toolLabel(activeTool)}…` : "Finding the right tool…"}</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* ── Input ── */}
        <div className="border-t border-zinc-200/80 bg-zinc-50/60 p-3 dark:border-zinc-800/80 dark:bg-zinc-900/60 sm:p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder="Ask about your inbox, calendar, Drive, GitHub, Discord, or Telegram…"
              className="max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 shadow-sm transition-all focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-brand-400"
            />
            <button
              type="submit"
              disabled={isLoading || input.trim().length === 0}
              className="inline-flex h-11 shrink-0 items-center gap-2 rounded-2xl bg-brand-600 px-4 text-xs font-bold text-white shadow-md shadow-brand-600/20 transition-all hover:bg-brand-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-brand-500 dark:hover:bg-brand-400"
            >
              <AiSparklesIcon size={16} className="h-4 w-4" />
              Send
            </button>
          </form>
          <p className="mt-2 px-1 text-[11px] text-zinc-400 dark:text-zinc-500">
            AI responses are generated from your real connected data. Connect integrations in{" "}
            <Link href="/dashboard/integrations" className="font-semibold text-brand-600 hover:underline dark:text-brand-400">
              Integrations
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
//  Chat bubble
// ──────────────────────────────────────────────

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-md shadow-brand-600/15 dark:bg-brand-500">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.error) {
    const needsReconnect = isReconnectError(message.errorCode ?? "");
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          <p className="font-bold">Something went wrong</p>
          <p className="mt-0.5 text-xs">{message.error}</p>
          {needsReconnect && (
            <Link
              href="/dashboard/integrations"
              className="mt-2 inline-flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1.5 text-[11px] font-bold text-white transition-colors hover:bg-red-500"
            >
              Reconnect integrations
            </Link>
          )}
        </div>
      </div>
    );
  }

  // Discord channel/message requests are answered with the canned
  // "Discord Bot Required" explanation — show it as a friendly info card
  // (the integration itself is healthy, so no reconnect prompt is shown).
  if (message.tool === "discord.botRequired") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-sky-200 bg-sky-50/80 px-4 py-3.5 text-sm text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-100">
          <p className="font-bold">Discord Bot Required</p>
          <p className="mt-1.5 text-xs leading-relaxed">{message.content}</p>
          <p className="mt-3 text-xs font-semibold">BrieflyAI currently supports:</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            <li>✓ Listing your Discord servers</li>
            <li>✓ Server summaries</li>
          </ul>
          <p className="mt-2 text-[11px] text-sky-700/80 dark:text-sky-300/80">
            Reading messages requires the BrieflyAI Discord Bot, which is not yet available.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        <div className="rounded-2xl rounded-bl-md border border-zinc-200/80 bg-zinc-50 px-4 py-3 text-sm leading-relaxed text-zinc-800 shadow-sm dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-100">
          {message.content.split("\n").map((line, index) =>
            line.length === 0 ? (
              <div key={index} className="h-2" />
            ) : (
              <p key={index}>{line}</p>
            ),
          )}
          {message.aiError && (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
              Note: AI summarization was unavailable ({message.aiError.message}), so you&apos;re
              seeing the raw data.
            </p>
          )}
          {message.note && (
            <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{message.note}</p>
          )}
        </div>

        {/* Tool + sources chip */}
        {(message.tool || (message.sources && message.sources.length > 0)) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
            {message.tool && (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
                <AiSparklesIcon size={11} className="h-3 w-3" />
                {toolLabel(message.tool)}
              </span>
            )}
            {message.sources?.map((source) => (
              <SourceChip key={`${source.integration}:${source.id}`} source={source} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Small chip showing a source reference. */
function SourceChip({ source }: { source: SourceRef }) {
  const body = (
    <>
      <span className="font-bold">{integrationLabel(source.integration)}</span>
      {source.title ? ` · ${source.title}` : ` · ${source.type}`}
    </>
  );
  const className =
    "inline-flex max-w-[16rem] items-center gap-1 truncate rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] text-zinc-600 transition-colors hover:border-brand-300 hover:text-brand-700 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-300 dark:hover:border-brand-700 dark:hover:text-brand-300";
  if (source.url) {
    return (
      <a href={source.url} target="_blank" rel="noreferrer" className={className} title={source.title}>
        {body}
      </a>
    );
  }
  return <span className={className}>{body}</span>;
}
