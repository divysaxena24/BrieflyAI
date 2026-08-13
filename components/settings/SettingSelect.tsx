"use client";

import React from "react";
import { ChevronDownIcon } from "@/components/dashboard/icons";

export interface SelectOption {
  value: string;
  label: string;
}

interface SettingSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
}

/** Styled native select (accessible, keyboard-friendly) with a chevron. */
export function SettingSelect({ label, value, onChange, options, disabled }: SettingSelectProps) {
  return (
    <div>
      <label htmlFor={`select-${label}`} className="block text-xs font-bold text-zinc-900 dark:text-white">
        {label}
      </label>
      <div className="relative mt-1.5">
        <select
          id={`select-${label}`}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="w-full cursor-pointer appearance-none rounded-xl border border-zinc-200 bg-white py-2.5 pl-3 pr-9 text-xs font-medium text-zinc-800 shadow-sm transition-colors hover:border-zinc-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:border-zinc-600"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          size={14}
          className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
        />
      </div>
    </div>
  );
}
