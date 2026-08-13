"use client";

import React from "react";
import { motion } from "framer-motion";

/** The standard card container every settings section uses. */
export function SettingsCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90 sm:p-6 ${className}`}
    >
      {children}
    </motion.div>
  );
}

/** Small uppercase label for a group of controls inside a card. */
export function ControlGroupTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
      {children}
    </p>
  );
}
