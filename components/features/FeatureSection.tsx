"use client";

import React, { useEffect, useState, useCallback } from "react";
import { ChevronDown, Info } from "lucide-react";
import { motion } from "framer-motion";
import { FeatureCard } from "./FeatureCard";
import { HighlightText } from "./HighlightText";
import { ConnectionBadge } from "@/components/integrations";
import type { ConnectionStatus } from "@/lib/integrations/types";
import type { IntegrationFeatureGroup } from "@/lib/features/featureCatalog";

interface FeatureSectionProps {
  group: IntegrationFeatureGroup;
  status: ConnectionStatus;
  defaultOpen?: boolean;
  isOpen?: boolean;
  onToggle?: (isOpen: boolean) => void;
  onPromptCopied?: (prompt: string) => void;
  tryNowBaseHref?: string;
  searchQuery?: string;
}

const STORAGE_KEY = "briefly-features-expanded";

function getStoredExpanded(id: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return parsed[id] ?? false;
    }
  } catch {
    // ignore
  }
  return false;
}

function setStoredExpanded(id: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    parsed[id] = value;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

export const FeatureSection: React.FC<FeatureSectionProps> = ({
  group,
  status,
  defaultOpen = false,
  isOpen,
  onToggle,
  onPromptCopied,
  tryNowBaseHref,
  searchQuery = "",
}) => {
  const [internalOpen, setInternalOpen] = useState(() => getStoredExpanded(group.id) || defaultOpen);
  const open = isOpen ?? internalOpen;

  const handleToggle = useCallback(() => {
    const next = !open;
    if (onToggle) {
      onToggle(next);
    } else {
      setInternalOpen(next);
      setStoredExpanded(group.id, next);
    }
  }, [open, onToggle]);

  useEffect(() => {
    if (onToggle) {
      setStoredExpanded(group.id, open);
    }
  }, [open, group.id, onToggle]);

  const supportedCount = group.features.filter((f) => f.status === "supported").length;

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 sm:px-5"
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${group.accentColor}18`, color: group.accentColor }}
        >
          {React.createElement(group.icon, { size: 18, className: "h-4.5 w-4.5" })}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
              {searchQuery ? <HighlightText text={group.name} query={searchQuery} /> : group.name}
            </h3>
            <ConnectionBadge status={status} />
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
            {searchQuery ? <HighlightText text={group.description} query={searchQuery} /> : group.description}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 sm:inline-flex">
            {group.features.length} capabilities
            {supportedCount !== group.features.length && (
              <span className="ml-1 text-emerald-600 dark:text-emerald-400">· {supportedCount} supported</span>
            )}
          </span>
          <ChevronDown
            size={16}
            className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      <div
        role="region"
        aria-label={`${group.name} features`}
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-2.5 border-t border-zinc-100 px-4 pb-4 pt-3 dark:border-zinc-800 sm:px-5">
            {group.banner && (
              <div className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50/70 p-2.5 dark:border-sky-900/60 dark:bg-sky-950/30">
                <Info size={14} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                <div>
                  <p className="text-xs font-bold text-sky-800 dark:text-sky-200">{group.banner.title}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-sky-700/90 dark:text-sky-300/90">
                    {group.banner.message}
                  </p>
                </div>
              </div>
            )}

            <div className="grid gap-2.5 lg:grid-cols-2">
              {group.features.map((feature, idx) => (
                <motion.div
                  key={feature.title}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: open ? idx * 0.03 : 0 }}
                >
                  <FeatureCard
                    feature={feature}
                    accentColor={group.accentColor}
                    onPromptCopied={onPromptCopied}
                    tryNowHref={tryNowBaseHref ? `${tryNowBaseHref}?q=${encodeURIComponent(feature.prompt)}` : undefined}
                    searchQuery={searchQuery}
                  />
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
