import Link from "next/link";

export default function PrivacyPolicyPage() {
  return (
    <div className="flex flex-col flex-1 font-sans">
      <main id="main-content" className="flex-1">
        <section className="px-4 py-20 sm:px-6 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">Privacy Policy</h1>
            <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">Last updated: August 2026</p>
            <div className="mt-10 space-y-6 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              <p>This Privacy Policy describes how BrieflyAI collects, uses, and protects your personal information when you use our services.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Information We Collect</h2>
              <p>We collect information you provide directly to us, such as your name, email address, and any data from connected platforms that you authorize us to access.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">How We Use Your Information</h2>
              <p>We use your information to provide, maintain, and improve our services, communicate with you, and ensure the security of your account.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Data Security</h2>
              <p>Your data is encrypted in transit and at rest. We do not sell your personal information to third parties.</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Contact Us</h2>
              <p>If you have any questions about this Privacy Policy, please contact us at privacy@brieflyai.com.</p>
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
