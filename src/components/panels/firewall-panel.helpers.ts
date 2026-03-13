/**
 * Pure helper functions for firewall panel event filtering and pagination.
 * No React dependency — importable from tests and the component alike.
 */

import type { FirewallEvent } from "@/components/admin-types";

// ---------------------------------------------------------------------------
// Event category counts
// ---------------------------------------------------------------------------

export function computeEventCategoryCounts(
  events: FirewallEvent[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const cat = event.category ?? "other";
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Event filtering
// ---------------------------------------------------------------------------

export function filterEventsByCategory(
  events: FirewallEvent[],
  categoryFilter: string | null,
): FirewallEvent[] {
  if (!categoryFilter) return events;
  return events.filter((e) => (e.category ?? "other") === categoryFilter);
}

// ---------------------------------------------------------------------------
// Zero-match detection
// ---------------------------------------------------------------------------

/**
 * Returns true when there are events, a category filter is active, but
 * the filter yields zero results.
 */
export function isZeroMatchFilter(
  totalEvents: number,
  categoryFilter: string | null,
  filteredCount: number,
): boolean {
  return totalEvents > 0 && categoryFilter !== null && filteredCount === 0;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const EVENTS_PER_PAGE = 20;

export function computePageCount(totalItems: number): number {
  return Math.max(1, Math.ceil(totalItems / EVENTS_PER_PAGE));
}

export function clampPage(page: number, pageCount: number): number {
  return Math.max(0, Math.min(page, pageCount - 1));
}

export function paginateItems<T>(
  items: T[],
  page: number,
): T[] {
  const pageCount = computePageCount(items.length);
  const clamped = clampPage(page, pageCount);
  return items.slice(
    clamped * EVENTS_PER_PAGE,
    (clamped + 1) * EVENTS_PER_PAGE,
  );
}
