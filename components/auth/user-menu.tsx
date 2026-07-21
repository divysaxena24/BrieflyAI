"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "@/app/actions";

export type UserMenuProps = {
  name: string | null;
  email: string | null;
  avatar: string | null;
};

/** Derive initials from a name or email for the avatar fallback */
function getInitials(name: string | null, email: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0][0]?.toUpperCase() ?? "?";
  }
  if (email) return email[0].toUpperCase();
  return "?";
}

/**
 * User menu dropdown displayed in the navbar when the user is
 * authenticated. Shows the user's avatar (or initial fallback), name,
 * links to Dashboard, and a sign-out action.
 */
export default function UserMenu({ name, email, avatar }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const displayName = name ?? email ?? "User";
  const initials = getInitials(name, email);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-2 rounded-full p-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
        aria-label="User menu"
        aria-expanded={open}
      >
        {avatar ? (
          <img
            src={avatar}
            alt=""
            className="h-8 w-8 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 text-xs font-bold text-white">
            {initials}
          </div>
        )}
        <span className="hidden text-sm font-medium text-zinc-700 sm:block dark:text-zinc-300">
          {displayName}
        </span>
        <svg
          className={`hidden h-4 w-4 text-zinc-500 transition-transform sm:block ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop to close on outside click */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />

          <div className="absolute right-0 z-50 mt-2 w-56 origin-top-right rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            {/* User info */}
            <div className="border-b border-zinc-100 px-3 pb-2 dark:border-zinc-800">
              <p className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                {displayName}
              </p>
              {email && (
                <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {email}
                </p>
              )}
            </div>

            {/* Dashboard link */}
            <div className="pt-1">
              <Link
                href="/dashboard"
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                onClick={() => setOpen(false)}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                  />
                </svg>
                Dashboard
              </Link>
            </div>

            {/* Sign out */}
            <form action={signOut} className="pt-1">
              <button
                type="submit"
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-zinc-300 dark:hover:bg-red-900/20 dark:hover:text-red-400"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                  />
                </svg>
                Sign Out
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
