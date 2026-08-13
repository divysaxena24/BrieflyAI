"use client";

import React from "react";
import { motion } from "framer-motion";

interface AiReadinessIndicatorProps {
  score: number; // 0-100
  connectedSources: number;
  totalSources: number;
  totalMcpTools: number;
  status: "ready" | "limited" | "error";
}

export const AiReadinessIndicator: React.FC<AiReadinessIndicatorProps> = ({
  score,
  connectedSources,
  totalSources,
  totalMcpTools,
  status,
}) => {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (score / 100) * circumference;

  const statusConfig = {
    ready: {
      label: "AI Ready",
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-50 dark:bg-emerald-950/40",
      stroke: "#10b981",
    },
    limited: {
      label: "Limited",
      color: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-50 dark:bg-amber-950/40",
      stroke: "#f59e0b",
    },
    error: {
      label: "Error",
      color: "text-red-600 dark:text-red-400",
      bg: "bg-red-50 dark:bg-red-950/40",
      stroke: "#ef4444",
    },
  };

  const config = statusConfig[status];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex flex-col rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800/80 dark:bg-zinc-900/90"
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
            AI Readiness
          </h3>
          <p className={`mt-1 text-2xl font-black tracking-tight ${config.color}`}>
            {score}%
          </p>
          <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
            {status === "ready" ? "Ready to answer questions" : `Connect ${2 - connectedSources} more platform${2 - connectedSources !== 1 ? "s" : ""}`}
          </p>
        </div>

        <div className="relative flex h-24 w-24 shrink-0 items-center justify-center">
          <svg className="h-24 w-24 -rotate-90" viewBox="0 0 100 100">
            <circle
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="6"
              className="text-zinc-100 dark:text-zinc-800"
            />
            <motion.circle
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke={config.stroke}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={circumference}
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset }}
              transition={{ duration: 1, ease: "easeOut", delay: 0.3 }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.4, delay: 0.5, type: "spring" }}
              className={`text-lg font-black ${config.color}`}
            >
              {score}%
            </motion.span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
          <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
            {connectedSources} Data Sources
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
          <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
            {totalMcpTools} MCP Tools
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
            {status === "ready" ? "Healthy" : "Attention needed"}
          </span>
        </div>
      </div>
    </motion.div>
  );
};
