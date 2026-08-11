import React from "react";
import { PageHeader } from "@/components/dashboard";
import { SettingsIcon, GmailMailIcon } from "@/components/dashboard/icons";

export default function SettingsPage() {
  return (
    <div>
      <PageHeader
        title="Settings & Preferences"
        description="Manage your account profile, notification controls, security settings, and AI engine preferences."
      />

      <div className="grid gap-6 md:grid-cols-3">
        {/* Settings Nav Sidebar */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
          <div className="space-y-1">
            {[
              { label: "Profile & Account", active: true },
              { label: "AI Model & Tuning", active: false },
              { label: "Notification Channels", active: false },
              { label: "Security & API Keys", active: false },
              { label: "Billing & Invoices", active: false },
            ].map((item, idx) => (
              <button
                key={idx}
                type="button"
                className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-xs font-bold transition-all ${
                  item.active
                    ? "bg-brand-600 text-white shadow-sm"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* Main Settings Form Card */}
        <div className="md:col-span-2 rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
          <h3 className="text-base font-bold text-zinc-900 dark:text-white">
            Profile Settings
          </h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Update your personal details and contact email for AI notifications.
          </p>

          <div className="mt-6 space-y-4">
            <div>
              <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300">
                Full Name
              </label>
              <input
                type="text"
                defaultValue="Briefly User"
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 p-2.5 text-xs text-zinc-900 focus:border-brand-500 focus:bg-white focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300">
                Primary Email
              </label>
              <input
                type="email"
                defaultValue="user@brieflyai.com"
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 p-2.5 text-xs text-zinc-900 focus:border-brand-500 focus:bg-white focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-white"
              />
            </div>

            <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800 flex justify-end">
              <button
                type="button"
                className="rounded-xl bg-brand-600 px-5 py-2.5 text-xs font-bold text-white shadow-md shadow-brand-600/20 hover:bg-brand-500 transition-all"
              >
                Save Preferences
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
