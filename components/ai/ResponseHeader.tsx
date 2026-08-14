"use client";

import React, { useState } from "react";
import { AiSparklesIcon, CheckCircleIcon, CopyIcon, RefreshCwIcon } from "@/components/dashboard/icons";
import { INTEGRATIONS, integrationLabel, toolLabel } from "./meta";
import type { IntegrationName } from "./types";

interface ResponseHeaderProps {
  title: string;
  integration?: IntegrationName | null;
  tool?: string;
  /** When provided, shows the regenerate action. */
  onRegenerate?: () => void;
  /** Plain-text content copied by the copy button. */
  copyText: string;
}

/** Large response title with the integration icon + copy/regenerate actions. */
export function ResponseHeader({ title, integration, tool, onRegenerate, copyText }: ResponseHeaderProps) {
  const [copied, setCopied] = useState(false);
  const meta = integration ? INTEGRATIONS[integration] : null;
  const Icon = meta?.icon ?? AiSparklesIcon;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable — ignore.
    }
  };

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
            meta?.iconBg ?? "bg-brand-50 dark:bg-brand-950/40"
          }`}
        >
          <Icon size={20} className={`h-5 w-5 ${meta?.iconColor ?? "text-brand-600 dark:text-brand-400"}`} />
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-base font-black tracking-tight text-zinc-900 dark:text-white sm:text-lg">
            {title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {integration && (
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${meta?.chipBg} ${meta?.chipColor}`}
              >
                {integrationLabel(integration)}
              </span>
            )}
            {tool && (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
                <AiSparklesIcon size={10} className="h-2.5 w-2.5" />
                {toolLabel(tool)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => void copy()}
          title="Copy response"
          aria-label="Copy response"
          className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-brand-300 hover:text-brand-600 hover:shadow-md active:translate-y-0 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-300 dark:hover:border-brand-700 dark:hover:text-brand-300"
        >
          {copied ? (
            <CheckCircleIcon size={14} className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <CopyIcon size={14} className="h-3.5 w-3.5" />
          )}
        </button>
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            title="Regenerate"
            aria-label="Regenerate response"
            className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-brand-300 hover:text-brand-600 hover:shadow-md active:translate-y-0 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-300 dark:hover:border-brand-700 dark:hover:text-brand-300"
          >
            <RefreshCwIcon size={13} className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
