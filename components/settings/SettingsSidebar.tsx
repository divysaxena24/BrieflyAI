"use client";

import React from "react";
import { motion } from "framer-motion";
import type { ComponentType } from "react";

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

interface SettingsSidebarProps {
  items: readonly SettingsNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
}

/**
 * Settings navigation: sticky sidebar on desktop, horizontal tab bar on
 * mobile. The active item is highlighted and animates smoothly.
 */
export function SettingsSidebar({ items, activeId, onSelect }: SettingsSidebarProps) {
  return (
    <>
      {/* Desktop: sticky sidebar */}
      <nav
        aria-label="Settings sections"
        className="hidden w-56 shrink-0 flex-col gap-1 lg:sticky lg:top-24 lg:flex lg:self-start"
      >
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={active ? "true" : undefined}
              className={`relative flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                active
                  ? "text-brand-700 dark:text-brand-300"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/80 dark:hover:text-zinc-200"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="settings-active-pill"
                  className="absolute inset-0 -z-10 rounded-xl bg-brand-50 ring-1 ring-brand-200/70 dark:bg-brand-950/40 dark:ring-brand-900/60"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              <Icon size={15} className="h-4 w-4 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Mobile: horizontal tabs */}
      <nav
        aria-label="Settings sections"
        className="-mx-4 mb-6 flex gap-1 overflow-x-auto px-4 pb-1 lg:hidden"
      >
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={active ? "true" : undefined}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-[11px] font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                active
                  ? "bg-brand-600 text-white shadow-md shadow-brand-600/20"
                  : "border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-700"
              }`}
            >
              <Icon size={13} className="h-3.5 w-3.5" />
              {item.label}
            </button>
          );
        })}
      </nav>
    </>
  );
}
