import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import UserMenu from "@/components/auth/user-menu";

export default async function Home() {
  const currentUser = await getCurrentUser();
  const isAuthenticated = !!currentUser;

  return (
    <div className="flex flex-col flex-1 font-sans">
      {/* ──────────────── HEADER ──────────────── */}
      <header className="sticky top-0 z-50 w-full border-b border-zinc-200/60 bg-white/80 backdrop-blur-xl dark:border-zinc-800/60 dark:bg-[#0b0f1a]/80">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-bold text-white">
              B
            </div>
            <span className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">
              BrieflyAI
            </span>
          </Link>

          {/* Desktop Nav */}
          <nav aria-label="Main navigation" className="hidden items-center gap-8 md:flex">
            {["Features", "Integrations", "How It Works"].map((item) => (
              <Link
                key={item}
                href={`#${item.toLowerCase().replace(/\s+/g, "-")}`}
                className="text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              >
                {item}
              </Link>
            ))}
          </nav>

          {/* Auth-aware CTA */}
          {isAuthenticated ? (
            <UserMenu
              name={currentUser!.fullName}
              email={currentUser!.email}
              avatar={currentUser!.avatarUrl}
            />
          ) : (
            <div className="flex items-center gap-3">
              <Link
                href="/sign-in"
                className="text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              >
                Login
              </Link>
              <Link
                href="/sign-up"
                className="inline-flex h-9 items-center justify-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition-all hover:bg-zinc-700 active:scale-95 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Get Started
              </Link>
            </div>
          )}
        </div>
      </header>

      {/* ─── Full page content (same as before) ─── */}
      <main id="main-content">
        {/* ──────────────── HERO ──────────────── */}
        <section aria-label="Hero" className="relative isolate overflow-hidden px-4 pt-4 pb-16 sm:px-6 sm:pt-14 md:pt-3 md:pb-16">
          <div className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-brand-400/10 blur-3xl dark:bg-brand-500/10" />
            <div className="absolute right-0 bottom-0 h-[400px] w-[400px] rounded-full bg-accent-400/10 blur-3xl dark:bg-accent-500/10" />
          </div>

          <div className="mx-auto max-w-7xl">
            <div className="flex flex-col items-center text-center lg:flex-row lg:text-left lg:items-center lg:justify-between gap-8 lg:gap-12">
              <div className="max-w-2xl flex-1">
                <div className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-4 py-1.5 text-xs font-medium text-brand-700 dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-300">
                  <span className="flex h-2 w-2 rounded-full bg-brand-500 animate-pulse" />
                  AI-Powered Productivity
                </div>

                <h1 className="text-4xl font-bold leading-tight tracking-tight text-zinc-900 sm:text-5xl md:text-6xl dark:text-white">
                  Your AI Personal Agent,{" "}
                  <span className="text-gradient">Across Every Platform</span>
                </h1>

                <p className="mt-6 max-w-lg text-base leading-relaxed text-zinc-600 sm:text-lg dark:text-zinc-400 mx-auto lg:mx-0">
                  Connect your Gmail, Telegram, and more —
                  BrieflyAI unifies your conversations, generates smart summaries,
                  sets intelligent reminders, and keeps you organized so you can
                  focus on what matters.
                </p>

                <div className="mt-8 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
                  {isAuthenticated ? (
                    <Link
                      href="/dashboard"
                      className="inline-flex h-12 items-center justify-center rounded-full bg-zinc-900 px-7 text-sm font-medium text-white shadow-lg shadow-zinc-900/20 transition-all hover:bg-zinc-700 active:scale-95 dark:bg-white dark:text-zinc-900 dark:shadow-white/10 dark:hover:bg-zinc-200"
                    >
                      Go to Dashboard
                    </Link>
                  ) : (
                    <>
                      <Link
                        href="/sign-up"
                        className="inline-flex h-12 items-center justify-center rounded-full bg-zinc-900 px-7 text-sm font-medium text-white shadow-lg shadow-zinc-900/20 transition-all hover:bg-zinc-700 active:scale-95 dark:bg-white dark:text-zinc-900 dark:shadow-white/10 dark:hover:bg-zinc-200"
                      >
                        Start Free Trial
                      </Link>
                      <Link
                        href="/sign-in"
                        className="inline-flex h-12 items-center justify-center rounded-full border border-zinc-300 bg-white px-7 text-sm font-medium text-zinc-700 transition-all hover:bg-zinc-50 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                      >
                        View Integrations
                      </Link>
                    </>
                  )}
                </div>

                <div className="mt-10 flex flex-col gap-4">
                  <p className="text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                    Trusted by thousands of professionals
                  </p>
                  <div className="flex -space-x-2">
                    {[
                      { initials: "JD", color: "bg-brand-500" },
                      { initials: "AK", color: "bg-accent-500" },
                      { initials: "MR", color: "bg-amber-500" },
                      { initials: "SL", color: "bg-rose-500" },
                      { initials: "TW", color: "bg-emerald-500" },
                    ].map((user, i) => (
                      <div
                        key={i}
                        className={`flex h-9 w-9 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white ${user.color} dark:border-zinc-900`}
                      >
                        {user.initials}
                      </div>
                    ))}
                    <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-zinc-100 text-xs font-medium text-zinc-500 dark:border-zinc-900 dark:bg-zinc-800 dark:text-zinc-400">
                      +2k
                    </div>
                  </div>
                </div>
              </div>

              <div className="relative flex-1 lg:max-w-lg">
                <div aria-hidden="true" className="glow relative overflow-hidden rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 border-b border-zinc-100 pb-3 dark:border-zinc-800">
                      <div className="flex gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-full bg-red-400" />
                        <div className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                        <div className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                      </div>
                      <div className="ml-2 h-4 flex-1 rounded-md bg-zinc-100 dark:bg-zinc-800" />
                    </div>

                    <div className="space-y-3">
                      {[
                        { platform: "Gmail", color: "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400", sender: "Sarah Chen", preview: "Meeting tomorrow at 2pm?" },
                        { platform: "Telegram", color: "bg-sky-100 text-sky-600 dark:bg-sky-900/40 dark:text-sky-400", sender: "Dev Channel", preview: "New PR ready for review" },
                        { platform: "Google Calendar", color: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400", sender: "HR Department", preview: "Quarterly review schedule" },
                      ].map((msg, i) => (
                        <div
                          key={i}
                          className="animate-fade-in-up flex items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-800/50"
                          style={{ animationDelay: `${i * 0.1}s` }}
                        >
                          <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${msg.color}`}>{msg.platform}</span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-zinc-900 dark:text-white">{msg.sender}</p>
                            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{msg.preview}</p>
                          </div>
                          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-[10px] text-brand-600 dark:bg-brand-900/40 dark:text-brand-400">AI</div>
                        </div>
                      ))}
                    </div>

                    <div className="animate-fade-in-up-delayed mt-2 rounded-xl bg-gradient-to-r from-brand-500 to-accent-500 p-3">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-white/80">AI Summary</p>
                      <p className="mt-1 text-sm font-medium text-white">3 action items, 2 meetings, 1 urgent — all organized.</p>
                    </div>
                  </div>
                </div>
                <div aria-hidden="true" className="animate-float absolute -top-3 -right-3 rounded-full border border-zinc-200 bg-white px-4 py-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                  <div className="flex items-center gap-2">
                    <div className="flex h-3 w-3 items-center justify-center rounded-full bg-emerald-400" />
                    <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">All platforms connected</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ──────────────── INTEGRATIONS ──────────────── */}
        <section aria-label="Supported platforms" id="integrations" className="border-y border-zinc-100 bg-zinc-50/50 px-4 py-20 dark:border-zinc-800 dark:bg-zinc-900/50 sm:px-6 md:py-24">
          <div className="mx-auto max-w-7xl">
            <div className="text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600 dark:text-brand-400">Seamless Integration</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl dark:text-white">Connect All Your Accounts</h2>
              <p className="mx-auto mt-4 max-w-lg text-zinc-600 dark:text-zinc-400">One-click connect to the platforms you use every day. Your data stays encrypted and private.</p>
            </div>
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { name: "Gmail", icon: "✉️", desc: "Read, summarize, and organize your inbox with AI.", connected: true, gradient: "from-red-50 to-red-100 dark:from-red-950/30 dark:to-red-900/20", border: "border-red-200 dark:border-red-900/50" },
                { name: "Google Calendar", icon: "📅", desc: "Sync calendar events and get AI-powered meeting reminders.", connected: false, gradient: "from-emerald-50 to-emerald-100 dark:from-emerald-950/30 dark:to-emerald-900/20", border: "border-emerald-200 dark:border-emerald-900/50" },
                { name: "Google Drive", icon: "📁", desc: "Search and read documents, spreadsheets, and presentations.", connected: false, gradient: "from-amber-50 to-amber-100 dark:from-amber-950/30 dark:to-amber-900/20", border: "border-amber-200 dark:border-amber-900/50" },
                { name: "GitHub", icon: "🐙", desc: "Monitor repositories, pull requests, issues, and commits.", connected: false, gradient: "from-zinc-50 to-zinc-100 dark:from-zinc-950/30 dark:to-zinc-900/20", border: "border-zinc-200 dark:border-zinc-900/50" },
                { name: "Discord", icon: "💬", desc: "Track community discussions and key decisions from your servers.", connected: false, gradient: "from-indigo-50 to-indigo-100 dark:from-indigo-950/30 dark:to-indigo-900/20", border: "border-indigo-200 dark:border-indigo-900/50" },
                { name: "Telegram", icon: "✈️", desc: "Summarize group chats and track action items.", connected: false, gradient: "from-sky-50 to-sky-100 dark:from-sky-950/30 dark:to-sky-900/20", border: "border-sky-200 dark:border-sky-900/50" },
              ].map((platform, i) => (
                <div key={i} className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-b ${platform.gradient} ${platform.border} p-6 transition-all duration-300 hover:shadow-lg hover:-translate-y-1`}>
                  <div className="mb-4 flex items-center justify-between">
                    <span className="text-3xl">{platform.icon}</span>
                    {platform.connected ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-3 py-1 text-[11px] font-semibold text-zinc-500 transition-colors group-hover:bg-brand-100 group-hover:text-brand-700 dark:bg-zinc-800 dark:text-zinc-400 dark:group-hover:bg-brand-900/40 dark:group-hover:text-brand-400">Connect</span>
                    )}
                  </div>
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">{platform.name}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{platform.desc}</p>
                  <div className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ──────────────── FEATURES ──────────────── */}
        <section aria-label="Features" id="features" className="px-4 py-20 sm:px-6 md:py-24">
          <div className="mx-auto max-w-7xl">
            <div className="text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600 dark:text-brand-400">Powerful Features</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl dark:text-white">Intelligence That Works for You</h2>
              <p className="mx-auto mt-4 max-w-lg text-zinc-600 dark:text-zinc-400">From smart summaries to cross-platform search — let AI handle the heavy lifting.</p>
            </div>
          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: "📝", title: "Smart Summaries", desc: "Get concise AI-generated summaries of long email threads, group chats, and conversations across all your platforms." },
              { icon: "🔍", title: "Cross-Platform Search", desc: "Search across Gmail, Telegram, and more simultaneously. Find anything instantly." },
              { icon: "📊", title: "Priority Inbox", desc: "AI prioritizes your messages by urgency and importance. Focus on what truly matters each day." },
              { icon: "📋", title: "Daily Digest", desc: "Receive a beautifully summarized daily briefing of everything important — emails, messages, events." },
            ].map((feature, i) => (
                <div key={i} className="group rounded-2xl border border-zinc-200 bg-white p-7 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-xl transition-colors group-hover:bg-brand-100 dark:bg-brand-900/30 dark:group-hover:bg-brand-900/50">{feature.icon}</div>
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">{feature.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ──────────────── HOW IT WORKS ──────────────── */}
        <section aria-label="How it works" id="how-it-works" className="border-y border-zinc-100 bg-zinc-50/50 px-4 py-20 dark:border-zinc-800 dark:bg-zinc-900/50 sm:px-6 md:py-24">
          <div className="mx-auto max-w-7xl">
            <div className="text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600 dark:text-brand-400">Simple Setup</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl dark:text-white">How It Works</h2>
              <p className="mx-auto mt-4 max-w-lg text-zinc-600 dark:text-zinc-400">Get started in under 2 minutes. No technical skills required.</p>
            </div>
            <div className="mt-14 grid gap-8 md:grid-cols-3">
              {[
                { step: "01", title: "Connect Your Accounts", desc: "Securely link your accounts with one click. Your data stays encrypted.", color: "from-brand-500 to-brand-600" },
                { step: "02", title: "AI Learns Your Patterns", desc: "Our AI analyzes your conversations to understand priorities, deadlines, and what matters to you.", color: "from-accent-500 to-accent-600" },
                { step: "03", title: "Stay Organized Effortlessly", desc: "Get daily summaries, smart reminders, and cross-platform search — all in one beautiful dashboard.", color: "from-amber-500 to-orange-500" },
              ].map((step, i) => (
                <div key={i} className="relative text-center md:text-left">
                  <div className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${step.color} shadow-lg md:mx-0`}>
                    <span className="text-lg font-bold text-white">{step.step}</span>
                  </div>
                  <div className="space-y-3">
                    <h3 className="text-xl font-semibold text-zinc-900 dark:text-white">{step.title}</h3>
                    <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{step.desc}</p>
                  </div>
                  {i < 2 && <div aria-hidden="true" className="absolute -right-4 top-7 hidden h-px w-8 bg-gradient-to-r from-zinc-300 to-transparent md:block dark:from-zinc-700" />}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ──────────────── CTA ──────────────── */}
        <section aria-label="Get started" id="get-started" className="px-4 py-20 sm:px-6 md:py-24">
          <div className="mx-auto max-w-4xl">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900 px-6 py-16 text-center shadow-2xl shadow-black/40 ring-1 ring-white/10 sm:px-14 sm:py-20 dark:from-zinc-950 dark:via-zinc-900 dark:to-zinc-950">
              {/* Ambient glow background */}
              <div aria-hidden="true" className="pointer-events-none absolute inset-0">
                <div className="absolute -top-24 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-brand-500/20 blur-3xl" />
                <div className="absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-brand-500/10 blur-3xl" />
                <div className="absolute -bottom-16 -right-16 h-64 w-64 rounded-full bg-accent-500/10 blur-3xl" />
              </div>

              <div className="relative">
                <h2 className="mx-auto max-w-xl text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl md:text-5xl">
                  Ready to Simplify Your Digital Life?
                </h2>
                <p className="mx-auto mt-5 max-w-md text-sm leading-relaxed text-zinc-400 sm:text-base">
                  Join thousands of professionals already using BrieflyAI to stay organized across all their platforms.
                </p>
                <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
                  {isAuthenticated ? (
                    <Link href="/dashboard" className="inline-flex h-12 w-full items-center justify-center rounded-full bg-white px-9 text-sm font-semibold text-zinc-900 shadow-xl shadow-white/10 transition-all duration-200 hover:-translate-y-0.5 hover:bg-zinc-100 active:scale-95 sm:w-auto">Go to Dashboard</Link>
                  ) : (
                    <Link href="/sign-up" className="inline-flex h-12 w-full items-center justify-center rounded-full bg-white px-9 text-sm font-semibold text-zinc-900 shadow-xl shadow-white/10 transition-all duration-200 hover:-translate-y-0.5 hover:bg-zinc-100 active:scale-95 sm:w-auto">Get Started Free</Link>
                  )}
                  <Link href="#" className="inline-flex h-12 w-full items-center justify-center rounded-full border border-zinc-600/70 px-9 text-sm font-semibold text-zinc-300 transition-all duration-200 hover:-translate-y-0.5 hover:border-zinc-500 hover:bg-white/5 hover:text-white active:scale-95 sm:w-auto">Talk to Sales</Link>
                </div>
                <p className="mt-8 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                  No credit card required &bull; Free forever plan available &bull; Cancel anytime
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ──────────────── FOOTER ──────────────── */}
      <footer className="border-t border-[#e5e7eb] bg-white px-8 lg:px-16 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto max-w-7xl py-10">
          <div className="flex flex-wrap items-center justify-center gap-y-6 gap-x-12">
            <div className="flex flex-col items-start gap-1">
              <Link href="/" className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 text-lg font-bold text-white">B</div>
                <span className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">BrieflyAI</span>
              </Link>
              <span className="max-w-xs text-base text-gray-500">Your intelligent personal agent that unifies your favorite platforms into one powerful productivity hub.</span>
            </div>
            <div className="hidden h-10 w-px bg-gray-200 dark:bg-zinc-700 md:block" />
            <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
              {["Privacy Policy", "Terms of Service", "Cookie Policy"].map((item, idx, arr) => (
                <span key={item} className="flex items-center gap-x-6">
                  {idx > 0 && <span className="text-gray-400">•</span>}
                  <Link href={`/${item.toLowerCase().replace(/ /g, "-")}`} className="text-base font-medium text-gray-500 transition-all duration-200 ease-in-out hover:text-black dark:text-zinc-400 dark:hover:text-white">{item}</Link>
                </span>
              ))}
            </nav>
            <div className="hidden h-10 w-px bg-gray-200 dark:bg-zinc-700 md:block" />
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-5">
                <Link href="http://github.com/divysaxena24/" className="inline-flex items-center gap-2 text-sm text-gray-500 transition-all duration-200 ease-in-out hover:text-black hover:scale-105 dark:text-zinc-400 dark:hover:text-white">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-github"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.46-5.46-.52-8.12-.24a5.832 5.832 0 0 0-4 0c-2.67.28-5.5.2-8.12-.24-2-1.5-3-1.5-3-1.5-.3 1.15-.03 2.35 0 3.5A5.623 5.623 0 0 0 4 18c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
                  GitHub
                </Link>
                <Link href="https://www.linkedin.com/in/divyasaxena24/" className="inline-flex items-center gap-2 text-sm text-gray-500 transition-all duration-200 ease-in-out hover:text-black hover:scale-105 dark:text-zinc-400 dark:hover:text-white">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-linkedin"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect width="4" height="12" x="2" y="9"/><circle cx="4" cy="4" r="2"/></svg>
                  LinkedIn
                </Link>
              </div>
              <p className="text-sm text-gray-400">&copy; {new Date().getFullYear()} BrieflyAI. All rights reserved.</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
