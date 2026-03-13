import assert from "node:assert/strict";
import test from "node:test";

import type { FirewallEvent } from "@/components/admin-types";
import {
  computeEventCategoryCounts,
  filterEventsByCategory,
  isZeroMatchFilter,
  computePageCount,
  clampPage,
  paginateItems,
  EVENTS_PER_PAGE,
} from "./firewall-panel.helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<FirewallEvent> = {}): FirewallEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    action: "resolve",
    decision: "allowed",
    ...overrides,
  };
}

function makeEvents(n: number, category?: string): FirewallEvent[] {
  return Array.from({ length: n }, (_, i) =>
    makeEvent({ id: `evt-${i}`, category: category as FirewallEvent["category"] }),
  );
}

// ---------------------------------------------------------------------------
// computeEventCategoryCounts
// ---------------------------------------------------------------------------

test("computeEventCategoryCounts — empty events", () => {
  const counts = computeEventCategoryCounts([]);
  assert.equal(counts.size, 0);
});

test("computeEventCategoryCounts — groups by category, unknown defaults to other", () => {
  const events = [
    makeEvent({ category: "npm" }),
    makeEvent({ category: "npm" }),
    makeEvent({ category: "curl" }),
    makeEvent({}), // no category → "other"
  ];
  const counts = computeEventCategoryCounts(events);
  assert.equal(counts.get("npm"), 2);
  assert.equal(counts.get("curl"), 1);
  assert.equal(counts.get("other"), 1);
  assert.equal(counts.size, 3);
});

// ---------------------------------------------------------------------------
// filterEventsByCategory
// ---------------------------------------------------------------------------

test("filterEventsByCategory — null filter returns all events", () => {
  const events = makeEvents(5, "npm");
  const result = filterEventsByCategory(events, null);
  assert.equal(result.length, 5);
  assert.equal(result, events); // same reference
});

test("filterEventsByCategory — filters by matching category", () => {
  const events = [
    makeEvent({ category: "npm" }),
    makeEvent({ category: "curl" }),
    makeEvent({ category: "npm" }),
  ];
  const result = filterEventsByCategory(events, "npm");
  assert.equal(result.length, 2);
  assert.ok(result.every((e) => e.category === "npm"));
});

test("filterEventsByCategory — events without category match 'other'", () => {
  const events = [makeEvent({}), makeEvent({ category: "npm" })];
  const result = filterEventsByCategory(events, "other");
  assert.equal(result.length, 1);
  assert.equal(result[0].category, undefined);
});

// ---------------------------------------------------------------------------
// isZeroMatchFilter
// ---------------------------------------------------------------------------

test("isZeroMatchFilter — true when filter active, events exist, but none match", () => {
  assert.equal(isZeroMatchFilter(10, "npm", 0), true);
});

test("isZeroMatchFilter — false when no filter active", () => {
  assert.equal(isZeroMatchFilter(10, null, 0), false);
});

test("isZeroMatchFilter — false when there are no events at all", () => {
  assert.equal(isZeroMatchFilter(0, "npm", 0), false);
});

test("isZeroMatchFilter — false when filtered count > 0", () => {
  assert.equal(isZeroMatchFilter(10, "npm", 3), false);
});

// ---------------------------------------------------------------------------
// computePageCount
// ---------------------------------------------------------------------------

test("computePageCount — 0 items yields 1 page", () => {
  assert.equal(computePageCount(0), 1);
});

test("computePageCount — exactly EVENTS_PER_PAGE yields 1 page", () => {
  assert.equal(computePageCount(EVENTS_PER_PAGE), 1);
});

test("computePageCount — EVENTS_PER_PAGE + 1 yields 2 pages", () => {
  assert.equal(computePageCount(EVENTS_PER_PAGE + 1), 2);
});

test("computePageCount — 1 item yields 1 page", () => {
  assert.equal(computePageCount(1), 1);
});

test("computePageCount — 2 * EVENTS_PER_PAGE yields 2 pages", () => {
  assert.equal(computePageCount(2 * EVENTS_PER_PAGE), 2);
});

// ---------------------------------------------------------------------------
// clampPage
// ---------------------------------------------------------------------------

test("clampPage — clamps to last page when page exceeds count", () => {
  assert.equal(clampPage(5, 3), 2);
});

test("clampPage — returns 0 for negative page", () => {
  assert.equal(clampPage(-1, 3), 0);
});

test("clampPage — leaves valid page unchanged", () => {
  assert.equal(clampPage(1, 3), 1);
});

test("clampPage — page 0 with 1 page returns 0", () => {
  assert.equal(clampPage(0, 1), 0);
});

// ---------------------------------------------------------------------------
// paginateItems
// ---------------------------------------------------------------------------

test("paginateItems — returns first page slice", () => {
  const items = makeEvents(25);
  const page = paginateItems(items, 0);
  assert.equal(page.length, EVENTS_PER_PAGE);
  assert.equal(page[0].id, items[0].id);
});

test("paginateItems — returns remainder on last page", () => {
  const items = makeEvents(25);
  const page = paginateItems(items, 1);
  assert.equal(page.length, 5);
  assert.equal(page[0].id, items[20].id);
});

test("paginateItems — clamps out-of-range page to last", () => {
  const items = makeEvents(25);
  const page = paginateItems(items, 99);
  assert.equal(page.length, 5); // last page
});

test("paginateItems — empty items returns empty", () => {
  const page = paginateItems([], 0);
  assert.equal(page.length, 0);
});

test("paginateItems — exactly EVENTS_PER_PAGE items on page 0 returns all", () => {
  const items = makeEvents(EVENTS_PER_PAGE);
  const page = paginateItems(items, 0);
  assert.equal(page.length, EVENTS_PER_PAGE);
});
