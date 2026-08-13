"use client";

import React, { useMemo, useRef, useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Boxes, PlugZap, ChevronDown, ChevronUp, Search } from "lucide-react";
import { FeatureSearch, FeatureSection, FilterChips } from "@/components/features";
import { useIntegrationStatus } from "@/lib/integrations/store";
import type { ConnectionStatus } from "@/lib/integrations/types";
import {
  featureCatalog,
  supportedFeatureCount,
  CATALOG_PLATFORM_IDS,
  type IntegrationFeatureGroup,
  type FeatureItem,
} from "@/lib/features/featureCatalog";
import { AiSparklesIcon, MessageIcon } from "@/components/dashboard/icons";

const AI_ASSISTANT_HREF = "/dashboard/ai-chat";
const STORAGE_KEY = "briefly-features-expanded";

function isConnectedStatus(status: string): boolean {
  return status === "connected" || status === "syncing";
}

type FilterType = "all" | "gmail" | "google-calendar" | "google-drive" | "github" | "discord" | "telegram" | "connected" | "requires-bot";

export default function FeaturesPage() {
  const { platforms } = useIntegrationStatus();
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [toast, setToast] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return new Set(Object.entries(parsed).filter(([, v]) => v).map(([k]) => k));
      }
    } catch {
      // ignore
    }
    return new Set();
  });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const integrationRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const statusByPlatform = useMemo(() => {
    const map = new Map<string, ConnectionStatus>();
    for (const platform of platforms) {
      if (CATALOG_PLATFORM_IDS.includes(platform.id)) map.set(platform.id, platform.status);
    }
    return map;
  }, [platforms]);

  const connectedCount = useMemo(
    () => Array.from(statusByPlatform.values()).filter(isConnectedStatus).length,
    [statusByPlatform],
  );

  const connectedPlatformIds = useMemo(
    () => Array.from(statusByPlatform.entries()).filter(([, status]) => isConnectedStatus(status)).map(([id]) => id),
    [statusByPlatform],
  );

  useEffect(() => {
    const obj: Record<string, boolean> = {};
    featureCatalog.forEach((group) => {
      obj[group.id] = expandedIds.has(group.id);
    });
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }, [expandedIds]);

  const filteredCatalog: readonly IntegrationFeatureGroup[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    let result = featureCatalog;

    if (q) {
      result = result
        .map((group) => {
          const groupMatches =
            group.name.toLowerCase().includes(q) || group.description.toLowerCase().includes(q);
          const features: FeatureItem[] = group.features.filter(
            (feature) =>
              feature.title.toLowerCase().includes(q) ||
              feature.description.toLowerCase().includes(q) ||
              feature.prompt.toLowerCase().includes(q),
          );
          if (groupMatches && features.length === 0) {
            return { ...group, features: group.features };
          }
          if (features.length === 0) return null;
          return { ...group, features };
        })
        .filter((group): group is IntegrationFeatureGroup => group !== null);
    }

    if (activeFilter !== "all") {
      result = result.filter((group) => {
        if (activeFilter === "connected") {
          return connectedPlatformIds.includes(group.id);
        }
        if (activeFilter === "requires-bot") {
          return group.features.some((f) => f.status === "requires-bot");
        }
        return group.id === activeFilter;
      });
    }

    return result;
  }, [query, activeFilter, connectedPlatformIds]);

  const totalVisibleFeatures = useMemo(
    () => filteredCatalog.reduce((total, group) => total + group.features.length, 0),
    [filteredCatalog],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2000);
  }, []);

  const handleToggle = useCallback((id: string, isOpen: boolean) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (isOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    setExpandedIds(new Set(featureCatalog.map((g) => g.id)));
  }, []);

  const handleCollapseAll = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  const handleFilterChange = useCallback(
    (filter: FilterType) => {
      setActiveFilter(filter);
      if (filter !== "all") {
        const targetGroup = filteredCatalog.find((group) => {
          if (filter === "connected") return connectedPlatformIds.includes(group.id);
          if (filter === "requires-bot") return group.features.some((f) => f.status === "requires-bot");
          return group.id === filter;
        });
        if (targetGroup) {
          setTimeout(() => {
            const el = integrationRefs.current.get(targetGroup.id);
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }, 150);
        }
      }
    },
    [filteredCatalog, connectedPlatformIds],
  );

  return (
    <div>
      {/* ── Hero ── */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-brand-600 dark:text-brand-400">
          <AiSparklesIcon size={14} className="h-3.5 w-3.5" />
          Feature Catalog
        </div>
        <h1 className="mt-1.5 text-3xl font-black tracking-tight text-zinc-900 dark:text-white sm:text-4xl">
          AI Features
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
          Explore everything BrieflyAI can do across your connected integrations.
        </p>

        {/* Search + stats */}
        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex-1">
            <FeatureSearch value={query} onChange={setQuery} />
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/90">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400">
                <Boxes size={13} className="h-3.5 w-3.5" />
              </span>
              <span className="text-xs font-black text-zinc-900 dark:text-white">
                {supportedFeatureCount()}
              </span>
              <span className="text-[10px] font-semibold text-zinc-400">features</span>
            </div>

            <div className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/90">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400">
                <PlugZap size={13} className="h-3.5 w-3.5" />
              </span>
              <span className="text-xs font-black text-zinc-900 dark:text-white">
                {connectedCount} / {featureCatalog.length}
              </span>
              <span className="text-[10px] font-semibold text-zinc-400">connected</span>
            </div>

            <div className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/90">
              <Search size={13} className="h-3.5 w-3.5 text-zinc-400" />
              <span className="text-xs font-black text-zinc-900 dark:text-white">{totalVisibleFeatures}</span>
              <span className="text-[10px] font-semibold text-zinc-400">visible</span>
            </div>
          </div>
        </div>

        {/* Filter chips */}
        <div className="mt-3">
          <FilterChips
            activeFilter={activeFilter}
            onFilterChange={handleFilterChange}
            connectedPlatforms={connectedPlatformIds}
            totalVisibleFeatures={totalVisibleFeatures}
          />
        </div>
      </div>

      {/* ── Actions bar ── */}
      {filteredCatalog.length > 0 && (
        <div className="mb-4 flex items-center justify-between">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Showing <span className="font-bold text-zinc-700 dark:text-zinc-200">{filteredCatalog.length}</span> integration{filteredCatalog.length !== 1 ? "s" : ""} ·{" "}
            <span className="font-bold text-zinc-700 dark:text-zinc-200">{totalVisibleFeatures}</span> feature{totalVisibleFeatures !== 1 ? "s" : ""}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExpandAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <ChevronDown size={14} className="h-3.5 w-3.5" />
              Expand All
            </button>
            <button
              type="button"
              onClick={handleCollapseAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <ChevronUp size={14} className="h-3.5 w-3.5" />
              Collapse All
            </button>
          </div>
        </div>
      )}

      {/* ── Integration cards ── */}
      {filteredCatalog.length > 0 ? (
        <div className="space-y-4">
          {filteredCatalog.map((group) => (
            <div
              key={group.id}
              ref={(el) => {
                if (el) integrationRefs.current.set(group.id, el);
              }}
            >
              <FeatureSection
                group={group}
                status={statusByPlatform.get(group.id) ?? "not-connected"}
                isOpen={expandedIds.has(group.id)}
                onToggle={(isOpen) => handleToggle(group.id, isOpen)}
                onPromptCopied={() => showToast("Prompt copied")}
                tryNowBaseHref={AI_ASSISTANT_HREF}
                searchQuery={query}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-zinc-200 p-12 text-center dark:border-zinc-700">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800">
            <Search size={28} className="h-7 w-7 text-zinc-300 dark:text-zinc-600" />
          </div>
          <div>
            <p className="text-sm font-bold text-zinc-700 dark:text-zinc-200">No matching features found.</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Try adjusting your search or filters to find what you need.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setQuery(""); setActiveFilter("all"); }}
            className="mt-1 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-700 transition-all hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >
            Clear Search
          </button>
        </div>
      )}

      {/* ── Footer hint ── */}
      <p className="mt-8 flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
        <MessageIcon size={13} className="h-3 w-3" />
        Click any feature to copy its example prompt, or use Try Now to open the{" "}
        <Link href={AI_ASSISTANT_HREF} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">
          AI Assistant
        </Link>
        .
      </p>

      {/* ── Toast ── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="fixed bottom-6 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-900 px-4 py-2.5 text-xs font-semibold text-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            <Check size={14} className="h-3.5 w-3.5 text-emerald-400 dark:text-emerald-600" />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
