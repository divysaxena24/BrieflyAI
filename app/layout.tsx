import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { getCurrentUser } from "@/lib/auth";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BrieflyAI — Your AI Personal Agent",
  description:
    "Connect your Gmail, WhatsApp, Telegram, and Outlook accounts. BrieflyAI generates smart summaries, sets reminders, and keeps you organized across all your platforms.",
  keywords: [
    "AI personal agent",
    "email summarizer",
    "smart reminders",
    "Gmail",
    "WhatsApp",
    "Telegram",
    "Outlook",
    "productivity",
  ],
  openGraph: {
    title: "BrieflyAI — Your AI Personal Agent",
    description:
      "Connect all your messaging platforms and let AI handle the summaries, reminders, and organization.",
    type: "website",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const currentUser = await getCurrentUser();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full scroll-smooth antialiased`}
      suppressHydrationWarning
    >
      <head />

      {/* Blocking inline script: applies .dark before first paint to prevent theme flash */}
      {/* NOTE: Script placed OUTSIDE <head> to avoid React 19's script-tag warning.
          next/script with beforeInteractive still injects it into <head> at runtime. */}
      <Script
        id="theme-init"
        strategy="beforeInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              try {
                var theme = localStorage.getItem('theme');
                var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                if (theme === 'dark' || (!theme && prefersDark)) {
                  document.documentElement.classList.add('dark');
                } else {
                  document.documentElement.classList.remove('dark');
                }
              } catch(e) {}
            })();
          `,
        }}
      />
      <body className="min-h-full flex flex-col">
        {/* Top banner when authenticated (only shown outside dashboard) */}
        {currentUser && (
          <div className="border-b border-brand-200 bg-brand-50 dark:border-brand-900 dark:bg-brand-950/30">
            <div className="mx-auto flex h-9 max-w-7xl items-center justify-between px-6">
              <span className="text-xs text-brand-700 dark:text-brand-300">
                Signed in as {currentUser.fullName ?? currentUser.email ?? "User"}
              </span>
              <Link
                href="/dashboard"
                className="text-xs font-medium text-brand-600 hover:text-brand-500 dark:text-brand-400"
              >
                Dashboard &rarr;
              </Link>
            </div>
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
