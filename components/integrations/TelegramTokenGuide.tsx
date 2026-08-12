"use client";

import React, { useEffect, useState } from "react";
import {
  TelegramSendIcon,
  ChevronDownIcon,
  InfoIcon,
  ExternalLinkIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
} from "@/components/dashboard/icons";
import { integrationPlatforms } from "@/lib/integrations/config";

/**
 * Collapsible "How to get your Telegram bot token" guide.
 *
 * Rendered directly below the bot-token input in the shared bot-token
 * connect dialog (only for Telegram). Collapsed by default so users who
 * already know the process are never interrupted; the expanded/collapsed
 * state is persisted to sessionStorage so it is remembered while the page
 * is open (including across dialog re-opens, since the dialog inner
 * component remounts via `key`).
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
  title: string;
  description: React.ReactNode;
}

const STEPS: GuideStep[] = [
  {
    title: "Open Telegram",
    description: (
      <>
        Open the Telegram app and search for{" "}
        <code className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          @BotFather
        </code>
        .
      </>
    ),
  },
  {
    title: "Start a chat with BotFather",
    description: (
      <>
        Open the chat and send{" "}
        <code className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          /newbot
        </code>
        .
      </>
    ),
  },
  {
    title: "Enter a display name",
    description: (
      <>
        Choose a display name for your bot. For example:{" "}
        <span className="font-semibold text-zinc-700 dark:text-zinc-300">
          BrieflyAI Assistant
        </span>
      </>
    ),
  },
  {
    title: "Choose a username",
    description: (
      <>
        Pick a unique username ending in{" "}
        <code className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          bot
        </code>
        . For example:{" "}
        <code className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          brieflyai_helper_bot
        </code>
      </>
    ),
  },
  {
    title: "Copy your bot token",
    description: (
      <>
        BotFather will reply with a message containing your token. It looks like:{" "}
        <code className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          1234567890:AAHkds83jd83JDKS8djskdjskd…
        </code>
      </>
    ),
  },
  {
    title: "Paste it into the field above",
    description: (
      <>
        Copy <strong>only</strong> the token and paste it into the input field above, then
        click Connect.
      </>
    ),
  },
];

const SECURITY_TIPS = [
  "Keep your bot token secret.",
  "Never share it publicly.",
  "Anyone with this token can control your bot.",
  "If your token is leaked, regenerate it immediately using /revoke at BotFather.",
];

export const TelegramTokenGuide: React.FC = () => {
  const [isOpen, setIsOpen] = useState<boolean>(readStoredState);

  // Persist the state while the page is open (and across dialog re-opens).
  useEffect(() => {
    writeStoredState(isOpen);
  }, [isOpen]);

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
          Need help getting a bot token?
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
        aria-label="How to get your Telegram bot token"
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

            {/* Numbered steps */}
            <ol className="space-y-2.5">
              {STEPS.map((step, idx) => (
                <li key={idx} className="flex items-start gap-2.5">
                  <span
                    className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: TELEGRAM_ACCENT }}
                  >
                    {idx + 1}
                  </span>
                  <div className="min-w-0 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                    <span className="font-bold text-zinc-800 dark:text-zinc-200">{step.title}.</span>{" "}
                    {step.description}
                  </div>
                </li>
              ))}
            </ol>

            {/* Security warning callout */}
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
              <h4 className="flex items-center gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
                <AlertTriangleIcon size={13} className="h-3 w-3 shrink-0" />
                Keep your token secure
              </h4>
              <ul className="mt-1.5 space-y-1">
                {SECURITY_TIPS.map((tip, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700/90 dark:text-amber-300/90"
                  >
                    <CheckCircleIcon size={11} className="mt-0.5 h-2.5 w-2.5 shrink-0 text-amber-500" />
                    {tip}
                  </li>
                ))}
              </ul>
            </div>

            {/* Open BotFather */}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold text-white shadow-sm transition-all hover:opacity-90 active:scale-95"
              style={{ backgroundColor: TELEGRAM_ACCENT }}
            >
              <TelegramSendIcon size={14} className="h-3.5 w-3.5" />
              Open BotFather
              <ExternalLinkIcon size={13} className="h-3 w-3 opacity-80" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TelegramTokenGuide;
