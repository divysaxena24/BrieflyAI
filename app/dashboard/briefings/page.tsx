import React from "react";
import { PageHeader } from "@/components/dashboard";
import { BriefingsIcon, AiSparklesIcon, GmailMailIcon, TelegramSendIcon } from "@/components/dashboard/icons";

export default function BriefingsPage() {
  const briefingsList = [
    {
      title: "Morning Executive Brief",
      time: "Today, 8:00 AM",
      icon: GmailMailIcon,
      source: "Gmail Inbox",
      summary: "Received 18 messages. 3 high-priority emails requiring your signature: Q3 Financial Audit, Contract Renewal, and Team Budget Approval.",
      badge: "High Priority",
      badgeColor: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300",
    },
    {
      title: "Telegram Community Catchup",
      time: "Yesterday, 6:30 PM",
      icon: TelegramSendIcon,
      source: "Dev & Design Group",
      summary: "Main topic: UI Dashboard refactoring completed. Next deployment scheduled for Wednesday. 2 pull requests ready for review.",
      badge: "Digest",
      badgeColor: "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Briefings & Daily Digests"
        description="View smart, automated AI summaries generated across your connected messaging channels."
        badge="3 New Briefs"
        action={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-md shadow-brand-600/20 transition-all hover:bg-brand-500">
            <AiSparklesIcon size={16} /> Generate On-Demand Digest
          </button>
        }
      />

      <div className="space-y-4">
        {briefingsList.map((item, idx) => {
          const Icon = item.icon;
          return (
            <div
              key={idx}
              className="group overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm transition-all hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3.5">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/50 dark:text-brand-400">
                    <Icon size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-white">
                      {item.title}
                    </h3>
                    <p className="text-xs text-zinc-400">
                      {item.source} &bull; {item.time}
                    </p>
                  </div>
                </div>
                <span className={`inline-flex self-start sm:self-center rounded-full px-3 py-1 text-xs font-bold ${item.badgeColor}`}>
                  {item.badge}
                </span>
              </div>

              <p className="mt-4 text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed bg-zinc-50 p-4 rounded-xl dark:bg-zinc-800/40">
                {item.summary}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
