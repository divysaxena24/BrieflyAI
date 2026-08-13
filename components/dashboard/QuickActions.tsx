"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  GmailMailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GithubIcon,
  TelegramSendIcon,
  DiscordIcon,
  ArrowRightIcon,
} from "@/components/dashboard/icons";

interface QuickAction {
  label: string;
  prompt: string;
  icon: React.FC<{ size?: number; className?: string }>;
  chip: string;
  chipBg: string;
  chipColor: string;
}

const ACTIONS: QuickAction[] = [
  {
    label: "Summarize Inbox",
    prompt: "Summarize my inbox",
    icon: GmailMailIcon,
    chip: "Gmail",
    chipBg: "bg-red-50 dark:bg-red-950/40",
    chipColor: "text-red-600 dark:text-red-400",
  },
  {
    label: "Today's Meetings",
    prompt: "What's on my calendar today?",
    icon: GoogleCalendarIcon,
    chip: "Calendar",
    chipBg: "bg-emerald-50 dark:bg-emerald-950/40",
    chipColor: "text-emerald-600 dark:text-emerald-400",
  },
  {
    label: "Recent Drive Files",
    prompt: "Show my recent Drive files",
    icon: GoogleDriveIcon,
    chip: "Drive",
    chipBg: "bg-amber-50 dark:bg-amber-950/40",
    chipColor: "text-amber-600 dark:text-amber-400",
  },
  {
    label: "GitHub Activity",
    prompt: "What's new in my GitHub repositories?",
    icon: GithubIcon,
    chip: "GitHub",
    chipBg: "bg-zinc-100 dark:bg-zinc-800",
    chipColor: "text-zinc-600 dark:text-zinc-300",
  },
  {
    label: "Telegram Messages",
    prompt: "Show me recent Telegram messages",
    icon: TelegramSendIcon,
    chip: "Telegram",
    chipBg: "bg-sky-50 dark:bg-sky-950/40",
    chipColor: "text-sky-600 dark:text-sky-400",
  },
  {
    label: "Discord Servers",
    prompt: "Show my Discord servers",
    icon: DiscordIcon,
    chip: "Discord",
    chipBg: "bg-indigo-50 dark:bg-indigo-950/40",
    chipColor: "text-indigo-600 dark:text-indigo-400",
  },
];

/**
 * AI Quick Actions: one-tap prompts that open the AI Assistant with the
 * message pre-filled. Each action is a real prompt the assistant can answer.
 */
export const QuickActions: React.FC = () => {
  return (
    <div className="flex flex-col gap-2.5">
      {ACTIONS.map((action, index) => {
        const Icon = action.icon;
        return (
          <motion.div
            key={action.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: index * 0.04 }}
          >
            <Link
              href={`/dashboard/ai-chat?q=${encodeURIComponent(action.prompt)}`}
              className="group flex w-full items-center gap-3.5 rounded-2xl border border-zinc-200/80 bg-white p-3.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md active:scale-[0.98] dark:border-zinc-800/80 dark:bg-zinc-900/90 dark:hover:border-brand-800"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-50 text-zinc-700 transition-colors group-hover:text-brand-600 dark:bg-zinc-800 dark:text-zinc-200 dark:group-hover:text-brand-400">
                <Icon size={19} className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-zinc-900 dark:text-white">
                  {action.label}
                </p>
                <p className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${action.chipBg} ${action.chipColor}`}>
                  {action.chip}
                </p>
              </div>
              <ArrowRightIcon
                size={15}
                className="h-4 w-4 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500 dark:text-zinc-600"
              />
            </Link>
          </motion.div>
        );
      })}
    </div>
  );
};
