"use client";

import React from "react";

interface HighlightTextProps {
  text: string;
  query: string;
  className?: string;
  tag?: React.ElementType;
}

export const HighlightText: React.FC<HighlightTextProps> = ({ text, query, className, tag = "span" }) => {
  if (!query.trim()) {
    return <span className={className}>{text}</span>;
  }

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escapedQuery, "gi");
  const parts = text.split(regex);

  return React.createElement(
    tag,
    { className },
    parts.map((part, index) =>
      part.toLowerCase() === query.toLowerCase() ? (
        <mark
          key={index}
          className="rounded bg-brand-100 px-0.5 text-brand-900 dark:bg-brand-900/40 dark:text-brand-100"
        >
          {part}
        </mark>
      ) : (
        part
      ),
    ),
  );
};
