import type { AlignmentMode, WindowSize } from "../../types.ts";
import { formatLocalDate } from "./format.ts";

export interface Bucket {
  start: Date;
  end: Date;
  label: string;
  isPartial: boolean;
}

export function buildBuckets(
  now: Date,
  size: WindowSize,
  mode: AlignmentMode,
  anchorDayOfWeek = 1, // 0=Sun … 6=Sat, default Mon
  anchorDayOfMonth = 1, // 1-31, default 1st
): Bucket[] {
  const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  if (mode === "today") {
    return buildTodayBuckets(now, yearAgo, size);
  }
  return buildCalendarBuckets(
    now,
    yearAgo,
    size,
    anchorDayOfWeek,
    anchorDayOfMonth,
  );
}

function buildTodayBuckets(now: Date, from: Date, size: WindowSize): Bucket[] {
  // Trail backwards from now - always complete buckets
  const buckets: Bucket[] = [];
  let end = new Date(now);
  while (end.getTime() > from.getTime()) {
    const start = stepBack(end, size);
    if (start.getTime() < from.getTime()) break;
    buckets.unshift({
      start: new Date(start),
      end: new Date(end),
      label: formatRange(start, end),
      isPartial: false,
    });
    end = new Date(start);
  }
  return buckets;
}

function buildCalendarBuckets(
  now: Date,
  from: Date,
  size: WindowSize,
  anchorDow: number,
  anchorDom: number,
): Bucket[] {
  // Find the most recent anchor boundary at or before now
  const anchorStart = lastAnchorBefore(now, size, anchorDow, anchorDom);
  const buckets: Bucket[] = [];
  const start = new Date(anchorStart);

  // Most recent bucket - may be partial
  const currentEnd = stepForward(start, size);
  buckets.unshift({
    start: new Date(start),
    end: currentEnd,
    label: formatRange(start, currentEnd),
    isPartial: currentEnd.getTime() > now.getTime(),
  });

  // Walk backwards
  let cur = new Date(start);
  while (true) {
    const prev = stepBackCalendar(cur, size, anchorDow, anchorDom);
    if (prev.getTime() < from.getTime()) break;
    const prevEnd = new Date(cur);
    buckets.unshift({
      start: new Date(prev),
      end: prevEnd,
      label: formatRange(prev, prevEnd),
      isPartial: false,
    });
    cur = new Date(prev);
  }

  return buckets;
}

// All bucket arithmetic uses local-time fields so boundaries land on the
// user's calendar days/months - not UTC's, which can be a day off.
function stepBack(date: Date, size: WindowSize): Date {
  const d = new Date(date);
  if (size === "weekly") d.setDate(d.getDate() - 7);
  else if (size === "monthly") d.setMonth(d.getMonth() - 1);
  else d.setFullYear(d.getFullYear() - 1);
  return d;
}

function stepForward(date: Date, size: WindowSize): Date {
  const d = new Date(date);
  if (size === "weekly") d.setDate(d.getDate() + 7);
  else if (size === "monthly") d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d;
}

function stepBackCalendar(
  date: Date,
  size: WindowSize,
  _anchorDow: number,
  _anchorDom: number,
): Date {
  return stepBack(date, size);
}

function lastAnchorBefore(
  now: Date,
  size: WindowSize,
  anchorDow: number,
  anchorDom: number,
): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (size === "weekly") {
    const dow = d.getDay();
    const diff = (dow - anchorDow + 7) % 7;
    d.setDate(d.getDate() - diff);
    return d;
  }
  if (size === "yearly") {
    return new Date(d.getFullYear(), 0, 1);
  }
  // monthly - find the most recent anchorDom on or before today
  let dom = anchorDom;
  if (dom > daysInMonth(d.getFullYear(), d.getMonth())) {
    dom = daysInMonth(d.getFullYear(), d.getMonth());
  }
  if (d.getDate() >= dom) {
    return new Date(d.getFullYear(), d.getMonth(), dom);
  }
  // Go back a month
  const prevMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const maxDom = Math.min(
    dom,
    daysInMonth(prevMonth.getFullYear(), prevMonth.getMonth()),
  );
  return new Date(prevMonth.getFullYear(), prevMonth.getMonth(), maxDom);
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

// A bucket's human label is its full inclusive-start → exclusive-end range,
// e.g. "2026-05-08 → 2026-05-15" - local dates, never a truncated UTC date.
function formatRange(start: Date, end: Date): string {
  return `${formatLocalDate(start)} → ${formatLocalDate(end)}`;
}

// Buckets per year for each window size - used to gate weekly on sample size.
const BUCKETS_PER_YEAR: Record<WindowSize, number> = {
  weekly: 52,
  monthly: 12,
  yearly: 1,
};
const WINDOW_ORDER: WindowSize[] = ["weekly", "monthly", "yearly"];

// Monthly and yearly are always available - monthly is the minimum (and default)
// resolution. Weekly is gated on ≥5 avg listings/bucket: a finer breakdown of a
// small sample risks resolving figures down to individual listings, which the
// anonymity standard the data is published under does not permit.
export function availableWindowSizes(listingCount: number): WindowSize[] {
  return WINDOW_ORDER.filter(
    (size) =>
      size === "monthly" || size === "yearly" ||
      listingCount / BUCKETS_PER_YEAR[size] >= 5,
  );
}
