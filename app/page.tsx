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
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
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
      <section aria-label="Hero" className="relative isolate overflow-hidden px-6 pt-24 pb-20 md:pt-32 md:pb-28">
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-brand-400/10 blur-3xl dark:bg-brand-500/10" />
          <div className="absolute right-0 bottom-0 h-[400px] w-[400px] rounded-full bg-accent-400/10 blur-3xl dark:bg-accent-500/10" />
        </div>

        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col items-center text-center lg:flex-row lg:text-left lg:items-center lg:justify-between gap-12">
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
                Connect your Gmail, Telegram, and Outlook —
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
                      { platform: "Outlook", color: "bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400", sender: "HR Department", preview: "Quarterly review schedule" },
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
      <section aria-label="Supported platforms" id="integrations" className="border-y border-zinc-100 bg-zinc-50/50 px-6 py-20 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="mx-auto max-w-7xl">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600 dark:text-brand-400">Seamless Integration</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl dark:text-white">Connect All Your Accounts</h2>
            <p className="mx-auto mt-4 max-w-lg text-zinc-600 dark:text-zinc-400">One-click connect to the platforms you use every day. Your data stays encrypted and private.</p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { name: "Gmail", icon: "✉️", desc: "Read, summarize, and organize your inbox with AI.", connected: true, gradient: "from-red-50 to-red-100 dark:from-red-950/30 dark:to-red-900/20", border: "border-red-200 dark:border-red-900/50" },
              { name: "Telegram", icon: "✈️", desc: "Summarize group chats and track action items.", connected: false, gradient: "from-sky-50 to-sky-100 dark:from-sky-950/30 dark:to-sky-900/20", border: "border-sky-200 dark:border-sky-900/50" },
              { name: "Outlook", icon: "📅", desc: "Sync calendar events and emails seamlessly.", connected: false, gradient: "from-blue-50 to-blue-100 dark:from-blue-950/30 dark:to-blue-900/20", border: "border-blue-200 dark:border-blue-900/50" },
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
      <section aria-label="Features" id="features" className="px-6 py-20 md:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600 dark:text-brand-400">Powerful Features</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl dark:text-white">Intelligence That Works for You</h2>
            <p className="mx-auto mt-4 max-w-lg text-zinc-600 dark:text-zinc-400">From smart summaries to cross-platform search — let AI handle the heavy lifting.</p>
          </div>
          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: "📝", title: "Smart Summaries", desc: "Get concise AI-generated summaries of long email threads, group chats, and conversations across all your platforms." },
              { icon: "⏰", title: "Intelligent Reminders", desc: "Never miss a deadline. AI detects action items and deadlines, then sets smart reminders automatically." },
              { icon: "🔍", title: "Cross-Platform Search", desc: "Search across Gmail, Telegram, and Outlook simultaneously. Find anything instantly." },
              { icon: "📊", title: "Priority Inbox", desc: "AI prioritizes your messages by urgency and importance. Focus on what truly matters each day." },
              { icon: "💡", title: "Smart Replies", desc: "Get context-aware reply suggestions drafted by AI. Respond faster across all your platforms." },
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
      <section aria-label="How it works" id="how-it-works" className="border-y border-zinc-100 bg-zinc-50/50 px-6 py-20 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="mx-auto max-w-7xl">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600 dark:text-brand-400">Simple Setup</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl dark:text-white">How It Works</h2>
            <p className="mx-auto mt-4 max-w-lg text-zinc-600 dark:text-zinc-400">Get started in under 2 minutes. No technical skills required.</p>
          </div>
          <div className="mt-14 grid gap-8 md:grid-cols-3">
            {[
              { step: "01", title: "Connect Your Accounts", desc: "Securely link your Gmail, Telegram, and Outlook with one click. Your data stays encrypted.", color: "from-brand-500 to-brand-600" },
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
      <section aria-label="Get started" id="get-started" className="px-6 py-20 md:py-28">
        <div className="mx-auto max-w-4xl">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900 px-8 py-16 text-center shadow-2xl dark:from-zinc-950 dark:via-zinc-900 dark:to-zinc-950 sm:px-16">
            <div className="pointer-events-none absolute inset-0 -z-10">
              <div className="absolute -top-20 -right-20 h-64 w-64 rounded-full bg-brand-500/10 blur-3xl" />
              <div className="absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-accent-500/10 blur-3xl" />
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Ready to Simplify Your Digital Life?</h2>
            <p className="mx-auto mt-4 max-w-md text-zinc-400">Join thousands of professionals already using BrieflyAI to stay organized across all their platforms.</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              {isAuthenticated ? (
                <Link href="/dashboard" className="inline-flex h-12 items-center justify-center rounded-full bg-white px-8 text-sm font-semibold text-zinc-900 shadow-lg shadow-white/10 transition-all hover:bg-zinc-100 active:scale-95">Go to Dashboard</Link>
              ) : (
                <Link href="/sign-up" className="inline-flex h-12 items-center justify-center rounded-full bg-white px-8 text-sm font-semibold text-zinc-900 shadow-lg shadow-white/10 transition-all hover:bg-zinc-100 active:scale-95">Get Started Free</Link>
              )}
              <Link href="#" className="inline-flex h-12 items-center justify-center rounded-full border border-zinc-700 px-8 text-sm font-semibold text-zinc-300 transition-all hover:bg-zinc-800 active:scale-95">Talk to Sales</Link>
            </div>
            <p className="mt-6 text-xs text-zinc-500">No credit card required &bull; Free forever plan available &bull; Cancel anytime</p>
          </div>
        </div>
      </section>
      </main>

      {/* ──────────────── FOOTER ──────────────── */}
      <footer className="border-t border-zinc-200 bg-zinc-50 px-6 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="mx-auto max-w-7xl py-16">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <Link href="/" className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-bold text-white">B</div>
                <span className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">BrieflyAI</span>
              </Link>
              <p className="mt-4 max-w-xs text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">Your intelligent personal agent that unifies Gmail, Telegram, and Outlook into one powerful productivity hub.</p>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">Product</h4>
              <ul className="mt-5 space-y-3 text-sm">{["Features", "Integrations", "Pricing", "Changelog"].map((item) => (<li key={item}><Link href="#" className="text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">{item}</Link></li>))}</ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">Company</h4>
              <ul className="mt-5 space-y-3 text-sm">{["About", "Blog", "Careers", "Contact"].map((item) => (<li key={item}><Link href="#" className="text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">{item}</Link></li>))}</ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">Legal</h4>
              <ul className="mt-5 space-y-3 text-sm">{["Privacy Policy", "Terms of Service", "Cookie Policy"].map((item) => (<li key={item}><Link href="#" className="text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">{item}</Link></li>))}</ul>
            </div>
          </div>
          <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-zinc-200 pt-8 sm:flex-row dark:border-zinc-800">
            <p className="text-xs text-zinc-500 dark:text-zinc-500">&copy; {new Date().getFullYear()} BrieflyAI. All rights reserved.</p>
            <div className="flex items-center gap-4">{["Twitter", "GitHub", "LinkedIn"].map((social) => (<Link key={social} href="#" className="text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-white">{social}</Link>))}</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
