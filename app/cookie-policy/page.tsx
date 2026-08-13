import Link from "next/link";

export default function CookiePolicyPage() {
  return (
    <div className="flex flex-col flex-1 font-sans">
      <main id="main-content" className="flex-1">
        <section className="px-4 py-20 sm:px-6 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">Cookie Policy</h1>
            <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">Last updated: August 2026</p>
            <div className="mt-10 space-y-6 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              <p>This Cookie Policy explains how BrieflyAI uses cookies and similar technologies to recognize you when you visit our website.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">What Are Cookies</h2>
              <p>Cookies are small data files placed on your device when you visit a website. Cookies are widely used to make websites work more efficiently and to provide reporting information.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">How We Use Cookies</h2>
              <p>We use cookies to understand and save your preferences for future visits, keep track of advertisements, and compile aggregate data about site traffic and site interaction.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Managing Cookies</h2>
              <p>You can control or delete cookies through your browser settings. Please note that removing or blocking cookies may impact your user experience and some functionality may no longer be available.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Contact Us</h2>
              <p>If you have any questions about our use of cookies, please contact us at privacy@brieflyai.com.</p>
            </div>
            <div className="mt-10">
              <Link href="/" className="inline-flex items-center gap-2 text-sm font-medium text-brand-600 hover:text-brand-500 dark:text-brand-400">
                ← Back to home
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
