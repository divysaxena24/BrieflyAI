"use client";

import React from "react";
import { Loader2Icon } from "@/components/dashboard/icons";

type ButtonVariant = "primary" | "secondary" | "danger" | "dangerOutline";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-600 text-white shadow-md shadow-brand-600/20 hover:bg-brand-500 dark:bg-brand-500 dark:hover:bg-brand-400",
  secondary:
    "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-500 dark:bg-red-600 dark:hover:bg-red-500",
  dangerOutline:
    "border border-red-200 bg-white text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/40",
};

interface SettingButtonProps {
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
}

/** Consistent button styling for settings actions. */
export function SettingButton({
  variant = "secondary",
  loading = false,
  disabled,
  onClick,
  className = "",
  children,
  ...rest
}: SettingButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading && <Loader2Icon size={13} className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}
