"use client";

import React from "react";
import { FeatureBadge } from "./FeatureBadge";
import { FeaturePrompt } from "./FeaturePrompt";
import type { FeatureItem } from "@/lib/features/featureCatalog";

interface FeatureCardProps {
  /** The feature to render. */
  feature: FeatureItem;
  /** Accent color of the owning integration (used for the icon chip). */
  accentColor: string;
  /** Called when the example prompt is copied (or the feature is clicked). */
  onPromptCopied?: (prompt: string) => void;
  /** Optional "Try Now" link to the AI Assistant with the prompt pre-filled. */
  tryNowHref?: string;
}

/** A single feature row: icon, title, description, example prompt, status badge. */
export const FeatureCard: React.FC<FeatureCardProps> = ({
  feature,
  accentColor,
  onPromptCopied,
  tryNowHref,
}) => {
  const Icon = feature.icon;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPromptCopied?.(feature.prompt)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPromptCopied?.(feature.prompt);
        }
      }}
      title={`Copy prompt: ${feature.prompt}`}
      className="group flex w-full cursor-pointer flex-col gap-3 rounded-xl border border-zinc-100 bg-zinc-50/60 p-3.5 text-left transition-all hover:border-zinc-200 hover:bg-white hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30 dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/80 sm:flex-row sm:items-start"
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${accentColor}18`, color: accentColor }}
      >
        <Icon size={17} className="h-4.5 w-4.5" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-bold text-zinc-900 dark:text-white">{feature.title}</h4>
          <FeatureBadge status={feature.status} />
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {feature.description}
        </p>
        <div className="mt-2.5">
          <FeaturePrompt prompt={feature.prompt} onCopied={onPromptCopied} tryNowHref={tryNowHref} />
        </div>
      </div>
    </div>
  );
};
