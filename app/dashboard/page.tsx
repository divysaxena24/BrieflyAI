import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/dashboard";
import {
  MessageIcon,
  ClockReminderIcon,
  PlatformLinkIcon,
  UpgradeZapIcon,
  GmailMailIcon,
  TelegramSendIcon,
  OutlookCalendarIcon,
  AiSparklesIcon,
  ArrowRightIcon,
  TrendingUpIcon,
  ActivityStreamIcon,
  CheckCircleIcon,
} from "@/components/dashboard/icons";

/** Derive initials fallback for the avatar */
function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0][0]?.toUpperCase() ?? email[0].toUpperCase();
  }
  return email[0].toUpperCase();
}

export default async function DashboardPage() {
  const user = await requireUser();
  const initials = getInitials(user.fullName, user.email);

  const stats = [
    { label: "Messages Summarized", value: "128", icon: MessageIcon, change: "+24% this week", color: "text-brand-500 bg-brand-50 dark:bg-brand-950/50" },
    { label: "Active Reminders", value: "6", icon: ClockReminderIcon, change: "2 due today", color: "text-amber-500 bg-amber-50 dark:bg-amber-950/50" },
    { label: "Connected Platforms", value: "3 / 4", icon: PlatformLinkIcon, change: "Gmail, WhatsApp, Telegram", color: "text-emerald-500 bg-emerald-50 dark:bg-emerald-950/50" },
    { label: "AI Credits Used", value: "450 / 1000", icon: UpgradeZapIcon, change: "Pro Plan active", color: "text-violet-500 bg-violet-50 dark:bg-violet-950/50" },
  ];

  const platforms = [
    { name: "Gmail", icon: GmailMailIcon, desc: "Read, summarize, and organize your inbox", connected: true, gradient: "from-red-50 to-red-100/50 dark:from-red-950/30 dark:to-red-900/20", border: "border-red-200 dark:border-red-900/50" },
    { name: "WhatsApp", icon: MessageIcon, desc: "Never miss important chat updates", connected: true, gradient: "from-emerald-50 to-emerald-100/50 dark:from-emerald-950/30 dark:to-emerald-900/20", border: "border-emerald-200 dark:border-emerald-900/50" },
    { name: "Telegram", icon: TelegramSendIcon, desc: "Summarize group messages & key action items", connected: true, gradient: "from-sky-50 to-sky-100/50 dark:from-sky-950/30 dark:to-sky-900/20", border: "border-sky-200 dark:border-sky-900/50" },
    { name: "Outlook", icon: OutlookCalendarIcon, desc: "Sync calendar events and emails seamlessly", connected: false, gradient: "from-blue-50 to-blue-100/50 dark:from-blue-950/30 dark:to-blue-900/20", border: "border-blue-200 dark:border-blue-900/50" },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard Overview"
        description="Monitor your automated AI streams, summary metrics, and active messaging platforms."
        badge="Live Metrics"
        action={
          <Link
            href="/dashboard/ai-agent"
            className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-md shadow-brand-600/20 transition-all hover:bg-brand-500"
          >
            <AiSparklesIcon size={16} /> Launch AI Agent
          </Link>
        }
      />

      {/* ─── Welcome Header Card ─── */}
      <div className="mb-8 overflow-hidden rounded-3xl border border-zinc-200/80 bg-gradient-to-r from-brand-600 via-brand-500 to-accent-600 p-6 sm:p-8 text-white shadow-xl shadow-brand-500/15 dark:border-brand-900/40">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-5">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 text-2xl font-black text-white backdrop-blur-md ring-4 ring-white/20 shadow-inner">
              {initials}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl text-white">
                  Welcome back{user.fullName ? `, ${user.fullName}` : ""}!
                </h1>
                <AiSparklesIcon size={24} className="h-6 w-6 text-amber-300 animate-pulse" />
              </div>
              <p className="mt-1 text-sm text-brand-100">
                Your AI agent is active and monitoring <span className="font-semibold text-white">{user.email}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-white/10 px-4 text-xs font-semibold text-white backdrop-blur-md transition-all hover:bg-white/20 active:scale-95"
            >
              Back to Home
            </Link>
            <Link
              href="/dashboard/pricing"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-xs font-bold text-brand-700 shadow-md transition-all hover:bg-brand-50 active:scale-95"
            >
              <UpgradeZapIcon size={16} className="h-4 w-4 fill-current text-brand-600" />
              Upgrade Plan
            </Link>
          </div>
        </div>
      </div>

      {/* ─── Stats Grid ─── */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="group relative overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90"
            >
              <div className="mb-3 flex items-center justify-between">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${stat.color}`}>
                  <Icon size={20} className="h-5 w-5" />
                </div>
                <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                  <TrendingUpIcon size={12} className="h-3 w-3" />
                  {stat.change}
                </span>
              </div>
              <p className="text-2xl font-black tracking-tight text-zinc-900 dark:text-white">
                {stat.value}
              </p>
              <p className="mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {stat.label}
              </p>
            </div>
          );
        })}
      </div>

      {/* ─── Connected Platforms ─── */}
      <div className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-white">
              Connected Platforms
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Manage your connected channels & AI summary streams
            </p>
          </div>
          <Link href="/dashboard/integrations" className="text-xs font-bold text-brand-600 hover:text-brand-500 dark:text-brand-400">
            View All Integrations &rarr;
          </Link>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {platforms.map((platform) => {
            const Icon = platform.icon;
            return (
              <div
                key={platform.name}
                className={`group relative flex flex-col justify-between overflow-hidden rounded-2xl border bg-gradient-to-b ${platform.gradient} ${platform.border} p-5 transition-all duration-300 hover:shadow-md`}
              >
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/80 dark:bg-zinc-800/80 text-zinc-900 dark:text-white shadow-sm">
                      <Icon size={20} className="h-5 w-5" />
                    </div>
                    {platform.connected ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100/80 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                        <CheckCircleIcon size={12} className="h-3 w-3" /> Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        Disconnected
                      </span>
                    )}
                  </div>
                  <h3 className="font-bold text-zinc-900 dark:text-white">
                    {platform.name}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                    {platform.desc}
                  </p>
                </div>

                <Link
                  href="/dashboard/integrations"
                  className="mt-4 flex items-center justify-between rounded-xl bg-white/60 px-3 py-2 text-xs font-semibold text-zinc-700 transition-all hover:bg-white dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Configure
                  <ArrowRightIcon size={14} className="h-3.5 w-3.5 text-zinc-400 group-hover:translate-x-0.5 transition-transform" />
                </Link>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Two Column: Activity & Quick Actions ─── */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent Activity */}
        <div className="lg:col-span-2 rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ActivityStreamIcon size={20} className="h-5 w-5 text-brand-600 dark:text-brand-400" />
              <h2 className="text-base font-bold text-zinc-900 dark:text-white">
                Live AI Activity Stream
              </h2>
            </div>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">Real-time</span>
          </div>

          <div className="space-y-4">
            {[
              { time: "Just now", event: "Inbox Daily Brief generated", detail: "Summarized 14 new emails from Gmail", dot: "bg-brand-500" },
              { time: "10 min ago", event: "WhatsApp reminder set", detail: "Meeting with Design Team tomorrow at 10 AM", dot: "bg-emerald-500" },
              { time: "1 hour ago", event: "Telegram digest ready", detail: "3 key decisions extracted from Dev Channel", dot: "bg-sky-500" },
            ].map((item, i) => (
              <div key={i} className="flex gap-3.5 items-start">
                <div className={`mt-1 h-3 w-3 rounded-full shrink-0 ring-4 ring-zinc-100 dark:ring-zinc-800 ${item.dot}`} />
                <div className="min-w-0 flex-1 border-b border-zinc-100 pb-3 dark:border-zinc-800/60 last:border-0">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-zinc-900 dark:text-white">{item.event}</p>
                    <span className="text-[10px] text-zinc-400">{item.time}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/90">
          <h2 className="mb-4 text-base font-bold text-zinc-900 dark:text-white">
            Quick Actions
          </h2>
          <div className="space-y-3">
            {[
              { label: "Generate Daily Brief", icon: AiSparklesIcon, href: "/dashboard/briefings", desc: "Run instant digest across all channels" },
              { label: "Create AI Reminder", icon: ClockReminderIcon, href: "/dashboard/alerts", desc: "Set smart automated notifications" },
              { label: "Connect Platform", icon: PlatformLinkIcon, href: "/dashboard/integrations", desc: "Integrate new messaging channel" },
            ].map((action) => {
              const Icon = action.icon;
              return (
                <Link
                  key={action.label}
                  href={action.href}
                  className="flex w-full items-center gap-3.5 rounded-xl border border-zinc-200/80 bg-zinc-50/60 p-3 text-left transition-all hover:border-brand-300 hover:bg-brand-50/40 dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-brand-800 dark:hover:bg-brand-950/20"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-brand-600 shadow-sm dark:bg-zinc-800 dark:text-brand-400">
                    <Icon size={18} className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-zinc-900 dark:text-white">{action.label}</p>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{action.desc}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
