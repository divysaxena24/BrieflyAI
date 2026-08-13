"use client";

import React, { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { FeatureCard } from "./FeatureCard";
import { ConnectionBadge } from "@/components/integrations";
import type { ConnectionStatus } from "@/lib/integrations/types";
import type { IntegrationFeatureGroup } from "@/lib/features/featureCatalog";

interface FeatureSectionProps {
  /** The integration + its features, from the catalog. */
  group: IntegrationFeatureGroup;
  /** Live connection status from the integration store. */
  status: ConnectionStatus;
  /** Whether the card starts expanded. */
  defaultOpen?: boolean;
  /** Called when an example prompt is copied. */
  onPromptCopied?: (prompt: string) => void;
  /** "Try Now" base link (the prompt is appended as the ?q= query param). */
  tryNowBaseHref?: string;
}

/** Expandable card for one integration: header + collapsible feature list. */
export const FeatureSection: React.FC<FeatureSectionProps> = ({
  group,
  status,
  defaultOpen = false,
  onPromptCopied,
  tryNowBaseHref,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = group.icon;

  const supportedCount = group.features.filter((f) => f.status === "supported").length;

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90">
      {/* ── Header (always visible) ── */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-3.5 px-5 py-4 text-left transition-colors hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 sm:px-6"
      >
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{ backgroundColor: `${group.accentColor}18`, color: group.accentColor }}
        >
          <Icon size={22} className="h-5.5 w-5.5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-zinc-900 dark:text-white">{group.name}</h3>
            <ConnectionBadge status={status} />
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{group.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 sm:inline-flex">
            {group.features.length} capabilities
            {supportedCount !== group.features.length && (
              <span className="ml-1 text-emerald-600 dark:text-emerald-400">· {supportedCount} supported</span>
            )}
          </span>
          <ChevronDown
            size={18}
            className={`h-4.5 w-4.5 shrink-0 text-zinc-400 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {/* ── Collapsible body (grid-rows animation, matching the in-app guides) ── */}
      <div
        role="region"
        aria-label={`${group.name} features`}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-4 border-t border-zinc-200 px-5 pb-5 pt-4 dark:border-zinc-800 sm:px-6">
            {group.banner && (
              <div className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50/70 p-3 dark:border-sky-900/60 dark:bg-sky-950/30">
                <Info size={15} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                <div>
                  <p className="text-xs font-bold text-sky-800 dark:text-sky-200">{group.banner.title}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-sky-700/90 dark:text-sky-300/90">
                    {group.banner.message}
                  </p>
                </div>
              </div>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              {group.features.map((feature) => (
                <FeatureCard
                  key={feature.title}
                  feature={feature}
                  accentColor={group.accentColor}
                  onPromptCopied={onPromptCopied}
                  tryNowHref={tryNowBaseHref ? `${tryNowBaseHref}?q=${encodeURIComponent(feature.prompt)}` : undefined}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
