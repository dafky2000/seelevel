import type {
  BBox,
  ListingRow,
  ScopeKey,
  SearchStatus,
  WindowSize,
} from "../../types.ts";
import type { Bucket } from "./bucket.ts";
import type { SeriesSide } from "./aggregate.ts";
import { aggregate } from "./aggregate.ts";
import { priceHistogram } from "./histogram.ts";

// Rolled-up figures for the latest complete bucket of one tab's scoped
// listings. Counts come from the Volume series (listings with a list/sold date
// in the window); the averages/medians and the per-listing sold volume come
// from the Price series (listings with a non-null price). soldVolume is the sum
// of known sold prices = soldAvg × (#priced solds), so it can be <= soldCount's
// worth of listings when some sold rows carry no price.
export interface ParityFigures {
  scopedCount: number;
  listedCount: number;
  soldCount: number;
  soldVolume: number;
  listAvg: number | null;
  listMedian: number | null;
  soldAvg: number | null;
  soldMedian: number | null;
  histogram: { label: string; listCount: number; soldCount: number }[];
}

function emptyFigures(scopedCount: number): ParityFigures {
  return {
    scopedCount,
    listedCount: 0,
    soldCount: 0,
    soldVolume: 0,
    listAvg: null,
    listMedian: null,
    soldAvg: null,
    soldMedian: null,
    histogram: [],
  };
}

// Same rule aggregate() uses for its headline figure: the most recent
// non-partial bucket, falling back to the last bucket if all are partial.
function latestComplete(buckets: Bucket[]): Bucket | null {
  const complete = buckets.filter((b) => !b.isPartial);
  if (complete.length > 0) return complete[complete.length - 1];
  return buckets[buckets.length - 1] ?? null;
}

// Pure: figures for the latest complete bucket. `side` filters the histogram
// only (matching the panel's "for sale"/"sold" treatment); the scalar stats
// always carry both sides so the diff shows everything.
export function buildFigures(
  listings: ListingRow[],
  buckets: Bucket[],
  side: SeriesSide[] | null,
): ParityFigures {
  const bucket = latestComplete(buckets);
  if (!bucket) return emptyFigures(listings.length);

  const vol = aggregate(listings, "volume", [bucket]).series;
  const price = aggregate(listings, "price", [bucket]).series;
  const listVol = vol.find((s) => s.side === "list")?.buckets[0] ?? null;
  const soldVol = vol.find((s) => s.side === "sold")?.buckets[0] ?? null;
  const listPrice = price.find((s) => s.side === "list")?.buckets[0] ?? null;
  const soldPrice = price.find((s) => s.side === "sold")?.buckets[0] ?? null;

  const soldAvg = soldPrice?.avg ?? null;
  const soldVolume = soldAvg !== null
    ? Math.round(soldAvg * (soldPrice?.count ?? 0))
    : 0;

  const hist = priceHistogram(listings, bucket, side, 20);
  const listIdx = hist.seriesLabels.indexOf("List");
  const soldIdx = hist.seriesLabels.indexOf("Sold");
  const histogram = hist.bins.map((b) => ({
    label: b.label,
    listCount: listIdx >= 0 ? b.counts[listIdx] : 0,
    soldCount: soldIdx >= 0 ? b.counts[soldIdx] : 0,
  }));

  return {
    scopedCount: listings.length,
    listedCount: listVol?.count ?? 0,
    soldCount: soldVol?.count ?? 0,
    soldVolume,
    listAvg: listPrice?.avg ?? null,
    listMedian: listPrice?.median ?? null,
    soldAvg,
    soldMedian: soldPrice?.median ?? null,
    histogram,
  };
}

// A captured snapshot of one tab, returned by window.__seelevelSnapshot().
export interface ParitySnapshot {
  tabId: number;
  host: string | null;
  scope: ScopeKey;
  searchStatus: SearchStatus;
  windowSize: WindowSize;
  loading: boolean;
  bbox: BBox | null;
  polygon: [number, number][] | null;
  figures: ParityFigures;
}

export interface Tolerance {
  relPct: number;
  absFloor: number;
}
// Loose default while we gather data from real runs. `pass` is advisory only.
export const DEFAULT_TOL: Tolerance = { relPct: 0.10, absFloor: 2 };

export interface FigureDelta {
  key: string;
  a: number | null;
  b: number | null;
  absDelta: number | null;
  relDelta: number | null;
  pass: boolean;
}

export interface ParityReport {
  aligned: boolean;
  alignment: {
    scopeMatch: boolean;
    statusMatch: boolean;
    windowMatch: boolean;
    bboxMatch: boolean; // bbox (or, in zone scope, polygon) match within epsilon
  };
  deltas: FigureDelta[];
}

const BOUNDS_EPS = 1e-4; // ~11 m; lat/lng degrees

function figDelta(
  key: string,
  a: number | null,
  b: number | null,
  tol: Tolerance,
): FigureDelta {
  if (a === null || b === null) {
    return { key, a, b, absDelta: null, relDelta: null, pass: a === b };
  }
  const absDelta = Math.abs(a - b);
  const base = Math.max(Math.abs(a), Math.abs(b));
  const relDelta = base === 0 ? 0 : absDelta / base;
  const pass = absDelta <= Math.max(tol.absFloor, tol.relPct * base);
  return { key, a, b, absDelta, relDelta, pass };
}

function approxBboxEqual(a: BBox | null, b: BBox | null): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.sw_lat - b.sw_lat) < BOUNDS_EPS &&
    Math.abs(a.sw_lng - b.sw_lng) < BOUNDS_EPS &&
    Math.abs(a.ne_lat - b.ne_lat) < BOUNDS_EPS &&
    Math.abs(a.ne_lng - b.ne_lng) < BOUNDS_EPS
  );
}

function approxPolyEqual(
  a: [number, number][] | null,
  b: [number, number][] | null,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) =>
    Math.abs(p[0] - b[i][0]) < BOUNDS_EPS &&
    Math.abs(p[1] - b[i][1]) < BOUNDS_EPS
  );
}

function binVal(
  figures: ParityFigures,
  label: string,
  key: "listCount" | "soldCount",
): number | null {
  const bin = figures.histogram.find((h) => h.label === label);
  return bin ? bin[key] : null;
}

// Pure: compare two snapshots figure-by-figure. `aligned` is reported first
// because a parity gap most often just means the viewports weren't lined up.
export function compareAggregates(
  a: ParitySnapshot,
  b: ParitySnapshot,
  tol: Tolerance = DEFAULT_TOL,
): ParityReport {
  const bothZone = a.scope === "zone" && b.scope === "zone";
  const boundsMatch = bothZone
    ? approxPolyEqual(a.polygon, b.polygon)
    : approxBboxEqual(a.bbox, b.bbox);

  const alignment = {
    scopeMatch: a.scope === b.scope,
    statusMatch: a.searchStatus === b.searchStatus,
    windowMatch: a.windowSize === b.windowSize,
    bboxMatch: boundsMatch,
  };
  const aligned = alignment.scopeMatch && alignment.statusMatch &&
    alignment.windowMatch && alignment.bboxMatch;

  const scalarKeys: (keyof Omit<ParityFigures, "histogram">)[] = [
    "scopedCount",
    "listedCount",
    "soldCount",
    "soldVolume",
    "listAvg",
    "listMedian",
    "soldAvg",
    "soldMedian",
  ];
  const deltas: FigureDelta[] = scalarKeys.map((k) =>
    figDelta(
      k,
      a.figures[k] as number | null,
      b.figures[k] as number | null,
      tol,
    )
  );

  // Histogram: union of bin labels (a's order first, then b-only), two deltas
  // per bin. A bin present on only one side yields a null on the other.
  const labels: string[] = [];
  for (const h of a.figures.histogram) labels.push(h.label);
  for (const h of b.figures.histogram) {
    if (!labels.includes(h.label)) labels.push(h.label);
  }
  for (const label of labels) {
    deltas.push(figDelta(
      `hist:${label}:list`,
      binVal(a.figures, label, "listCount"),
      binVal(b.figures, label, "listCount"),
      tol,
    ));
    deltas.push(figDelta(
      `hist:${label}:sold`,
      binVal(a.figures, label, "soldCount"),
      binVal(b.figures, label, "soldCount"),
      tol,
    ));
  }

  return { aligned, alignment, deltas };
}
