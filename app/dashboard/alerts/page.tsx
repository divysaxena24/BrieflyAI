import React from "react";
import { PageHeader } from "@/components/dashboard";
import { AlertsIcon, ClockReminderIcon, AiSparklesIcon } from "@/components/dashboard/icons";

export default function AlertsPage() {
  const alertsList = [
    {
      title: "Contract Renewal Deadline",
      due: "Due today at 4:00 PM",
      source: "Gmail (Legal Dept)",
      status: "Active",
      priority: "High",
    },
    {
      title: "Design Review Sync",
      due: "Tomorrow at 10:00 AM",
      source: "Telegram (Team Group)",
      status: "Scheduled",
      priority: "Medium",
    },
    {
      title: "Quarterly Tax Filing Confirmation",
      due: "Friday at 5:00 PM",
      source: "Outlook Calendar",
      status: "Scheduled",
      priority: "High",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Alerts & Smart Reminders"
        description="Set automated trigger notifications and manage your active AI reminders."
        badge="6 Active Alerts"
        action={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-md shadow-brand-600/20 transition-all hover:bg-brand-500">
            <ClockReminderIcon size={16} /> Create Reminder
          </button>
        }
      />

      <div className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertsIcon size={20} className="text-brand-600 dark:text-brand-400" />
            <h2 className="text-base font-bold text-zinc-900 dark:text-white">
              Upcoming Trigger Reminders
            </h2>
          </div>
          <span className="text-xs text-zinc-400">Automated AI Reminders</span>
        </div>

        <div className="space-y-3">
          {alertsList.map((alert, idx) => (
            <div
              key={idx}
              className="flex flex-col gap-3 rounded-xl border border-zinc-100 bg-zinc-50/60 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800 dark:bg-zinc-800/40"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-brand-600 shadow-sm dark:bg-zinc-800 dark:text-brand-400">
                  <ClockReminderIcon size={20} />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-zinc-900 dark:text-white">
                    {alert.title}
                  </h4>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    {alert.due} &bull; <span className="font-semibold">{alert.source}</span>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 self-end sm:self-center">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                    alert.priority === "High"
                      ? "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                  }`}
                >
                  {alert.priority} Priority
                </span>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
