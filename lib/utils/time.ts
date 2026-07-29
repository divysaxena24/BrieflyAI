/**
 * Format a date as a human-readable relative time string.
 *
 * Examples:
 *   - Just now (< 1 min)
 *   - 2 min ago
 *   - 1 hour ago
 *   - Yesterday
 *   - 3 days ago
 *   - Jan 15, 2025 (older than 7 days)
 */
export function formatRelativeTime(date: Date | string): string {
  const now = Date.now();
  const then = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "Just now";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;

  // Older than 7 days: show date
  const d = typeof date === "string" ? new Date(date) : date;
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const year = d.getFullYear();
  const currentYear = new Date().getFullYear();
  return year === currentYear ? `${month} ${day}` : `${month} ${day}, ${year}`;
}
