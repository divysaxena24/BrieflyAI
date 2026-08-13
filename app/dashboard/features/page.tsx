"use client";

import React, { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Sparkles, Boxes, PlugZap } from "lucide-react";
import { FeatureSearch, FeatureSection } from "@/components/features";
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

/** Base link for "Try Now" — the prompt is appended as ?q=… */
const AI_ASSISTANT_HREF = "/dashboard/ai-chat";

/** Whether a connection status counts as "connected" for the catalog. */
function isConnectedStatus(status: string): boolean {
  return status === "connected" || status === "syncing";
}

export default function FeaturesPage() {
  const { platforms } = useIntegrationStatus();
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  /** Filter integrations + features instantly (no page refresh). */
  const filteredCatalog: IntegrationFeatureGroup[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...featureCatalog];

    return featureCatalog
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
          // The integration itself matched — show it (its features still visible).
          return { ...group, features: group.features };
        }
        if (features.length === 0) return null;
        return { ...group, features };
      })
      .filter((group): group is IntegrationFeatureGroup => group !== null);
  }, [query]);

  const showToast = (message: string) => {
    setToast(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2000);
  };

  return (
    <div>
      {/* ── Hero ── */}
      <div className="mb-8">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-brand-600 dark:text-brand-400">
          <AiSparklesIcon size={14} className="h-3.5 w-3.5" />
          Feature Catalog
        </div>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-zinc-900 dark:text-white sm:text-4xl">
          AI Features
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
          Explore everything BrieflyAI can do across your connected integrations.
        </p>

        {/* Search + stats */}
        <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <FeatureSearch value={query} onChange={setQuery} />

          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/90">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400">
                <Boxes size={15} className="h-4 w-4" />
              </span>
              <div>
                <p className="text-base font-black leading-none text-zinc-900 dark:text-white">
                  {supportedFeatureCount()}
                </p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                  Supported features
                </p>
              </div>
            </div>

            <div className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/90">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400">
                <PlugZap size={15} className="h-4 w-4" />
              </span>
              <div>
                <p className="text-base font-black leading-none text-zinc-900 dark:text-white">
                  {connectedCount} / {featureCatalog.length}
                </p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                  Connected integrations
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Integration cards ── */}
      {filteredCatalog.length > 0 ? (
        <div className="space-y-5">
          {filteredCatalog.map((group, index) => (
            <FeatureSection
              key={group.id}
              group={group}
              status={statusByPlatform.get(group.id) ?? "not-connected"}
              defaultOpen={index === 0 || query.trim().length > 0}
              onPromptCopied={() => showToast("Prompt copied")}
              tryNowBaseHref={AI_ASSISTANT_HREF}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-zinc-200 p-12 text-center dark:border-zinc-700">
          <Sparkles size={22} className="h-6 w-6 text-zinc-300 dark:text-zinc-600" />
          <p className="text-sm font-bold text-zinc-700 dark:text-zinc-200">
            No features match “{query}”
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Try a different search, or browse the catalog below.
          </p>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="mt-1 rounded-xl border border-zinc-200 bg-white px-3.5 py-2 text-xs font-semibold text-zinc-700 transition-all hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >
            Clear search
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
