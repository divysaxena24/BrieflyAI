"use client";

import React from "react";
import Link from "next/link";

export interface SidebarItemProps {
  id: string;
  label: string;
  icon: React.ComponentType<any>;
  active?: boolean;
  isCollapsed?: boolean;
  badge?: string | number;
  badgeColor?: string;
  onClick?: () => void;
  href?: string;
}

export const SidebarItem: React.FC<SidebarItemProps> = ({
  label,
  icon: Icon,
  active = false,
  isCollapsed = false,
  badge,
  badgeColor = "bg-brand-500 text-white",
  onClick,
  href,
}) => {
  const content = (
    <>
      <Icon
        size={20}
        className={`h-5 w-5 shrink-0 transition-transform duration-200 group-hover:scale-110 ${
          active ? "text-white" : "text-zinc-500 group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-white"
        }`}
      />

      {!isCollapsed && (
        <span className="truncate text-sm font-medium tracking-tight">
          {label}
        </span>
      )}

      {!isCollapsed && badge !== undefined && (
        <span
          className={`ml-auto flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold ${
            active ? "bg-white/20 text-white" : badgeColor
          }`}
        >
          {badge}
        </span>
      )}

      {/* Collapsed view badge dot indicator */}
      {isCollapsed && badge !== undefined && (
        <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-white dark:ring-zinc-900" />
      )}

      {/* Collapsed view hover tooltip overlay */}
      {isCollapsed && (
        <div className="pointer-events-none absolute left-full ml-3 z-50 hidden rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-xl group-hover:block dark:bg-zinc-800 dark:text-zinc-100 whitespace-nowrap">
          {label}
          {badge !== undefined && (
            <span className="ml-1.5 rounded-full bg-brand-500/30 px-1.5 py-0.5 text-[10px] text-brand-300">
              {badge}
            </span>
          )}
        </div>
      )}
    </>
  );

  const className = `group relative flex w-full items-center gap-3.5 rounded-xl px-3.5 py-3 text-sm font-semibold transition-all duration-200 ${
    isCollapsed ? "justify-center px-0 py-3" : ""
  } ${
    active
      ? "bg-brand-600 text-white shadow-lg shadow-brand-600/25 dark:bg-brand-600 dark:text-white dark:shadow-brand-600/30"
      : "text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100"
  }`;

  if (href) {
    return (
      <Link
        href={href}
        onClick={onClick}
        title={isCollapsed ? label : undefined}
        className={className}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={isCollapsed ? label : undefined}
      className={className}
    >
      {content}
    </button>
  );
};
