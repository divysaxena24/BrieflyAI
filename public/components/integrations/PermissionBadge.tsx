"use client";

import React from "react";
import { LockIcon } from "@/components/dashboard/icons";

interface PermissionBadgeProps {
  level: string;
}

export const PermissionBadge: React.FC<PermissionBadgeProps> = ({ level }) => {
  const label = level === "read" ? "Read Only" : level === "write" ? "Read & Write" : level === "admin" ? "Full Access" : level;

  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      <LockIcon size={10} className="h-2.5 w-2.5" />
      {label}
    </span>
  );
};
