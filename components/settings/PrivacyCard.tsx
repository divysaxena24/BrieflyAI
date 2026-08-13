"use client";

import React from "react";
import { useConfirmAction } from "@/components/ConfirmationDialog";
import { SettingsCard } from "./SettingsCard";
import { SettingButton } from "./SettingButton";
import { useToast } from "./Toast";
import { DownloadIcon, Trash2Icon } from "./icons";
import { signOut } from "@/app/actions";

/** Download the export JSON returned by the API as a file. */
async function downloadExport(): Promise<void> {
  const res = await fetch("/api/settings/export");
  if (!res.ok) throw new Error("Export failed — please try again.");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `brieflyai-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Privacy: export, clear chat history, delete account. */
export function PrivacyCard() {
  const confirmAction = useConfirmAction();
  const { show } = useToast();

  const handleExport = async () => {
    try {
      await downloadExport();
      show("Export downloaded");
    } catch (err) {
      show(err instanceof Error ? err.message : "Export failed");
    }
  };

  const handleClearHistory = async () => {
    const confirmed = await confirmAction({
      title: "Clear chat history?",
      message: "All AI conversations will be permanently removed. This cannot be undone.",
      confirmLabel: "Clear History",
      busyLabel: "Clearing…",
      onConfirm: async () => {
        const res = await fetch("/api/settings/chat-history", { method: "DELETE" });
        if (!res.ok) throw new Error("Could not clear chat history — please try again.");
      },
    });
    if (confirmed) show("Chat history deleted");
  };

  const handleDeleteAccount = async () => {
    const confirmed = await confirmAction({
      title: "Delete your account?",
      message: (
        <>
          This permanently deletes your profile, preferences, connected integrations, activity and
          chat history. You will be signed out and cannot undo this action.
        </>
      ),
      confirmLabel: "Delete Account",
      busyLabel: "Deleting…",
      onConfirm: async () => {
        const res = await fetch("/api/settings/account", { method: "DELETE" });
        if (!res.ok) throw new Error("Could not delete your account — please try again.");
      },
    });
    if (confirmed) {
      show("Account deleted");
      await signOut();
    }
  };

  return (
    <SettingsCard>
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold text-zinc-900 dark:text-white">Export My Data</p>
            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              Download your profile, preferences and conversations as a JSON file.
            </p>
          </div>
          <SettingButton variant="secondary" onClick={() => void handleExport()}>
            <DownloadIcon size={13} className="h-3.5 w-3.5" />
            Export My Data
          </SettingButton>
        </div>

        <div className="border-t border-zinc-100 dark:border-zinc-800" />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold text-zinc-900 dark:text-white">Clear Chat History</p>
            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              Remove all AI conversations. You&apos;ll need to confirm before anything is deleted.
            </p>
          </div>
          <SettingButton variant="secondary" onClick={() => void handleClearHistory()}>
            <Trash2Icon size={13} className="h-3.5 w-3.5" />
            Clear Chat History
          </SettingButton>
        </div>

        <div className="border-t border-zinc-100 dark:border-zinc-800" />

        <div className="flex flex-col gap-3 rounded-xl border border-red-200/80 bg-red-50/40 p-4 dark:border-red-900/50 dark:bg-red-950/20 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold text-red-700 dark:text-red-300">Delete Account</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-red-600/80 dark:text-red-400/80">
              Permanently delete your account and all associated data. This action cannot be undone.
            </p>
          </div>
          <SettingButton variant="danger" onClick={() => void handleDeleteAccount()}>
            <Trash2Icon size={13} className="h-3.5 w-3.5" />
            Delete Account
          </SettingButton>
        </div>
      </div>
    </SettingsCard>
  );
}
