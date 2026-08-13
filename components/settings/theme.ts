"use client";

import type { ThemeMode } from "@/lib/settings/types";

/** Whether the given mode resolves to dark, honoring the system preference. */
export function isDarkMode(mode: ThemeMode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Apply a theme mode to the document and persist it locally. */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle("dark", isDarkMode(mode));
  localStorage.setItem("theme", mode);
}
