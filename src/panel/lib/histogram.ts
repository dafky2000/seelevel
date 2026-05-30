import type { ListingRow } from "../../types.ts";
import type { Bucket } from "./bucket.ts";
import { metricSeries, type SeriesSide } from "./aggregate.ts";

// One x-axis bar: [lo, hi) price range (the last even bin is inclusive of its
// max; the open-ended cap bucket has hi = Infinity), with one count per series
// aligned to PriceHistogram.seriesLabels.
export interface HistogramBin {
  lo: number;
  hi: number;
  label: string;
  isCap: boolean; // true for the collapsed luxury-tail buckets ($1M+ etc.)
  counts: number[];
}

export interface PriceHistogram {
  bins: HistogramBin[];
  seriesLabels: string[]; // ["List","Sold"] or a side-filtered subset
  step: number; // even-region bin width (0 for a single/degenerate bin)
  hasData: boolean;
}

// The luxury tail is collapsed into these wide buckets so a single
// multi-million-dollar outlier can't crush the dense sub-$1M range into one bar
// with a long run of empty bars after it. Each is shown only when populated.
const CAP_TIERS: { lo: number; hi: number; label: string }[] = [
  { lo: 1_000_000, hi: 2_000_000, label: "$1M+" },
  { lo: 2_000_000, hi: 5_000_000, label: "$2M+" },
  { lo: 5_000_000, hi: Infinity, label: "$5M+" },
];
const FIRST_CAP = CAP_TIERS[0].lo;

// Floor on the even-region bin width. A very tight price range would otherwise
// produce sub-$25k bins that resolve down toward individual listings; 25k is a
// "nice" step and divides $1M cleanly, so the even region still lands on $1M.
const MIN_STEP = 25_000;

const EMPTY: PriceHistogram = {
  bins: [],
  seriesLabels: [],
  step: 0,
  hasData: false,
};

// Bins listing prices in the most recent complete window. List and Sold share
// one set of edges so the two histograms overlay on a single x-axis. The
// per-series value + date logic (including the sold-status rule) is reused from
// aggregate's price series, never duplicated.
export function priceHistogram(
  listings: ListingRow[],
  bucket: Bucket,
  sides: SeriesSide[] | null,
  targetBins = 10,
): PriceHistogram {
  const defs = metricSeries("price").filter(
    (d) => sides === null || sides.includes(d.side),
  );

  // Each series' prices for listings whose relevant date falls in the window.
  const perSeries = defs.map((def) =>
    listings
      .filter((l) => {
        const d = def.date(l);
        return d !== null && d >= bucket.start && d < bucket.end;
      })
      .map(def.value)
      .filter((v): v is number => v !== null)
  );

  const all = perSeries.flat();
  if (all.length === 0) return EMPTY;

  const min = Math.min(...all);
  const max = Math.max(...all);
  const seriesLabels = defs.map((d) => d.label);
  const zeros = () => new Array(defs.length).fill(0);

  // All values identical → a single bin centred on that price.
  if (max === min) {
    return {
      bins: [{
        lo: min,
        hi: min,
        label: binLabel(min, min),
        isCap: min >= FIRST_CAP,
        counts: perSeries.map((vals) => vals.length),
      }],
      seriesLabels,
      step: 0,
      hasData: true,
    };
  }

  // Even region covers the dense sub-$1M range; when there's a luxury tail it
  // stops at exactly $1M (a "nice" step always divides $1M) so the cap buckets
  // pick up cleanly from there.
  const hasTail = max >= FIRST_CAP;
  const evenTop = hasTail ? FIRST_CAP : max;
  const step = Math.max(niceStep((evenTop - min) / targetBins), MIN_STEP);
  const loEdge = Math.floor(min / step) * step;
  const evenTopEdge = hasTail
    ? FIRST_CAP
    : Math.floor(max / step) * step + step; // push past max so it has a bin

  const bins: HistogramBin[] = [];
  for (let lo = loEdge; lo < evenTopEdge - 1e-6; lo += step) {
    const hi = lo + step;
    bins.push({
      lo,
      hi,
      label: binLabel(lo, hi),
      isCap: false,
      counts: zeros(),
    });
  }

  // Append only the cap buckets that actually hold a listing ("as required").
  if (hasTail) {
    for (const tier of CAP_TIERS) {
      if (all.some((v) => v >= tier.lo && v < tier.hi)) {
        bins.push({
          lo: tier.lo,
          hi: tier.hi,
          label: tier.label,
          isCap: true,
          counts: zeros(),
        });
      }
    }
  }

  perSeries.forEach((vals, s) => {
    for (const v of vals) {
      let i = bins.findIndex((b) => v >= b.lo && v < b.hi);
      if (i < 0) i = v < bins[0].lo ? 0 : bins.length - 1;
      bins[i].counts[s]++;
    }
  });

  return { bins, seriesLabels, step, hasData: true };
}

// Snap a raw step up to a "nice" value: 1, 2, 2.5, 5, or 10 × a power of ten.
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const niceNorm = norm <= 1
    ? 1
    : norm <= 2
    ? 2
    : norm <= 2.5
    ? 2.5
    : norm <= 5
    ? 5
    : 10;
  return niceNorm * mag;
}

// "200k", "1M", "2.5M" - prices read as thousands below $1M, millions above,
// matching the rest of the panel.
export function abbrevPrice(v: number): string {
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  return `${Math.round(v / 1000)}k`;
}

// "$200k–250k" for an even bin; "$300k" for a degenerate single-value bin.
function binLabel(lo: number, hi: number): string {
  return lo === hi
    ? `$${abbrevPrice(lo)}`
    : `$${abbrevPrice(lo)}–${abbrevPrice(hi)}`;
}
