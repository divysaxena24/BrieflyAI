"use client";

import React, { useState, useMemo } from "react";
import type { IntegrationConfig } from "@/lib/integrations/types";
import { IntegrationCard } from "./IntegrationCard";
import { IntegrationGridSkeleton } from "./LoadingSkeleton";
import { SearchFilters } from "./SearchFilters";

interface IntegrationGridProps {
  integrations: IntegrationConfig[];
  isLoading?: boolean;
  emptyMessage?: string;
}

export const IntegrationGrid: React.FC<IntegrationGridProps> = ({
  integrations,
  isLoading = false,
  emptyMessage = "No integrations configured yet.",
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const categories = useMemo(() => {
    const cats = new Set(integrations.map((i) => i.category));
    return Array.from(cats).filter(Boolean) as string[];
  }, [integrations]);

  const filteredIntegrations = useMemo(() => {
    let filtered = integrations;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (i) =>
          i.name.toLowerCase().includes(query) ||
          i.category.toLowerCase().includes(query) ||
          i.description.toLowerCase().includes(query)
      );
    }

    if (selectedCategory) {
      filtered = filtered.filter((i) => i.category === selectedCategory);
    }

    return filtered;
  }, [integrations, searchQuery, selectedCategory]);

  if (isLoading) {
    return <IntegrationGridSkeleton count={8} />;
  }

  if (integrations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-200 p-12 text-center dark:border-zinc-700">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800">
          <PlugIcon />
        </div>
        <h3 className="text-base font-bold text-zinc-900 dark:text-white">
          No integrations yet
        </h3>
        <p className="mt-1 max-w-xs text-xs text-zinc-500 dark:text-zinc-400">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div>
      <SearchFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedCategory={selectedCategory}
        onCategoryChange={setSelectedCategory}
        categories={categories}
      />

      {filteredIntegrations.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-200 p-12 text-center dark:border-zinc-700">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800">
            <SearchIcon />
          </div>
          <h3 className="text-base font-bold text-zinc-900 dark:text-white">
            No integrations found
          </h3>
          <p className="mt-1 max-w-xs text-xs text-zinc-500 dark:text-zinc-400">
            Try adjusting your search or filter criteria.
          </p>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filteredIntegrations.map((integration, index) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              index={index}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/** Simple plug icon for the empty state */
const PlugIcon: React.FC = () => (
  <svg
    className="h-8 w-8 text-zinc-400 dark:text-zinc-500"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
    />
  </svg>
);

/** Search icon for empty search results */
const SearchIcon: React.FC = () => (
  <svg
    className="h-8 w-8 text-zinc-400 dark:text-zinc-500"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
    />
  </svg>
);
