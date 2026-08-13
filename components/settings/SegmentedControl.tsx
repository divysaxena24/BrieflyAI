"use client";

import React from "react";

export interface SegmentOption {
  value: string;
  label: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}

interface SegmentedControlProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SegmentOption[];
  disabled?: boolean;
}

/** Accessible segmented control (implemented as a radio group). */
export function SegmentedControl({ label, value, onChange, options, disabled }: SegmentedControlProps) {
  return (
    <div>
      <span className="block text-xs font-bold text-zinc-900 dark:text-white">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="mt-1.5 inline-flex w-full rounded-xl border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-700 dark:bg-zinc-800/60 sm:w-auto"
      >
        {options.map((option) => {
          const Icon = option.icon;
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:flex-none ${
                selected
                  ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-700 dark:text-white dark:ring-zinc-600"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
            >
              {Icon && <Icon size={13} className="h-3.5 w-3.5" />}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
