"use client";

import React from "react";
import Link from "next/link";
import {
  MobileMenuIcon,
  ThemeSunIcon,
  ThemeMoonIcon,
  QuickSearchIcon,
  AlertsIcon,
  AiSparklesIcon,
  BreadcrumbChevronIcon,
} from "./icons";

interface DashboardHeaderProps {
  onToggleMobileDrawer: () => void;
  activeItemTitle: string;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  userEmail?: string;
  userFullName?: string | null;
}

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  onToggleMobileDrawer,
  activeItemTitle,
  isDarkMode,
  onToggleDarkMode,
}) => {
  return (
    <header className="sticky top-0 z-20 flex h-16 w-full items-center justify-between border-b border-zinc-200/80 bg-white/80 px-4 sm:px-6 backdrop-blur-md dark:border-zinc-800/80 dark:bg-[#0b0f1a]/80">
      {/* ── Left Side: Mobile Menu Button & Breadcrumbs ── */}
      <div className="flex items-center gap-3">
        {/* Mobile Hamburger Toggle */}
        <button
          type="button"
          onClick={onToggleMobileDrawer}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-600 shadow-sm transition-all hover:bg-zinc-50 active:scale-95 lg:hidden dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label="Open sidebar"
        >
          <MobileMenuIcon size={20} className="h-5 w-5" />
        </button>

        {/* Navigation Breadcrumb */}
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="hidden text-zinc-400 dark:text-zinc-500 sm:inline">
            BrieflyAI
          </span>
          <BreadcrumbChevronIcon size={16} className="hidden h-4 w-4 text-zinc-400 dark:text-zinc-600 sm:inline" />
          <span className="flex items-center gap-1.5 text-zinc-900 dark:text-white capitalize">
            <span className="inline-block h-2 w-2 rounded-full bg-brand-500" />
            {activeItemTitle}
          </span>
        </div>
      </div>

      {/* ── Right Side: Search Bar, Theme Toggle, Alerts ── */}
      <div className="flex items-center gap-2.5 sm:gap-3">
        {/* Quick Search Input */}
        <div className="relative hidden md:block">
          <QuickSearchIcon size={16} className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
          <input
            type="text"
            placeholder="Search AI agents, briefs..."
            className="h-9 w-64 rounded-xl border border-zinc-200 bg-zinc-50/80 pl-9 pr-12 text-xs text-zinc-900 placeholder-zinc-400 transition-all focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-brand-400 dark:focus:bg-zinc-900"
          />
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded bg-zinc-200/60 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            ⌘K
          </kbd>
        </div>

        {/* Light / Dark Mode Toggle */}
        <button
          type="button"
          onClick={onToggleDarkMode}
          title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-600 shadow-sm transition-all hover:bg-zinc-50 hover:text-zinc-900 active:scale-95 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
        >
          {isDarkMode ? (
            <ThemeSunIcon size={18} className="h-4.5 w-4.5 text-amber-400" />
          ) : (
            <ThemeMoonIcon size={18} className="h-4.5 w-4.5 text-zinc-700" />
          )}
        </button>

        {/* Notifications Alert Bell */}
        <button
          type="button"
          title="Notifications"
          className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-600 shadow-sm transition-all hover:bg-zinc-50 hover:text-zinc-900 active:scale-95 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
        >
          <AlertsIcon size={18} className="h-4.5 w-4.5" />
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-white dark:ring-zinc-900" />
        </button>

        {/* AI Quick Assistant Pill — links to the AI chat */}
        <Link
          href="/dashboard/ai-chat"
          className="hidden sm:flex items-center gap-1.5 rounded-full bg-brand-50 border border-brand-200/80 px-3 py-1 text-xs font-semibold text-brand-700 transition-all hover:bg-brand-100 active:scale-95 dark:bg-brand-950/50 dark:border-brand-900/60 dark:text-brand-300 dark:hover:bg-brand-900/60"
        >
          <AiSparklesIcon size={14} className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400 animate-pulse" />
          AI Active
        </Link>
      </div>
    </header>
  );
};
