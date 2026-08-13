"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, ArrowRight } from "lucide-react";
import { FeatureBadge } from "./FeatureBadge";
import { HighlightText } from "./HighlightText";
import type { FeatureItem } from "@/lib/features/featureCatalog";

interface FeatureCardProps {
  feature: FeatureItem;
  accentColor: string;
  onPromptCopied?: (prompt: string) => void;
  tryNowHref?: string;
  searchQuery?: string;
}

export const FeatureCard: React.FC<FeatureCardProps> = ({ feature, accentColor, onPromptCopied, tryNowHref, searchQuery = "" }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(feature.prompt);
    } catch {
      // best-effort
    }
    setCopied(true);
    onPromptCopied?.(feature.prompt);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [feature.prompt, onPromptCopied]);

  const Icon = feature.icon;

  return (
    <div className="flex gap-3 rounded-xl border border-zinc-100 bg-zinc-50/60 p-3 transition-all hover:border-zinc-200 hover:bg-white hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/80">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${accentColor}18`, color: accentColor }}
      >
        <Icon size={16} className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h4 className="truncate text-xs font-bold text-zinc-900 dark:text-white">
              {searchQuery ? <HighlightText text={feature.title} query={searchQuery} /> : feature.title}
            </h4>
            <FeatureBadge status={feature.status} />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleCopy}
              title="Copy prompt"
              aria-label={`Copy prompt: ${feature.prompt}`}
              className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-brand-600 dark:hover:bg-zinc-700 dark:hover:text-brand-400"
            >
              {copied ? <Check size={13} className="h-3.5 w-3.5 text-emerald-500" /> : <Copy size={13} className="h-3.5 w-3.5" />}
            </button>
            {tryNowHref && (
              <a
                href={tryNowHref}
                title="Try in AI Assistant"
                aria-label={`Try "${feature.title}" in AI Assistant`}
                className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-brand-600 dark:hover:bg-zinc-700 dark:hover:text-brand-400"
              >
                <ArrowRight size={13} className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          {searchQuery ? <HighlightText text={feature.description} query={searchQuery} tag="span" /> : feature.description}
        </p>
        <p className="mt-1.5 truncate text-[11px] text-zinc-600 dark:text-zinc-300" title={feature.prompt}>
          &ldquo;{feature.prompt}&rdquo;
        </p>
      </div>
    </div>
  );
};
