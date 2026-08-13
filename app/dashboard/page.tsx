import { requireUser } from "@/lib/auth";
import { DashboardHero } from "@/components/dashboard/DashboardHero";
import { OverviewCards } from "@/components/dashboard/OverviewCards";
import { IntegrationOverview } from "@/components/dashboard/IntegrationOverview";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { RecentConversations } from "@/components/dashboard/RecentConversations";
import { ActivityTimeline } from "@/components/dashboard/ActivityTimeline";
import { GettingStarted } from "@/components/dashboard/GettingStarted";

/**
 * Dashboard — an AI-first overview answering, at a glance:
 * 1. Am I connected?   → Connected Integrations
 * 2. What can the AI do? → AI Overview Cards + AI Quick Actions
 * 3. What has the AI done recently? → Recent Conversations + Activity Timeline
 * 4. What should I do next? → Getting Started (new users only)
 *
 * Every number rendered comes from real data (integration status, activity
 * logs, conversation history, and the feature catalog) — nothing fabricated.
 */
export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <div>
      {/* 1. Welcome Hero */}
      <DashboardHero userFullName={user.fullName} userEmail={user.email} />

      {/* 2. AI Overview Cards */}
      <OverviewCards />

      {/* 3. Connected Integrations + AI Quick Actions */}
      <div className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-white">
              Connected Integrations
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Your live connection status and last sync
            </p>
          </div>
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <IntegrationOverview />
          </div>
          <div>
            <div className="mb-4">
              <h2 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-white">
                AI Quick Actions
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                One-tap prompts for the AI Assistant
              </p>
            </div>
            <QuickActions />
          </div>
        </div>
      </div>

      {/* 4. Recent AI Conversations + AI Activity Timeline */}
      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <RecentConversations />
        <ActivityTimeline />
      </div>

      {/* 5. Getting Started (new users only) */}
      <GettingStarted />
    </div>
  );
}
