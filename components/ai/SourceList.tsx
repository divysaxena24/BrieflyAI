"use client";

import React from "react";
import { AiSparklesIcon, ExternalLinkIcon } from "@/components/dashboard/icons";
import { ExpandableSection } from "./ExpandableSection";
import { integrationLabel, INTEGRATIONS } from "./meta";
import type { AISource } from "./types";

/** One source item as a premium, clickable card. */
function SourceItem({ source }: { source: AISource }) {
  const meta = INTEGRATIONS[source.integration as keyof typeof INTEGRATIONS];
  const Icon = meta?.icon ?? AiSparklesIcon;

  const body = (
    <>
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-sm ${
          meta?.iconBg ?? "bg-zinc-100 dark:bg-zinc-800"
        }`}
      >
        <Icon size={16} className={`h-4 w-4 ${meta?.iconColor ?? "text-zinc-600 dark:text-zinc-300"}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold text-zinc-900 dark:text-white">
          {source.title ?? source.type}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
          {integrationLabel(source.integration)}
          {source.type ? ` · ${source.type}` : ""}
        </p>
      </div>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-300 transition-all duration-300 group-hover:border-brand-300 group-hover:bg-brand-50 group-hover:text-brand-600 dark:border-zinc-700 dark:text-zinc-600 dark:group-hover:border-brand-700 dark:group-hover:bg-brand-950/40 dark:group-hover:text-brand-300">
        <ExternalLinkIcon size={13} className="h-3.5 w-3.5" />
      </span>
    </>
  );

  const className =
    "group flex w-full items-center gap-3 rounded-2xl border border-zinc-200/80 bg-white p-3 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md active:translate-y-0 dark:border-zinc-800/80 dark:bg-zinc-900/90 dark:hover:border-brand-800 dark:hover:shadow-black/20";

  if (source.url) {
    return (
      <a href={source.url} target="_blank" rel="noreferrer" className={className} title={source.title ?? source.type}>
        {body}
      </a>
    );
  }
  return <div className={className}>{body}</div>;
}

/** Collapsible list of source references. */
export function SourceList({ sources, preview = 5 }: { sources: readonly AISource[]; preview?: number }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div>
      <p className="mb-2.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        <ExternalLinkIcon size={11} className="h-2.5 w-2.5" />
        Sources ({sources.length})
      </p>
      <ExpandableSection
        items={sources}
        preview={preview}
        moreLabel={(n) => `Show ${n} more sources`}
        className="grid gap-2 sm:grid-cols-2"
        renderItem={(source) => <SourceItem key={source.id} source={source} />}
      />
    </div>
  );
}
