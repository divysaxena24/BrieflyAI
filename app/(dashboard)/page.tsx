import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@insforge/sdk/ssr";
import Link from "next/link";
import { signOut } from "@/app/actions";

export default async function DashboardPage() {
  const insforge = createServerClient({ cookies: await cookies() });
  const { data, error } = await insforge.auth.getCurrentUser();

  if (error || !data?.user) {
    redirect("/sign-in");
  }

  const user = data.user as Record<string, unknown>;
  const userEmail = (user.email as string) ?? "";
  const userName = (user.name as string) ?? userEmail.split("@")[0] ?? "User";
  const hasGoogleProvider = Array.isArray(user.providers) &&
    (user.providers as string[]).includes("google");

  // Save profile on first visit (covers Google OAuth users)
  if (!user.profile) {
    try {
      await insforge.auth.setProfile({
        nickname: userName,
      });
    } catch {
      // Non-critical
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-[#0b0f1a]">
      {/* Dashboard Header */}
      <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/80 backdrop-blur-xl dark:border-zinc-800 dark:bg-[#0b0f1a]/80">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-bold text-white">
              B
            </div>
            <span className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">
              BrieflyAI
            </span>
          </Link>

          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-zinc-600 sm:block dark:text-zinc-400">
              {userEmail}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="inline-flex h-9 items-center justify-center rounded-full border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-700 transition-all hover:bg-zinc-50 active:scale-95 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* Dashboard Content */}
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-7xl">
          {/* Welcome */}
          <div className="mb-10">
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">
              Welcome{userName !== "User" ? `, ${userName}` : " back"}!
            </h1>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              You&apos;re signed in as{" "}
              <span className="font-medium text-zinc-900 dark:text-white">
                {userEmail}
              </span>
            </p>
          </div>

          {/* Connected Platforms */}
          <div className="mb-10">
            <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-white">
              Connected Platforms
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { name: "Gmail", icon: "✉️", connected: hasGoogleProvider },
                { name: "WhatsApp", icon: "💬", connected: false },
                { name: "Telegram", icon: "✈️", connected: false },
                { name: "Outlook", icon: "📅", connected: false },
              ].map((platform) => (
                <div
                  key={platform.name}
                  className={`rounded-2xl border p-5 transition-all ${
                    platform.connected
                      ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-900/20"
                      : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                  }`}
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-2xl">{platform.icon}</span>
                    {platform.connected ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                        Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        Connect
                      </span>
                    )}
                  </div>
                  <h3 className="font-medium text-zinc-900 dark:text-white">
                    {platform.name}
                  </h3>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Stats */}
          <div>
            <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-white">
              At a Glance
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                { label: "Messages Summarized", value: "—" },
                { label: "Active Reminders", value: "—" },
                { label: "Connected Platforms", value: "1 / 4" },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    {stat.label}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-zinc-900 dark:text-white">
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
