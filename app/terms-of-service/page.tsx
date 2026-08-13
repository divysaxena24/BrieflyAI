import Link from "next/link";

export default function TermsOfServicePage() {
  return (
    <div className="flex flex-col flex-1 font-sans">
      <main id="main-content" className="flex-1">
        <section className="px-4 py-20 sm:px-6 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">Terms of Service</h1>
            <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">Last updated: August 2026</p>
            <div className="mt-10 space-y-6 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              <p>By accessing or using BrieflyAI, you agree to be bound by these Terms of Service.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Use of Service</h2>
              <p>You may use BrieflyAI for personal and commercial purposes in accordance with these terms. You are responsible for maintaining the confidentiality of your account credentials.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Intellectual Property</h2>
              <p>All content, features, and functionality of BrieflyAI are owned by BrieflyAI and are protected by international copyright, trademark, and other intellectual property laws.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Limitation of Liability</h2>
              <p>BrieflyAI shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use or inability to use the service.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Contact Us</h2>
              <p>If you have any questions about these Terms, please contact us at legal@brieflyai.com.</p>
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
