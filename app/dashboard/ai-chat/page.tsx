"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { useIntegrationStatus } from "@/lib/integrations/store";
import {
  AiResponseSkeleton,
  ErrorState,
  ResponseRenderer,
  INTEGRATIONS,
  INTEGRATION_ORDER,
  integrationOf,
  toolLabel,
} from "@/components/ai";
import type { AISource, IntegrationName } from "@/components/ai";
import {
  AiSparklesIcon,
  ArrowUpIcon,
  BookmarkIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileDownIcon,
  MicIcon,
  PaperclipIcon,
  RefreshCwIcon,
  ShareIcon,
} from "@/components/dashboard/icons";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

interface AIResponseData {
  success: boolean;
  tool: string;
  data: Record<string, unknown>;
  sources: AISource[];
  response: string | null;
  note?: string;
  aiError?: { code: string; message: string };
  generatedAt: string;
}

type ChatMessage =
  | { role: "user"; content: string; createdAt: string }
  | {
      role: "assistant";
      content: string;
      createdAt: string;
      tool?: string;
      sources?: AISource[];
      data?: Record<string, unknown>;
      note?: string;
      aiError?: { code: string; message: string };
      error?: string;
      /** Machine-readable error code from the API (e.g. reconnect_required). */
      errorCode?: string;
    };

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

/** Status shown while a request is in flight (cycled through). */
const LOADING_STAGES = [
  "Finding the right tool…",
  "Connecting to your data…",
  "Reading your latest updates…",
  "Generating summary…",
];

/** localStorage key for user-saved summaries (client-side only). */
const SAVED_SUMMARIES_KEY = "brieflyai.savedSummaries";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ──────────────────────────────────────────────
//  Page
// ──────────────────────────────────────────────

export default function AiChatPage() {
  const { platforms } = useIntegrationStatus();

  const connectedCount = platforms.filter(
    (p) => p.status === "connected" || p.status === "syncing",
  ).length;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [loadingStage, setLoadingStage] = useState(0);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-scroll to the newest message whenever the conversation changes.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  // Cycle the loading status text while a request runs.
  useEffect(() => {
    if (!isLoading) {
      setLoadingStage(0);
      return;
    }
    const id = setInterval(
      () => setLoadingStage((stage) => (stage + 1) % LOADING_STAGES.length),
      1700,
    );
    return () => clearInterval(id);
  }, [isLoading]);

  // "Back to latest" appears once the user scrolls away from the bottom.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight > 160);
  }, []);

  const scrollToLatest = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  // "/" focuses the input anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (event.key === "/" && tag !== "textarea" && tag !== "input" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Pre-fill the input from ?q=… (e.g. the Features page "Try Now" links).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q")?.trim();
    if (q) setInput(q);
  }, []);

  const send = async (text?: string) => {
    const query = (text ?? input).trim();
    if (!query || isLoading) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setMessages((prev) => [...prev, { role: "user", content: query, createdAt: new Date().toISOString() }]);
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
          { role: "assistant", content: "", createdAt: new Date().toISOString(), error: detail, errorCode: code },
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
          createdAt: new Date().toISOString(),
          tool: data.tool,
          sources: data.sources ?? [],
          data: data.data,
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
          createdAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : "Network error — please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const openSources = useCallback((index: number) => {
    document.getElementById(`assistant-${index}`)?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {/*
        The page is a flex column sized to exactly fill the viewport below the
        app header, so the composer hugs the bottom edge (24–40px above it via
        the layout padding + pb-2) and the conversation expands to fill all
        remaining space — like ChatGPT / Claude / Cursor.
      */}
      <div className="flex h-[calc(100dvh-6rem)] min-h-[20rem] flex-col pb-2 sm:h-[calc(100dvh-7rem)] lg:h-[calc(100dvh-8rem)]">
        {/* ── Compact header ── */}
        <header className="flex shrink-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="ai-orb flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white shadow-lg shadow-brand-500/30">
              <AiSparklesIcon size={20} className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
                  AI Assistant
                </h1>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100/80 px-2.5 py-1 text-[11px] font-bold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  </span>
                  AI Ready
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-zinc-500 sm:text-[13px] dark:text-zinc-400">
                Ask anything about your connected apps
              </p>
            </div>
          </div>

          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
              {connectedCount} Integrations Connected
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              <AiSparklesIcon size={12} className="h-3 w-3 text-violet-500" />
              Groq Powered
            </span>
          </div>
        </header>


        {/* ── Conversation (fills remaining height) ── */}
        <div className="relative mt-3 min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="chat-scroll absolute inset-0 overflow-y-auto px-1 sm:px-2"
            role="log"
            aria-label="Conversation"
          >
            {/*
              min-h-full + flex column lets the empty state stretch to the
              bottom, pinning its suggested prompts just above the composer.
              With messages present the wrapper stays top-aligned and scrolls.
            */}
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col space-y-6 px-1 py-3 sm:py-4">
              {messages.length === 0 && !isLoading && (
                <EmptyConversation
                  suggestions={SUGGESTIONS}
                  onPick={(suggestion) => void send(suggestion)}
                />
              )}

              {messages.map((message, index) => {
                // Query that produced this assistant message (for regenerate).
                let regenerateQuery: string | null = null;
                if (message.role === "assistant") {
                  for (let i = index - 1; i >= 0; i--) {
                    if (messages[i].role === "user") {
                      regenerateQuery = messages[i].content;
                      break;
                    }
                  }
                }
                return (
                  <ChatBubble
                    key={index}
                    index={index}
                    message={message}
                    onRegenerate={
                      regenerateQuery
                        ? () => {
                            void send(regenerateQuery as string);
                          }
                        : undefined
                    }
                    onOpenSources={() => openSources(index)}
                  />
                );
              })}

              {isLoading && (
                <AiResponseSkeleton label={activeTool ? `Using ${toolLabel(activeTool)}…` : LOADING_STAGES[loadingStage]} />
              )}

              <div ref={bottomRef} className="h-px" aria-hidden="true" />
            </div>
          </div>

          {/* Back to latest */}
          <AnimatePresence>
            {showLatest && (
              <motion.button
                type="button"
                initial={{ opacity: 0, y: 8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                onClick={scrollToLatest}
                aria-label="Scroll to latest message"
                className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white/90 px-3.5 py-2 text-[11px] font-bold text-zinc-600 shadow-lg shadow-zinc-900/5 backdrop-blur transition-colors hover:text-brand-600 dark:border-zinc-700 dark:bg-zinc-800/90 dark:text-zinc-300 dark:hover:text-brand-300"
              >
                <ArrowUpIcon size={12} className="h-3 w-3 rotate-180" />
                Latest
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* ── Chat composer (anchored at bottom) ── */}
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={() => void send()}
          disabled={isLoading}
          ref={inputRef}
        />
      </div>
    </MotionConfig>
  );
}

// ──────────────────────────────────────────────
//  Empty conversation
// ──────────────────────────────────────────────

function EmptyConversation({
  suggestions,
  onPick,
}: {
  suggestions: string[];
  onPick: (suggestion: string) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex min-h-full flex-1 flex-col"
    >
      {/* Greeting — centered in the space above the suggested prompts. */}
      <div className="flex flex-1 flex-col items-center justify-center px-2 pt-4 text-center">
        <div className="relative">
          <div className="absolute -inset-7 rounded-full bg-brand-500/15 blur-2xl" aria-hidden="true" />
          <div className="ai-orb relative flex h-16 w-16 items-center justify-center rounded-[22px] text-white shadow-xl shadow-brand-500/30">
            <AiSparklesIcon size={28} className="h-7 w-7" />
          </div>
        </div>

        <h2 className="mt-6 text-2xl font-black tracking-tight text-zinc-900 sm:text-3xl dark:text-white">
          What can I help you with today?
        </h2>
        <p className="mt-2.5 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
          I&apos;ll pick the right tool, fetch your real data, and summarize it for you.
        </p>
      </div>

      {/* Suggested prompts — pinned just above the composer (~24px gap). */}
      <div className="flex justify-center px-2">
        <div className="flex max-w-xl flex-wrap items-center justify-center gap-2">
          {suggestions.map((suggestion, index) => (
            <motion.button
              key={suggestion}
              type="button"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.1 + index * 0.04 }}
              onClick={() => onPick(suggestion)}
              className="group inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-600 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-700 hover:shadow-md active:translate-y-0 active:scale-95 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-brand-700 dark:hover:bg-brand-950/30 dark:hover:text-brand-300"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-r from-brand-500 to-violet-500 transition-transform duration-200 group-hover:scale-125" />
              {suggestion}
            </motion.button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ──────────────────────────────────────────────
//  Chat bubble
// ──────────────────────────────────────────────

function ChatBubble({
  index,
  message,
  onRegenerate,
  onOpenSources,
}: {
  index: number;
  message: ChatMessage;
  onRegenerate?: () => void;
  onOpenSources: () => void;
}) {
  if (message.role === "user") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex justify-end"
      >
        <div className="max-w-[85%] [overflow-wrap:anywhere] rounded-3xl rounded-br-md bg-gradient-to-br from-brand-600 to-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-md shadow-brand-600/25 sm:max-w-[75%]">
          {message.content}
        </div>
      </motion.div>
    );
  }

  const integration = integrationOf(message.tool);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      id={`assistant-${index}`}
      className="flex scroll-mt-4 items-start gap-3"
    >
      {/* Orb avatar */}
      <div className="ai-orb mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-md shadow-brand-500/30">
        <AiSparklesIcon size={16} className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-2 px-1">
          <span className="text-xs font-bold text-zinc-700 dark:text-zinc-200">BrieflyAI</span>
          {message.tool && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
              <AiSparklesIcon size={10} className="h-2.5 w-2.5" />
              {toolLabel(message.tool)}
            </span>
          )}
          {message.createdAt && (
            <time className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
              {formatTime(message.createdAt)}
            </time>
          )}
        </div>

        {message.error ? (
          <ErrorState
            message={message.error}
            code={message.errorCode}
            integration={integration}
          />
        ) : message.tool === "discord.botRequired" ? (
          <div className="rounded-3xl rounded-tl-md border border-sky-200 bg-sky-50/80 px-4 py-3.5 text-sm text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-100">
            <p className="font-bold">Discord Bot Required</p>
            <p className="mt-1.5 text-xs leading-relaxed [overflow-wrap:anywhere]">{message.content}</p>
            <p className="mt-3 text-xs font-semibold">BrieflyAI currently supports:</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              <li>✓ Listing your Discord servers</li>
              <li>✓ Server summaries</li>
            </ul>
            <p className="mt-2 text-[11px] text-sky-700/80 dark:text-sky-300/80">
              Reading messages requires the BrieflyAI Discord Bot, which is not yet available.
            </p>
          </div>
        ) : (
          <>
            <ResponseRenderer
              content={message.content}
              tool={message.tool}
              sources={message.sources}
              note={message.note}
              aiError={message.aiError}
              data={message.data}
              onRegenerate={onRegenerate}
            />
            <ResponseActions
              content={message.content}
              onRegenerate={onRegenerate}
              onOpenSources={onOpenSources}
            />
          </>
        )}
      </div>
    </motion.div>
  );
}

// ──────────────────────────────────────────────
//  Quick actions under every response
// ──────────────────────────────────────────────

function ActionChip({
  icon: Icon,
  label,
  active,
  onClick,
  title,
}: {
  icon: React.FC<{ size?: number; className?: string }>;
  label: string;
  active?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-semibold transition-all duration-200 active:scale-95 ${
        active
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "border-zinc-200 bg-white text-zinc-500 hover:-translate-y-px hover:border-brand-300 hover:text-brand-700 hover:shadow-sm dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:border-brand-700 dark:hover:text-brand-300"
      }`}
    >
      <Icon size={12} className="h-3 w-3" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function ResponseActions({
  content,
  onRegenerate,
  onOpenSources,
}: {
  content: string;
  onRegenerate?: () => void;
  onOpenSources: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [shared, setShared] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable — ignore.
    }
  }, [content]);

  const exportMarkdown = useCallback(() => {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "brieflyai-response.md";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [content]);

  const exportPdf = useCallback(() => {
    const win = window.open("", "_blank");
    if (!win) return;
    win.opener = null;
    const safe = content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>BrieflyAI — AI Response</title><style>
      body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#18181b;line-height:1.6}
      h1{font-size:20px;border-bottom:2px solid #6366f1;padding-bottom:12px}
      pre{white-space:pre-wrap;font-family:inherit;font-size:14px}
      </style></head><body><h1>BrieflyAI — AI Response</h1><pre>${safe}</pre><script>window.onload=function(){window.print()}<\/script></body></html>`);
    win.document.close();
  }, [content]);

  const share = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: "BrieflyAI response", text: content });
        setShared(true);
        setTimeout(() => setShared(false), 1600);
        return;
      } catch {
        // User dismissed the share sheet — treat as a no-op.
        return;
      }
    }
    await copy();
    setShared(true);
    setTimeout(() => setShared(false), 1600);
  }, [content, copy]);

  const saveSummary = useCallback(() => {
    try {
      const raw = localStorage.getItem(SAVED_SUMMARIES_KEY);
      const existing: { content: string; savedAt: string }[] = raw ? (JSON.parse(raw) as { content: string; savedAt: string }[]) : [];
      if (existing.some((item) => item.content === content)) {
        setSaved(false);
        localStorage.setItem(
          SAVED_SUMMARIES_KEY,
          JSON.stringify(existing.filter((item) => item.content !== content)),
        );
      } else {
        setSaved(true);
        localStorage.setItem(
          SAVED_SUMMARIES_KEY,
          JSON.stringify([...existing, { content, savedAt: new Date().toISOString() }].slice(-50)),
        );
      }
    } catch {
      // Storage unavailable — ignore.
    }
  }, [content]);

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      <ActionChip
        icon={copied ? CheckCircleIcon : CopyIcon}
        label={copied ? "Copied" : "Copy"}
        active={copied}
        onClick={() => void copy()}
        title="Copy response"
      />
      {onRegenerate && (
        <ActionChip
          icon={RefreshCwIcon}
          label="Regenerate"
          onClick={onRegenerate}
          title="Regenerate response"
        />
      )}
      <ActionChip
        icon={DownloadIcon}
        label="Markdown"
        onClick={exportMarkdown}
        title="Export as Markdown"
      />
      <ActionChip
        icon={FileDownIcon}
        label="PDF"
        onClick={exportPdf}
        title="Export as PDF"
      />
      <ActionChip
        icon={shared ? CheckCircleIcon : ShareIcon}
        label={shared ? "Shared" : "Share"}
        active={shared}
        onClick={() => void share()}
        title="Share response"
      />
      <ActionChip
        icon={ExternalLinkIcon}
        label="Sources"
        onClick={onOpenSources}
        title="Open sources"
      />
      <ActionChip
        icon={saved ? CheckCircleIcon : BookmarkIcon}
        label={saved ? "Saved" : "Save"}
        active={saved}
        onClick={saveSummary}
        title="Save summary"
      />
    </div>
  );
}

// ──────────────────────────────────────────────
//  Chat input
// ──────────────────────────────────────────────

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  ref?: React.Ref<HTMLTextAreaElement>;
}

function ChatInputInner({ value, onChange, onSubmit, disabled, ref }: ChatInputProps) {
  const [comingSoon, setComingSoon] = useState<string | null>(null);
  const comingSoonTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(comingSoonTimerRef.current), []);

  const notifyComingSoon = (label: string) => {
    setComingSoon(label);
    clearTimeout(comingSoonTimerRef.current);
    comingSoonTimerRef.current = setTimeout(() => setComingSoon(null), 1800);
  };

  const resize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div className="relative mt-3 shrink-0">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() && !disabled) onSubmit();
        }}
        className="mx-auto max-w-3xl"
      >
        <div className="flex items-end gap-1.5 rounded-[26px] border border-zinc-200 bg-white/90 p-2 shadow-premium-lg backdrop-blur transition-all focus-within:border-brand-400 focus-within:ring-4 focus-within:ring-brand-500/10 dark:border-zinc-700 dark:bg-zinc-900/90 dark:focus-within:border-brand-600">
          <ToolSelector />

          <textarea
            ref={ref}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              resize(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (value.trim() && !disabled) onSubmit();
              }
            }}
            rows={1}
            placeholder="Ask about your inbox, calendar, GitHub, and more…"
            aria-label="Message"
            className="max-h-40 min-h-[2.6rem] flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none dark:text-zinc-100 dark:placeholder-zinc-500"
          />

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => notifyComingSoon("Attachments")}
              title="Attach files — coming soon"
              aria-label="Attach files (coming soon)"
              className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            >
              <PaperclipIcon size={17} className="h-[17px] w-[17px]" />
            </button>
            <button
              type="button"
              onClick={() => notifyComingSoon("Voice input")}
              title="Voice input — coming soon"
              aria-label="Voice input (coming soon)"
              className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            >
              <MicIcon size={17} className="h-[17px] w-[17px]" />
            </button>
            <button
              type="submit"
              disabled={disabled || value.trim().length === 0}
              aria-label="Send message"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-violet-600 text-white shadow-md shadow-brand-600/30 transition-all hover:from-brand-500 hover:to-violet-500 hover:shadow-lg hover:shadow-brand-600/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none dark:from-brand-500 dark:to-violet-500"
            >
              <ArrowUpIcon size={18} className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        <p className="mt-2.5 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
          Press <kbd className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 font-mono text-[10px] shadow-sm dark:border-zinc-700 dark:bg-zinc-900">/</kbd> to focus · Enter to send ·
          AI answers come from your real connected data ·{" "}
          <Link
            href="/dashboard/integrations"
            className="font-semibold text-brand-600 hover:underline dark:text-brand-400"
          >
            Manage Integrations
          </Link>
        </p>
      </form>

      {/* Coming-soon hint */}
      <AnimatePresence>
        {comingSoon && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            className="pointer-events-none absolute -top-9 left-1/2 z-20 -translate-x-1/2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-zinc-600 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          >
            {comingSoon} is coming soon
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const ChatInput = React.forwardRef<HTMLTextAreaElement, Omit<ChatInputProps, "ref">>(
  (props, ref) => <ChatInputInner {...props} ref={ref} />,
);
ChatInput.displayName = "ChatInput";

// ──────────────────────────────────────────────
//  Tool selector
// ──────────────────────────────────────────────

function ToolSelector() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<IntegrationName | null>(null);
  const label = selected ? INTEGRATIONS[selected].label : "All Tools";

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select tool"
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50/80 px-3 text-[11px] font-bold text-zinc-600 transition-colors hover:border-brand-300 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-300 dark:hover:border-brand-700 dark:hover:text-brand-300"
      >
        <AiSparklesIcon size={12} className="h-3 w-3 text-brand-500 dark:text-brand-400" />
        {label}
        <ChevronDownIcon
          size={12}
          className={`h-3 w-3 text-zinc-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            aria-label="Tools"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className="absolute bottom-full left-0 z-30 mb-2 w-52 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-1.5 shadow-premium-lg dark:border-zinc-700 dark:bg-zinc-900"
          >
            <li role="option" aria-selected={!selected}>
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold transition-colors ${
                  !selected
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                <AiSparklesIcon size={14} className="h-3.5 w-3.5 text-brand-500" />
                All Tools
              </button>
            </li>
            <li className="mx-2 my-1 h-px bg-zinc-100 dark:bg-zinc-800" aria-hidden="true" />
            {INTEGRATION_ORDER.map((name) => {
              const meta = INTEGRATIONS[name];
              const Icon = meta.icon;
              return (
                <li key={name} role="option" aria-selected={selected === name}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(name);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold transition-colors ${
                      selected === name
                        ? "bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <span className={`flex h-6 w-6 items-center justify-center rounded-lg ${meta.iconBg}`}>
                      <Icon size={13} className={`h-3.5 w-3.5 ${meta.iconColor}`} />
                    </span>
                    {meta.label}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
