"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, ArrowRight } from "lucide-react";

interface FeaturePromptProps {
  prompt: string;
  onCopied?: (prompt: string) => void;
  tryNowHref?: string;
}

export const FeaturePrompt: React.FC<FeaturePromptProps> = ({ prompt, onCopied, tryNowHref }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(
    async (event?: React.MouseEvent) => {
      event?.stopPropagation();
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        // best-effort
      }
      setCopied(true);
      onCopied?.(prompt);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    },
    [prompt, onCopied],
  );

  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 dark:border-zinc-700 dark:bg-zinc-800/80">
      <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-600 dark:text-zinc-300">
        &ldquo;{prompt}&rdquo;
      </span>
      <button
        type="button"
        onClick={(event) => void handleCopy(event)}
        title="Copy prompt"
        aria-label="Copy prompt"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-brand-600 dark:hover:bg-zinc-700 dark:hover:text-brand-400"
      >
        {copied ? (
          <Check size={12} className="h-3 w-3 text-emerald-500" />
        ) : (
          <Copy size={12} className="h-3 w-3" />
        )}
      </button>
      {tryNowHref && (
        <a
          href={tryNowHref}
          onClick={(event) => event.stopPropagation()}
          title="Try in AI Assistant"
          aria-label="Try in AI Assistant"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-brand-600 dark:hover:bg-zinc-700 dark:hover:text-brand-400"
        >
          <ArrowRight size={12} className="h-3 w-3" />
        </a>
      )}
    </div>
  );
};
