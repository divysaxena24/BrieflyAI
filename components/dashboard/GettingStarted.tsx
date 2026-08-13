"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useIntegrationStatus } from "@/lib/integrations/store";
import { useDashboardData } from "./useDashboardData";
import { CheckCircleIcon, CircleIcon } from "lucide-react";

interface ChecklistItem {
  label: string;
  href: string;
  done: boolean;
}

/**
 * Getting Started checklist for new users. Only renders while fewer than 3
 * integrations are connected; hides automatically once the threshold is met.
 */
export const GettingStarted: React.FC = () => {
  const { platforms, isLoading } = useIntegrationStatus();
  const { conversations } = useDashboardData();

  const connected = platforms.filter(
    (p) => p.status === "connected" || p.status === "syncing"
  ).length;

  if (isLoading || connected >= 3) return null;

  const isConnected = (id: string) =>
    platforms.some(
      (p) => p.id === id && (p.status === "connected" || p.status === "syncing")
    );

  const items: ChecklistItem[] = [
    { label: "Connect Gmail", href: "/dashboard/integrations", done: isConnected("gmail") },
    { label: "Connect Calendar", href: "/dashboard/integrations", done: isConnected("google-calendar") },
    { label: "Connect GitHub", href: "/dashboard/integrations", done: isConnected("github") },
    { label: "Ask your first AI question", href: "/dashboard/ai-chat", done: conversations.length > 0 },
    { label: "Explore Features", href: "/dashboard/features", done: false },
  ];

  const doneCount = items.filter((i) => i.done).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="rounded-3xl border border-zinc-200/80 bg-gradient-to-br from-white to-zinc-50/60 p-6 shadow-sm dark:border-zinc-800/80 dark:from-zinc-900/90 dark:to-zinc-900/60 sm:p-7"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-bold text-zinc-900 dark:text-white">
            Getting Started
          </h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Connect integrations to unlock the full AI workspace.
          </p>
        </div>
        <div className="mt-2 h-1.5 w-32 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 sm:mt-0">
          <div
            className="h-full rounded-full bg-brand-500 transition-all duration-500"
            style={{ width: `${(doneCount / items.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="mt-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-3 text-left transition-all active:scale-[0.98] ${
              item.done
                ? "border-emerald-200/70 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/20"
                : "border-zinc-200/80 bg-white hover:border-brand-300 hover:bg-brand-50/40 dark:border-zinc-800 dark:bg-zinc-900/70 dark:hover:border-brand-800 dark:hover:bg-brand-950/20"
            }`}
          >
            {item.done ? (
              <CheckCircleIcon size={17} className="h-4.5 w-4.5 shrink-0 text-emerald-500" />
            ) : (
              <CircleIcon size={17} className="h-4.5 w-4.5 shrink-0 text-zinc-300 dark:text-zinc-600" />
            )}
            <span
              className={`text-xs font-semibold ${
                item.done
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-zinc-700 dark:text-zinc-200"
              }`}
            >
              {item.label}
            </span>
          </Link>
        ))}
      </div>
    </motion.div>
  );
};
