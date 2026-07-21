import { requireUser } from "@/lib/auth";
import Link from "next/link";
import { signOut } from "@/app/actions";

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
    { label: "Messages Summarized", value: "—", icon: "📝", change: "+12 this week" },
    { label: "Active Reminders", value: "—", icon: "⏰", change: "Set up your first" },
    { label: "Connected Platforms", value: "0 / 4", icon: "🔗", change: "Connect now" },
    { label: "AI Credits Used", value: "0", icon: "⚡", change: "Free plan" },
  ];

  const platforms = [
    { name: "Gmail", icon: "✉️", desc: "Read, summarize, and organize your inbox", connected: false, gradient: "from-red-50 to-red-100 dark:from-red-950/30 dark:to-red-900/20", border: "border-red-200 dark:border-red-900/50", badge: "bg-red-500" },
    { name: "WhatsApp", icon: "💬", desc: "Never miss important messages", connected: false, gradient: "from-emerald-50 to-emerald-100 dark:from-emerald-950/30 dark:to-emerald-900/20", border: "border-emerald-200 dark:border-emerald-900/50", badge: "bg-emerald-500" },
    { name: "Telegram", icon: "✈️", desc: "Summarize group chats and track items", connected: false, gradient: "from-sky-50 to-sky-100 dark:from-sky-950/30 dark:to-sky-900/20", border: "border-sky-200 dark:border-sky-900/50", badge: "bg-sky-500" },
    { name: "Outlook", icon: "📅", desc: "Sync calendar events and emails", connected: false, gradient: "from-blue-50 to-blue-100 dark:from-blue-950/30 dark:to-blue-900/20", border: "border-blue-200 dark:border-blue-900/50", badge: "bg-blue-500" },
  ];

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-[#0b0f1a]">
      {/* ─────────── SIDEBAR ─────────── */}
      <aside className="hidden w-64 flex-shrink-0 border-r border-zinc-200 bg-white lg:flex lg:flex-col dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex h-16 items-center gap-2 border-b border-zinc-200 px-6 dark:border-zinc-800">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-bold text-white">
            B
          </div>
          <span className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">
            BrieflyAI
          </span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {[
            { label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6", active: true },
            { label: "Messages", icon: "M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z", active: false },
            { label: "Reminders", icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z", active: false },
            { label: "Integrations", icon: "M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z", active: false },
            { label: "Settings", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z", active: false },
          ].map((item) => (
            <a
              key={item.label}
              href="#"
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${item.active
                  ? "bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
                }`}
            >
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
              </svg>
              {item.label}
            </a>
          ))}
        </nav>

        {/* Sidebar user section */}
        <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
          <form action={signOut}>
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-red-900/20 dark:hover:text-red-400"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign Out
            </button>
          </form>
        </div>
      </aside>

      {/* ─────────── MAIN CONTENT ─────────── */}
      <div className="flex flex-1 flex-col">
        {/* Top header (mobile) */}
        <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/80 backdrop-blur-xl lg:hidden dark:border-zinc-800 dark:bg-[#0b0f1a]/80">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-bold text-white">B</div>
              <span className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">BrieflyAI</span>
            </Link>
            <form action={signOut}>
              <button type="submit" className="inline-flex h-9 items-center justify-center rounded-full border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-700 transition-all hover:bg-zinc-50 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">
                Sign out
              </button>
            </form>
          </div>
        </header>

        <main className="flex-1 px-6 py-8 lg:py-10">
          <div className="mx-auto max-w-7xl">
            {/* ─── Welcome Section ─── */}
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-accent-500 text-lg font-bold text-white shadow-lg shadow-brand-500/20">
                  {initials}
                </div>
                <div>
                  <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white sm:text-3xl">
                    Welcome{user.fullName ? `, ${user.fullName}` : " back"}!
                  </h1>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    Signed in as <span className="font-medium text-zinc-700 dark:text-zinc-300">{user.email}</span>
                  </p>
                </div>
              </div>
              <Link
                href="/"
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-700 transition-all hover:bg-zinc-50 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                Back to Home
              </Link>
            </div>

            {/* ─── Stats Grid ─── */}
            <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  className="group relative overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5 transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-2xl">{stat.icon}</span>
                    <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                      {stat.change}
                    </span>
                  </div>
                  <p className="text-2xl font-bold text-zinc-900 dark:text-white">
                    {stat.value}
                  </p>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    {stat.label}
                  </p>
                  {/* Hover shine */}
                  <div className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/5 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                </div>
              ))}
            </div>

            {/* ─── Connected Platforms ─── */}
            <div className="mb-8">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">
                  Connected Platforms
                </h2>
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Connect your accounts to get started
                </span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {platforms.map((platform) => (
                  <button
                    key={platform.name}
                    className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-b ${platform.gradient} ${platform.border} p-5 text-left transition-all duration-300 hover:shadow-lg hover:-translate-y-1`}
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-2xl">{platform.icon}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-500 transition-colors group-hover:bg-brand-100 group-hover:text-brand-700 dark:bg-zinc-800 dark:text-zinc-400 dark:group-hover:bg-brand-900/40 dark:group-hover:text-brand-400">
                        <span className={`h-1.5 w-1.5 rounded-full bg-zinc-300 transition-colors group-hover:bg-brand-500 dark:bg-zinc-600`} />
                        Connect
                      </span>
                    </div>
                    <h3 className="font-semibold text-zinc-900 dark:text-white">
                      {platform.name}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {platform.desc}
                    </p>
                    <div className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                  </button>
                ))}
              </div>
            </div>

            {/* ─── Two Column: Recent Activity + Quick Actions ─── */}
            <div className="grid gap-6 lg:grid-cols-3">
              {/* Recent Activity */}
              <div className="lg:col-span-2">
                <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">
                      Recent Activity
                    </h2>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">Today</span>
                  </div>
                  <div className="space-y-4">
                    {[
                      { time: "2 min ago", event: "Account created", detail: "Welcome to BrieflyAI!", dot: "bg-brand-500" },
                      { time: "—", event: "No recent activity", detail: "Connect a platform to see your activity here", dot: "bg-zinc-300 dark:bg-zinc-600" },
                    ].map((item, i) => (
                      <div key={i} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <div className={`mt-1.5 h-2.5 w-2.5 rounded-full ${item.dot}`} />
                          {i < 0 && <div className="h-full w-px bg-zinc-200 dark:bg-zinc-700" />}
                        </div>
                        <div className="min-w-0 flex-1 pb-4">
                          <p className="text-sm font-medium text-zinc-900 dark:text-white">{item.event}</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">{item.detail}</p>
                          <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">{item.time}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Quick Actions */}
              <div>
                <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
                  <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-white">
                    Quick Actions
                  </h2>
                  <div className="space-y-3">
                    {[
                      { label: "Connect Gmail", icon: "✉️", desc: "Sync your inbox" },
                      { label: "Create Reminder", icon: "⏰", desc: "Set a smart reminder" },
                      { label: "View Summary", icon: "📝", desc: "See your daily digest" },
                    ].map((action) => (
                      <button
                        key={action.label}
                        className="flex w-full items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 text-left transition-all hover:bg-zinc-100 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800/50 dark:hover:bg-zinc-800 dark:hover:border-zinc-600"
                      >
                        <span className="text-xl">{action.icon}</span>
                        <div>
                          <p className="text-sm font-medium text-zinc-900 dark:text-white">{action.label}</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">{action.desc}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="border-t border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="mx-auto flex max-w-7xl items-center justify-between">
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              &copy; {new Date().getFullYear()} BrieflyAI. All rights reserved.
            </p>
            <div className="flex items-center gap-4">
              {["Privacy", "Terms", "Support"].map((link) => (
                <Link key={link} href="#" className="text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-white">
                  {link}
                </Link>
              ))}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
