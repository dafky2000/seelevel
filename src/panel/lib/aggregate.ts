import type { ListingRow, MetricKey } from "../../types.ts";
import type { Bucket } from "./bucket.ts";

export interface BucketStat {
  bucket: Bucket;
  count: number;
  avg: number | null;
  median: number | null;
  stdDev: number | null;
  belowFloor: boolean; // true if count < EXPORT_FLOOR
}

// A series is anchored to either the listing date or the sale date - this also
// decides whether it survives an explicit "for sale" vs "sold" search filter.
export type SeriesSide = "list" | "sold";

// One plotted line: a metric is one or more of these (e.g. "price" = List + Sold).
export interface SeriesSummary {
  label: string;
  side: SeriesSide;
  buckets: BucketStat[];
  latest: BucketStat | null; // most recent complete bucket - the headline figure
  overall: {
    count: number;
    avg: number | null;
    median: number | null;
    stdDev: number | null;
  };
  delta: number | null; // fractional change of the last two complete buckets
}

export interface AggregateSummary {
  series: SeriesSummary[];
}

const EXPORT_FLOOR = 5; // buckets below this are flagged (suppressed in CSV export)

// ─── Series definitions ───────────────────────────────────────────────────────
// sold/active is transparent: each series picks its own value + date field, so
// the distinction surfaces as data (List vs Sold) rather than a user filter.
interface SeriesDef {
  label: string;
  side: SeriesSide;
  value: (l: ListingRow) => number | null;
  date: (l: ListingRow) => Date | null;
  isCount: boolean; // count listings rather than averaging values (Volume)
}

// ViewPoint dates are date-only strings; `new Date("2025-05-01")` would parse
// them as UTC midnight. Force local midnight so a listing lands in the same
// calendar bucket the user sees labelled.
function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = s.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(t + "T00:00:00") : new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

// ViewPoint status_id 2 = Sold. Other statuses (notably 6 = pending/
// conditional) can carry a sold_dt - an accepted-offer date - without an
// actual sale, so they must never count toward sold-side metrics.
const STATUS_SOLD = 2;

const listDate = (l: ListingRow): Date | null => parseDate(l.list_dt);
const soldDate = (l: ListingRow): Date | null =>
  l.status_id === STATUS_SOLD ? parseDate(l.sold_dt ?? l.close_dt) : null;

// Days on market - list date through to the recorded sale.
function soldDom(l: ListingRow): number | null {
  const list = listDate(l), sold = soldDate(l);
  if (!list || !sold) return null;
  return Math.round((sold.getTime() - list.getTime()) / 86400000);
}

function ppsf(price: number | null, tla: number | null): number | null {
  return price && tla && tla > 0 ? price / tla : null;
}

function metricSeries(metric: MetricKey): SeriesDef[] {
  switch (metric) {
    case "price":
      return [
        { label: "List", side: "list", value: (l) => l.list_price, date: listDate, isCount: false },
        { label: "Sold", side: "sold", value: (l) => l.sold_price, date: soldDate, isCount: false },
      ];
    case "volume":
      return [
        { label: "Listed", side: "list", value: () => 1, date: listDate, isCount: true },
        { label: "Sold", side: "sold", value: () => 1, date: soldDate, isCount: true },
      ];
    case "dom":
      // Days on market is intrinsically a completed-sale figure - single series.
      return [{ label: "DOM", side: "sold", value: soldDom, date: soldDate, isCount: false }];
    case "ppsf":
      return [
        { label: "List", side: "list", value: (l) => ppsf(l.list_price, l.tla), date: listDate, isCount: false },
        { label: "Sold", side: "sold", value: (l) => ppsf(l.sold_price, l.tla), date: soldDate, isCount: false },
      ];
    case "listToSold":
      return [{
        label: "L→S",
        side: "sold",
        value: (l) => (l.list_price && l.sold_price && l.list_price > 0 ? l.sold_price / l.list_price : null),
        date: soldDate,
        isCount: false,
      }];
  }
}

export function aggregate(
  listings: ListingRow[],
  metric: MetricKey,
  buckets: Bucket[],
): AggregateSummary {
  return { series: metricSeries(metric).map((def) => computeSeries(listings, def, buckets)) };
}

function computeSeries(listings: ListingRow[], def: SeriesDef, buckets: Bucket[]): SeriesSummary {
  const bucketStats: BucketStat[] = buckets.map((bucket) => {
    const inBucket = listings.filter((l) => {
      const d = def.date(l);
      return d !== null && d >= bucket.start && d < bucket.end;
    });
    const values = inBucket.map(def.value).filter((v): v is number => v !== null);
    return {
      bucket,
      count: def.isCount ? inBucket.length : values.length,
      ...computeStats(def.isCount ? null : values),
      belowFloor: inBucket.length < EXPORT_FLOOR,
    };
  });

  const dated = listings.filter((l) => def.date(l) !== null);
  const allValues = dated.map(def.value).filter((v): v is number => v !== null);
  const overall = {
    count: def.isCount ? dated.length : allValues.length,
    ...computeStats(def.isCount ? null : allValues),
  };

  // The headline figure is the most recent *complete* window (clamped by its
  // end date) - not the year total. Fall back to the last bucket if every
  // bucket is still partial.
  const complete = bucketStats.filter((b) => !b.bucket.isPartial);
  const latest = complete.length > 0
    ? complete[complete.length - 1]
    : (bucketStats[bucketStats.length - 1] ?? null);

  // Delta: most recent complete bucket vs the one before it (count for Volume,
  // average otherwise).
  const deltaVal = (b: BucketStat): number | null => (def.isCount ? b.count : b.avg);
  const withValue = complete.filter((b) => deltaVal(b) !== null);
  let delta: number | null = null;
  if (withValue.length >= 2) {
    const curr = deltaVal(withValue[withValue.length - 1])!;
    const prev = deltaVal(withValue[withValue.length - 2])!;
    if (prev !== 0) delta = (curr - prev) / prev;
  }

  return { label: def.label, side: def.side, buckets: bucketStats, latest, overall, delta };
}

function computeStats(values: number[] | null) {
  if (!values || values.length === 0) {
    return { avg: null, median: null, stdDev: null };
  }
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) /
    values.length;
  return { avg, median, stdDev: Math.sqrt(variance) };
}
