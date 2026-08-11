import React from "react";
import { PageHeader } from "@/components/dashboard";
import { UpgradeZapIcon, CheckCircleIcon, AiSparklesIcon } from "@/components/dashboard/icons";

export default function PricingPage() {
  const plans = [
    {
      name: "Starter",
      price: "$0",
      period: "/ month",
      desc: "For individuals looking to automate basic email & chat digests.",
      features: [
        "100 AI Summary Credits / mo",
        "Connect up to 2 Channels (Gmail & WhatsApp)",
        "Standard Processing Speed",
        "Daily Briefing Email",
      ],
      cta: "Current Plan",
      current: true,
      popular: false,
    },
    {
      name: "Pro Agent",
      price: "$19",
      period: "/ month",
      desc: "For professionals requiring real-time alerts, unlimited summaries, and custom agent rules.",
      features: [
        "Unlimited AI Summary Credits",
        "Connect all 4 Channels (Gmail, WhatsApp, Telegram, Outlook)",
        "Priority High-Speed AI Processing",
        "Custom Persona & System Instructions",
        "Smart Automated Reminders",
        "24/7 Priority Support",
      ],
      cta: "Upgrade to Pro",
      current: false,
      popular: true,
    },
    {
      name: "Enterprise",
      price: "$49",
      period: "/ month",
      desc: "For teams needing dedicated model fine-tuning, custom API access, and compliance.",
      features: [
        "Everything in Pro",
        "Multi-user Team Workspace",
        "Custom LLM Fine-Tuning",
        "Dedicated Account Manager",
        "SOC2 & HIPAA Compliance Options",
        "Custom API Integrations",
      ],
      cta: "Contact Sales",
      current: false,
      popular: false,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Pricing & Plan Upgrades"
        description="Choose the ideal plan to scale your AI productivity, credits, and platform connections."
        badge="Save 20% Annually"
      />

      <div className="grid gap-6 md:grid-cols-3">
        {plans.map((plan, idx) => (
          <div
            key={idx}
            className={`relative flex flex-col justify-between overflow-hidden rounded-3xl border p-6 shadow-sm transition-all duration-300 ${
              plan.popular
                ? "border-brand-500 bg-gradient-to-b from-brand-50/50 via-white to-amber-50/30 shadow-xl shadow-brand-500/10 dark:border-brand-500 dark:from-brand-950/40 dark:via-zinc-900 dark:to-zinc-900"
                : "border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-900/90"
            }`}
          >
            {plan.popular && (
              <span className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full bg-brand-600 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-white shadow-md">
                <AiSparklesIcon size={12} /> Most Popular
              </span>
            )}

            <div>
              <h3 className="text-lg font-bold text-zinc-900 dark:text-white">
                {plan.name}
              </h3>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 min-h-[32px]">
                {plan.desc}
              </p>

              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-3xl font-black text-zinc-900 dark:text-white">
                  {plan.price}
                </span>
                <span className="text-xs text-zinc-400 font-medium">
                  {plan.period}
                </span>
              </div>

              <div className="mt-6 space-y-2.5">
                {plan.features.map((feature, fIdx) => (
                  <div key={fIdx} className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                    <CheckCircleIcon size={16} className="text-brand-600 dark:text-brand-400 shrink-0" />
                    <span>{feature}</span>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={plan.current}
              className={`mt-8 w-full rounded-xl py-2.5 text-xs font-bold transition-all ${
                plan.current
                  ? "bg-zinc-100 text-zinc-400 cursor-not-allowed dark:bg-zinc-800 dark:text-zinc-500"
                  : plan.popular
                  ? "bg-brand-600 text-white shadow-md shadow-brand-600/25 hover:bg-brand-500"
                  : "border border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              }`}
            >
              {plan.cta}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
