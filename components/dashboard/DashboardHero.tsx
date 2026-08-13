"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useIntegrationStatus } from "@/lib/integrations/store";
import { AiSparklesIcon, ArrowRightIcon, FeaturesIcon } from "@/components/dashboard/icons";

interface DashboardHeroProps {
  /** The authenticated user's display name (may be null). */
  userFullName: string | null;
  /** The authenticated user's email. */
  userEmail: string;
}

/** Greeting by local time of day. */
function greetingForHour(hour: number): string {
  if (hour < 12) return "Good Morning";
  if (hour < 18) return "Good Afternoon";
  return "Good Evening";
}

/**
 * Welcome hero for the dashboard: time-based greeting, live connected
 * integration count, and the two primary CTAs (AI Assistant + Features).
 */
export const DashboardHero: React.FC<DashboardHeroProps> = ({ userFullName, userEmail }) => {
  const { platforms, isLoading } = useIntegrationStatus();
  const [greeting, setGreeting] = useState("Welcome");

  // Compute the greeting on the client only, so SSR and hydration always match.
  useEffect(() => {
    setGreeting(greetingForHour(new Date().getHours()));
  }, []);

  const connected = platforms.filter(
    (p) => p.status === "connected" || p.status === "syncing"
  ).length;

  const displayName = (userFullName?.trim() || userEmail.split("@")[0] || "there").toUpperCase();

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="relative mb-8 overflow-hidden rounded-3xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90 sm:p-8"
    >
      {/* Subtle brand glow */}
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-500/10 blur-3xl dark:bg-brand-500/15" />

      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2">
            <AiSparklesIcon size={20} className="h-5 w-5 text-brand-600 dark:text-brand-400" />
            <span className="text-[11px] font-bold uppercase tracking-widest text-brand-600 dark:text-brand-400">
              AI Workspace
            </span>
          </div>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-zinc-900 dark:text-white sm:text-4xl">
            {greeting}, {displayName} <span className="inline-block">👋</span>
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            Your AI workspace is ready.{" "}
            {isLoading
              ? "Checking your integrations…"
              : connected > 0
                ? `Connected to ${connected} integration${connected === 1 ? "" : "s"} and ready to answer questions from Gmail, Calendar, Drive, GitHub, Discord and Telegram.`
                : "Connect your first integration to start asking questions from Gmail, Calendar, Drive, GitHub, Discord and Telegram."}
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href="/dashboard/ai-chat"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 text-xs font-bold text-white shadow-md shadow-brand-600/20 transition-all hover:bg-brand-500 active:scale-95 dark:bg-brand-500 dark:hover:bg-brand-400"
          >
            <AiSparklesIcon size={16} className="h-4 w-4" />
            Open AI Assistant
          </Link>
          <Link
            href="/dashboard/features"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-5 text-xs font-bold text-zinc-700 transition-all hover:border-zinc-300 hover:bg-zinc-100 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
          >
            <FeaturesIcon size={16} className="h-4 w-4 text-brand-600 dark:text-brand-400" />
            Browse Features
            <ArrowRightIcon size={14} className="h-3.5 w-3.5 text-zinc-400" />
          </Link>
        </div>
      </div>
    </motion.div>
  );
};
