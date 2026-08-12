import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getCurrentUser } from "@/lib/auth";
import Link from "next/link";
import { ConfirmationProvider } from "@/components/ConfirmationDialog";
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
  title: "BrieflyAI - Your AI Personal Agent",
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
      <body className="min-h-full flex flex-col">
        {/* Global confirmation dialog for all destructive actions */}
        <ConfirmationProvider>
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
        </ConfirmationProvider>
      </body>
    </html>
  );
}
