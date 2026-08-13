"use client";

import React from "react";
import { ExternalLinkIcon } from "@/components/dashboard/icons";
import { ExpandableSection } from "./ExpandableSection";
import { integrationLabel, INTEGRATIONS } from "./meta";
import type { AISource } from "./types";

/** One source item as a compact, clickable card. */
function SourceItem({ source }: { source: AISource }) {
  const meta = INTEGRATIONS[source.integration as keyof typeof INTEGRATIONS];
  const Icon = meta?.icon;
  const body = (
    <>
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          meta?.iconBg ?? "bg-zinc-100 dark:bg-zinc-800"
        }`}
      >
        {Icon && <Icon size={15} className={`h-4 w-4 ${meta?.iconColor ?? "text-zinc-600 dark:text-zinc-300"}`} />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold text-zinc-900 dark:text-white">
          {source.title ?? source.type}
        </p>
        <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
          {integrationLabel(source.integration)}
          {source.type ? ` · ${source.type}` : ""}
        </p>
      </div>
      {source.url && (
        <ExternalLinkIcon
          size={13}
          className="h-3.5 w-3.5 shrink-0 text-zinc-300 transition-colors group-hover:text-brand-500 dark:text-zinc-600"
        />
      )}
    </>
  );

  const className =
    "group flex w-full items-center gap-3 rounded-xl border border-zinc-200/80 bg-white p-2.5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90 dark:hover:border-brand-800";

  if (source.url) {
    return (
      <a href={source.url} target="_blank" rel="noreferrer" className={className} title={source.title}>
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
    <div className="border-t border-zinc-200/60 pt-4 dark:border-zinc-800/60">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        Sources ({sources.length})
      </p>
      <ExpandableSection
        items={sources}
        preview={preview}
        moreLabel={(n) => `Show ${n} more sources`}
        className="grid gap-1.5 sm:grid-cols-2"
        renderItem={(source) => <SourceItem key={source.id} source={source} />}
      />
    </div>
  );
}
