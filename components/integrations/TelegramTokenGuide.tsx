"use client";

import React, { useEffect, useState } from "react";
import {
  TelegramSendIcon,
  MessageIcon,
  AiAgentIcon,
  LockIcon,
  PlugIcon,
  NetworkIcon,
  RefreshCwIcon,
  Loader2Icon,
  ChevronDownIcon,
  InfoIcon,
  ExternalLinkIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
} from "@/components/dashboard/icons";
import { integrationPlatforms } from "@/lib/integrations/config";

/**
 * Collapsible "How to connect your Telegram bot" guide.
 *
 * Rendered directly below the bot-token input in the shared bot-token
 * connect dialog (only for Telegram). Walks a first-time user through the
 * complete setup in 8 numbered steps: creating/selecting the bot with
 * BotFather, pasting the token, adding the bot to a group/channel, and
 * generating the first update so chats become visible. A real "Discover
 * Chats" action (calling the existing GET /api/telegram/chats endpoint)
 * lets the user load the chats the bot can actually access — real data,
 * never invented, and no token is ever exposed, logged, or displayed.
 *
 * Collapsed by default so users who already know the process are never
 * interrupted; the expanded/collapsed state is persisted to sessionStorage
 * so it is remembered while the page is open (including across dialog
 * re-opens, since the dialog inner component remounts via `key`).
 */
const TELEGRAM_ACCENT =
  integrationPlatforms.find((p) => p.id === "telegram")?.accentColor ?? "#26a5e4";

/** sessionStorage key — survives dialog remounts but not new tabs/sessions. */
const STORAGE_KEY = "brieflyai:telegram-token-guide:expanded";

function readStoredState(): boolean {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredState(expanded: boolean): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, expanded ? "1" : "0");
  } catch {
    // Private-mode browsers may block storage — the guide still works, the
    // state just won't persist.
  }
}

interface GuideStep {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: React.ReactNode;
}

const STEP_CODE_CLASSES =
  "rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

const STEPS: GuideStep[] = [
  {
    icon: TelegramSendIcon,
    title: "Open Telegram",
    description: <>Open the Telegram app on your phone, tablet, or desktop.</>,
  },
  {
    icon: MessageIcon,
    title: "Open @BotFather",
    description: (
      <>
        Search for{" "}
        <code className={STEP_CODE_CLASSES}>@BotFather</code> and open the official BotFather
        chat.
      </>
    ),
  },
  {
    icon: AiAgentIcon,
    title: "Create or select your bot",
    description: (
      <>
        Create a new bot with{" "}
        <code className={STEP_CODE_CLASSES}>/newbot</code>, or open the chat of a bot you&apos;ve
        already created.
      </>
    ),
  },
  {
    icon: LockIcon,
    title: "Copy your bot token",
    description: (
      <>
        Copy the HTTP API token BotFather provides — it looks like{" "}
        <code className={STEP_CODE_CLASSES}>123456789:AA…</code>. Keep it private; treat it like
        a password.
      </>
    ),
  },
  {
    icon: PlugIcon,
    title: "Paste the token into BrieflyAI",
    description: (
      <>
        Return to BrieflyAI, paste the token into the field above, then click{" "}
        <strong>Connect</strong>.
      </>
    ),
  },
  {
    icon: NetworkIcon,
    title: "Add the bot to a group or channel",
    description: (
      <>
        Add the bot to the Telegram group or channel whose messages you want BrieflyAI to access,
        and make sure it has permission to receive the relevant messages and updates.
      </>
    ),
  },
  {
    icon: TelegramSendIcon,
    title: "Send a message to generate an update",
    description: (
      <>
        Send a message in that group or channel — or message the bot directly — so Telegram
        generates an update the bot can receive.
      </>
    ),
  },
  {
    icon: RefreshCwIcon,
    title: "Return to BrieflyAI and discover chats",
    description: (
      <>
        Return to BrieflyAI and click <strong>Discover Chats</strong> below to load the chats
        your bot can access.
      </>
    ),
  },
];

/** A chat returned by GET /api/telegram/chats (real production data). */
interface DiscoveredChat {
  id: number;
  title: string;
  username: string | null;
  type: string;
}

type DiscoveryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; chats: DiscoveredChat[] }
  | { status: "error"; message: string };

export const TelegramTokenGuide: React.FC = () => {
  const [isOpen, setIsOpen] = useState<boolean>(readStoredState);
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: "idle" });

  // Persist the state while the page is open (and across dialog re-opens).
  useEffect(() => {
    writeStoredState(isOpen);
  }, [isOpen]);

  /**
   * Load the chats the connected bot can actually access via the existing
   * GET /api/telegram/chats endpoint. Real data only — no fake chats. The bot
   * token is never sent to or from the client here.
   */
  const discoverChats = async () => {
    if (discovery.status === "loading") return;
    setDiscovery({ status: "loading" });
    try {
      const res = await fetch("/api/telegram/chats", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: { chats?: DiscoveredChat[] };
        message?: string;
        errors?: Array<{ message?: string; code?: string }>;
      } | null;

      if (!res.ok || !body?.success || !Array.isArray(body.data?.chats)) {
        if (body?.errors?.[0]?.code === "telegram_not_connected") {
          setDiscovery({
            status: "error",
            message: "Connect your bot first — you can discover chats once it's connected.",
          });
          return;
        }
        setDiscovery({
          status: "error",
          message: body?.errors?.[0]?.message ?? body?.message ?? "Failed to load chats. Try again.",
        });
        return;
      }
      setDiscovery({ status: "success", chats: body.data.chats });
    } catch {
      setDiscovery({
        status: "error",
        message: "Failed to load chats. Check your connection and try again.",
      });
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-800/40">
      {/* ── Toggle header ── */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-controls="telegram-token-guide-panel"
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${TELEGRAM_ACCENT}1a`, color: TELEGRAM_ACCENT }}
        >
          <TelegramSendIcon size={14} className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 text-xs font-bold text-zinc-700 dark:text-zinc-300">
          Need help connecting your bot?
        </span>
        <ChevronDownIcon
          size={16}
          className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-300 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* ── Collapsible panel (smooth grid-rows animation) ── */}
      {/* `inert` removes the collapsed content from focus + screen readers
          (React 19 supports the boolean `inert` prop natively) while the CSS
          grid-rows animation still animates smoothly. */}
      <div
        id="telegram-token-guide-panel"
        role="region"
        aria-label="How to connect your Telegram bot"
        inert={!isOpen}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${
          isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-4 border-t border-zinc-200 px-4 pb-4 pt-3.5 dark:border-zinc-700">
            {/* Info callout */}
            <div className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50/70 p-3 dark:border-sky-900/60 dark:bg-sky-950/30">
              <InfoIcon size={15} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
              <p className="text-[11px] leading-relaxed text-sky-700 dark:text-sky-300">
                BotFather is Telegram&apos;s official bot — it creates your bot and issues the
                token in just a few steps.
              </p>
            </div>

            {/* Numbered steps (1–8) */}
            <ol className="space-y-3">
              {STEPS.map((step, idx) => {
                const StepIcon = step.icon;
                return (
                  <li key={idx} className="flex items-start gap-3">
                    <span
                      className="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                      style={{ backgroundColor: `${TELEGRAM_ACCENT}14`, color: TELEGRAM_ACCENT }}
                    >
                      <StepIcon size={15} className="h-3.5 w-3.5" />
                      <span
                        className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white"
                        style={{ backgroundColor: TELEGRAM_ACCENT }}
                      >
                        {idx + 1}
                      </span>
                    </span>
                    <div className="min-w-0 pt-0.5">
                      <p className="text-[11px] font-bold text-zinc-800 dark:text-zinc-200">
                        {step.title}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                        {step.description}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>

            {/* Discover Chats — the action from step 8, wired to the real
                GET /api/telegram/chats endpoint */}
            <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-3 dark:border-sky-900/60 dark:bg-sky-950/30">
              <h4 className="flex items-center gap-1.5 text-[11px] font-bold text-sky-700 dark:text-sky-300">
                <RefreshCwIcon size={13} className="h-3 w-3 shrink-0" />
                Discover chats
              </h4>
              <p className="mt-1 text-[11px] leading-relaxed text-sky-700/90 dark:text-sky-300/90">
                Load the chats your bot can access. Chats appear only after the bot has received
                an update from them.
              </p>
              <button
                type="button"
                onClick={discoverChats}
                disabled={discovery.status === "loading"}
                aria-busy={discovery.status === "loading"}
                className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold text-white shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                style={{ backgroundColor: TELEGRAM_ACCENT }}
              >
                {discovery.status === "loading" ? (
                  <>
                    <Loader2Icon size={14} className="h-3.5 w-3.5 animate-spin" />
                    Discovering chats…
                  </>
                ) : (
                  <>
                    <RefreshCwIcon size={14} className="h-3.5 w-3.5" />
                    Discover Chats
                  </>
                )}
              </button>

              {/* Real discovery results (announced to screen readers) */}
              <div aria-live="polite">
                {discovery.status === "success" && discovery.chats.length > 0 && (
                  <ul className="mt-2.5 space-y-1.5">
                    {discovery.chats.slice(0, 10).map((chat) => (
                      <li
                        key={chat.id}
                        className="flex items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-[11px] dark:bg-zinc-900/40"
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: TELEGRAM_ACCENT }}
                        />
                        <span className="min-w-0 flex-1 truncate font-semibold text-zinc-800 dark:text-zinc-200">
                          {chat.title || (chat.username ? `@${chat.username}` : `Chat ${chat.id}`)}
                        </span>
                        <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          {chat.type}
                        </span>
                      </li>
                    ))}
                    {discovery.chats.length > 10 && (
                      <li className="text-[10px] text-zinc-500 dark:text-zinc-400">
                        + {discovery.chats.length - 10} more
                      </li>
                    )}
                  </ul>
                )}
                {discovery.status === "success" && discovery.chats.length === 0 && (
                  <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-white/70 p-2.5 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-900/40 dark:text-zinc-300">
                    <InfoIcon size={12} className="mt-0.5 h-3 w-3 shrink-0 text-sky-500" />
                    No accessible chats yet. Add the bot to a group or channel, or send it a message,
                    then click Discover Chats again.
                  </p>
                )}
                {discovery.status === "error" && (
                  <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                    <AlertTriangleIcon size={12} className="mt-0.5 h-3 w-3 shrink-0" />
                    {discovery.message}
                  </p>
                )}
              </div>
            </div>

            {/* Security warning callout */}
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
              <h4 className="flex items-center gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
                <AlertTriangleIcon size={13} className="h-3 w-3 shrink-0" />
                Keep your bot token private
              </h4>
              <p className="mt-1 text-[11px] leading-relaxed text-amber-700/90 dark:text-amber-300/90">
                Anyone with your token can control your bot — don&apos;t share it and never commit
                it to code.
              </p>
              <ul className="mt-1.5 space-y-1">
                <li className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700/90 dark:text-amber-300/90">
                  <CheckCircleIcon size={11} className="mt-0.5 h-2.5 w-2.5 shrink-0 text-amber-500" />
                  If your token leaks, regenerate it immediately with{" "}
                  <code className="rounded bg-amber-100 px-1 font-mono text-[10px] dark:bg-amber-900/60">
                    /revoke
                  </code>{" "}
                  in BotFather.
                </li>
              </ul>
            </div>

            {/* Open BotFather */}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:opacity-90 active:scale-95"
              style={{ backgroundColor: TELEGRAM_ACCENT }}
            >
              <TelegramSendIcon size={14} className="h-3.5 w-3.5" />
              Open BotFather
              <ExternalLinkIcon size={13} className="h-3 w-3 opacity-80" />
            </a>

            {/* Chat visibility callout — Telegram bots can only see chats they've been added to */}
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
              <h4 className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                <InfoIcon size={13} className="h-3 w-3 shrink-0" />
                After connecting: make chats visible
              </h4>
              <ul className="mt-1.5 space-y-1.5 text-[11px] leading-relaxed text-emerald-700/90 dark:text-emerald-300/90">
                <li className="flex items-start gap-1.5">
                  <CheckCircleIcon size={11} className="mt-0.5 h-2.5 w-2.5 shrink-0 text-emerald-500" />
                  Telegram bots can only see chats they&apos;ve actually interacted with — BrieflyAI
                  can&apos;t discover arbitrary private chats.
                </li>
                <li className="flex items-start gap-1.5">
                  <CheckCircleIcon size={11} className="mt-0.5 h-2.5 w-2.5 shrink-0 text-emerald-500" />
                  Add the bot to a group or channel, or send it a direct message (e.g.{" "}
                  <code className="rounded bg-emerald-100 px-1 font-mono text-[10px] dark:bg-emerald-900/60">
                    /start
                  </code>
                  ), before chats can appear.
                </li>
                <li className="flex items-start gap-1.5">
                  <CheckCircleIcon size={11} className="mt-0.5 h-2.5 w-2.5 shrink-0 text-emerald-500" />
                  Until then, the AI assistant will report &quot;no accessible chats&quot; instead of
                  inventing data.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TelegramTokenGuide;
