# Price distribution histogram

A new chart in the side panel: price on the x-axis, listing count on the y-axis,
for the most recent complete window. List prices (teal) and Sold prices (amber)
are overlaid on shared bins.

## Scope decisions

- **Data scope:** the most recent _complete_ window — the same period the
  headline Average/Median/Std cards (`StatsRow`, fed by `SeriesSummary.latest`)
  already summarize. Switching weekly/monthly/yearly re-bins that window.
- **Binning:** the dense sub-$1M range gets evenly-spaced bins (a "nice" step of
  1 / 2 / 2.5 / 5 × 10ⁿ, targeting ~20 bins up to $1M), and the long luxury tail
  is collapsed into wide cap buckets — "$1M+" ($1–2M), "$2M+" ($2–5M), "$5M+"
  (≥$5M) — each included only when a listing falls in it ("as required"). This
  keeps the bulk of the distribution at full resolution instead of being crushed
  by a single multi-million-dollar outlier, and removes the long run of empty
  "0" bars between the bulk and the outliers. When the whole window is under $1M
  there are no cap buckets and binning is plain even bins over [min, max]. Edges
  are shared across both series (an overlay needs one x-axis); the last even bin
  is inclusive of its max, and `$5M+` is open-ended. The even-region step is
  floored at **$25k** so a tight price range can't resolve down toward
  individual listings ($25k is itself a "nice" step and divides $1M cleanly).
- **Rendering axis:** because bins are now variable-width, the chart uses an
  **ordinal** x-axis (one equal-width slot per bin) with tick labels drawn from
  each bin's lower edge / cap label — not a proportional numeric axis, which
  would re-crush the sub-$1M bars under the wide tail buckets.
- **Series:** List + Sold overlaid, nested width (List wider/behind, Sold
  narrower/in-front) so both read clearly. Respects the active/sold search
  filter exactly as every other metric does — a "for sale" search shows only
  List, a "sold" search only Sold.

## Components

### `src/panel/lib/histogram.ts` (new, pure)

```ts
priceHistogram(
  listings: ListingRow[],
  bucket: Bucket,
  sides: SeriesSide[] | null,   // null = all sides
  targetBins = 10,
): {
  bins: { lo: number; hi: number; label: string; counts: number[] }[];
  seriesLabels: string[];       // ["List","Sold"] or a filtered subset
  step: number;
  hasData: boolean;
}
```

- Reuses `metricSeries("price")` from `aggregate.ts` (exported for this) so the
  List/Sold value + date logic — including the `status_id === 2` sold rule — is
  not duplicated.
- For each series, selects listings whose relevant date falls in
  `[bucket.start,
  bucket.end)` and takes the relevant price; pools all values
  to pick shared bin edges; counts each series per bin (`counts[]` aligned to
  `seriesLabels`).
- Nice-number step: `rawStep = (max-min)/targetBins`, snapped up to
  `{1,2,2.5,5,10} × 10^floor(log10(rawStep))`. Edges start at
  `floor(min/step)*step`.
- Degenerate cases handled explicitly: no values → `hasData:false`, `bins:[]`;
  all-equal prices (`max === min`) → a single bin centered on that price.
- Pure and deterministic (takes `bucket` as a param — no `Date.now()`), so it is
  unit-testable like the other `lib/` modules.

### `src/panel/components/PriceHistogramChart.tsx` (new)

- uPlot `bars` paths, two overlaid series using `SERIES_COLORS` /
  `SERIES_FILLS`. List drawn first at a wider `size` factor, Sold second at a
  narrower one.
- x-axis ticks formatted as thousands (`"250k"`); y-axis integer counts.
- Hover tooltip reusing the `.seelevel-chart-tip` class: bin price range + each
  series' count. Same `ResizeObserver` width-sync as `TimeSeriesChart`.

### `App.tsx` wiring

- In the existing recompute effect, find the latest complete bucket from the
  already-built `buckets` (fallback: the last bucket), call
  `priceHistogram(visible, latestBucket, side)`, and hold it in new panel state.
- Render it as its own block titled **"Price distribution"** directly after the
  Volume metric section.
- **Renders in yearly mode too** — unlike the time-series charts (`!isYearly`),
  a distribution of the year's prices is meaningful where a single-point line is
  not.

## Data flow / scope

Uses the same `scopedListings(store)` (viewport / session / zone) and the same
`searchStatus` → side filter as every other metric. No new messages, no store
shape change beyond transient panel-render state.

## Out of scope / constraints

- **CSV export is unchanged.** The histogram is a derived view of one window;
  export stays the aggregate time-series. No new permissions, no persistence —
  consistent with the load-bearing compliance rules in CLAUDE.md.
- Display renders small bins as-is. The `< 5` floor is an _export_ rule only,
  and this view is not exported; the Volume chart already shows small on-screen
  counts.

## Tests

New `src/panel/lib/__tests__/histogram.test.ts` (`jsr:@std/assert@1`, matching
convention):

- nice-bin edges + ~10 bins with correct per-bin counts,
- both series share the same edges,
- side filter (List-only, Sold-only),
- empty input → `hasData:false`,
- all-equal prices → single bin,
- last bin includes the max value.

No existing tests are modified.
