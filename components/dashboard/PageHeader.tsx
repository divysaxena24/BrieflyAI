"use client";

import React from "react";

export interface PageHeaderProps {
  title: string;
  description: string;
  badge?: string;
  action?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  badge,
  action,
}) => {
  return (
    <div className="mb-8 flex flex-col gap-4 border-b border-zinc-200/80 pb-6 dark:border-zinc-800/80 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="flex items-center gap-2.5">
          <h1 className="text-2xl font-black tracking-tight text-zinc-900 dark:text-white sm:text-3xl">
            {title}
          </h1>
          {badge && (
            <span className="inline-flex items-center rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-bold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {description}
        </p>
      </div>

      {action && <div className="flex items-center gap-3">{action}</div>}
    </div>
  );
};
