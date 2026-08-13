"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, ArrowRight } from "lucide-react";

interface FeaturePromptProps {
  /** The example prompt text. */
  prompt: string;
  /** Called when the prompt is copied to the clipboard. */
  onCopied?: (prompt: string) => void;
  /** Optional "Try Now" — opens the AI Assistant with the prompt pre-filled. */
  tryNowHref?: string;
}

/**
 * Example prompt chip with copy-to-clipboard and an optional "Try Now" link
 * that opens the AI Assistant with the prompt pre-filled.
 */
export const FeaturePrompt: React.FC<FeaturePromptProps> = ({ prompt, onCopied, tryNowHref }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear the copied check after a moment so the icon can reset.
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(
    async (event?: React.MouseEvent) => {
      // The feature card is click-to-copy too; never double-fire the toast.
      event?.stopPropagation();
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        // Clipboard API can be unavailable (e.g. insecure context) — the prompt
        // is still visible in the UI, so this is best-effort.
      }
      setCopied(true);
      onCopied?.(prompt);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    },
    [prompt, onCopied],
  );

  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-800/80">
      <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-600 dark:text-zinc-300">
        “{prompt}”
      </span>
      <button
        type="button"
        onClick={(event) => void handleCopy(event)}
        title="Copy prompt"
        aria-label="Copy prompt"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-brand-600 dark:hover:bg-zinc-700 dark:hover:text-brand-400"
      >
        {copied ? (
          <Check size={13} className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Copy size={13} className="h-3.5 w-3.5" />
        )}
      </button>
      {tryNowHref && (
        <a
          href={tryNowHref}
          onClick={(event) => event.stopPropagation()}
          title="Try in AI Assistant"
          aria-label="Try in AI Assistant"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-brand-600 dark:hover:bg-zinc-700 dark:hover:text-brand-400"
        >
          <ArrowRight size={13} className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
};
