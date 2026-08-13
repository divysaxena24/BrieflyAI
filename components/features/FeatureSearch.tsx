"use client";

import React from "react";
import { Search, X } from "lucide-react";

interface FeatureSearchProps {
  /** Current query text. */
  value: string;
  /** Called on every keystroke — filtering happens instantly, no page refresh. */
  onChange: (query: string) => void;
}

/** Search input that filters the feature catalog live as the user types. */
export const FeatureSearch: React.FC<FeatureSearchProps> = ({ value, onChange }) => {
  return (
    <div className="relative w-full max-w-xl">
      <Search
        size={16}
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400 dark:text-zinc-500"
      />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search integrations, features, prompts…"
        aria-label="Search AI features"
        className="h-11 w-full rounded-xl border border-zinc-200 bg-white pl-10 pr-10 text-sm text-zinc-900 placeholder-zinc-400 shadow-sm transition-all focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-zinc-700 dark:bg-zinc-900/80 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-brand-400"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <X size={14} className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
};
