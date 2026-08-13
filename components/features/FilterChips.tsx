"use client";

import React from "react";
import { Filter, Check, PlugZap, Bot } from "lucide-react";
import {
  GmailMailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GithubIcon,
  DiscordIcon,
  TelegramSendIcon,
} from "@/components/dashboard/icons";

export type FilterType = "all" | "gmail" | "google-calendar" | "google-drive" | "github" | "discord" | "telegram" | "connected" | "requires-bot";

interface FilterChipsProps {
  activeFilter: FilterType;
  onFilterChange: (filter: FilterType) => void;
  connectedPlatforms: string[];
  totalVisibleFeatures: number;
}

const FILTERS: { id: FilterType; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: "all", label: "All", icon: Filter },
  { id: "gmail", label: "Gmail", icon: GmailMailIcon },
  { id: "google-calendar", label: "Calendar", icon: GoogleCalendarIcon },
  { id: "google-drive", label: "Drive", icon: GoogleDriveIcon },
  { id: "github", label: "GitHub", icon: GithubIcon },
  { id: "discord", label: "Discord", icon: DiscordIcon },
  { id: "telegram", label: "Telegram", icon: TelegramSendIcon },
  { id: "connected", label: "Connected", icon: PlugZap },
  { id: "requires-bot", label: "Requires Bot", icon: Bot },
];

export const FilterChips: React.FC<FilterChipsProps> = ({ activeFilter, onFilterChange, connectedPlatforms, totalVisibleFeatures }) => {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
      {FILTERS.map((filter) => {
        const Icon = filter.icon;
        const isActive = activeFilter === filter.id;
        const showConnectedBadge = filter.id === "connected" && connectedPlatforms.length > 0;

        return (
          <button
            key={filter.id}
            type="button"
            onClick={() => onFilterChange(filter.id)}
            aria-pressed={isActive}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all ${
              isActive
                ? "border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950/60 dark:text-brand-300"
                : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-600"
            }`}
          >
            {isActive ? (
              <Check size={12} className="h-3 w-3" />
            ) : (
              <Icon size={14} className="h-3.5 w-3.5" />
            )}
            {filter.label}
            {showConnectedBadge && (
              <span className="ml-0.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-700 dark:bg-brand-900/60 dark:text-brand-300">
                {connectedPlatforms.length}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
