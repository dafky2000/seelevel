import { h } from "preact";
import type { MetricKey } from "../../../types.ts";
import type { AggregateSummary, SeriesSummary } from "../lib/aggregate.ts";
import { SERIES_COLORS } from "../lib/colors.ts";
import { formatMetricValue as fmt } from "../lib/format.ts";

// One stat block (avg / median / std·total) for a single series. Reflects the
// most recent complete window - `latest` - not the whole-year total.
function SeriesStats(
  { s, metric, index, showLabel }: {
    s: SeriesSummary;
    metric: MetricKey;
    index: number;
    showLabel: boolean;
  },
) {
  const { latest, delta } = s;
  const isVol = metric === "volume";
  const deltaClass = delta === null ? "vpa-delta--neutral"
    : delta > 0 ? "vpa-delta--up" : "vpa-delta--down";
  const deltaStr = delta === null ? "-"
    : `${delta > 0 ? "↑" : "↓"} ${Math.abs(delta * 100).toFixed(1)}%`;

  // Heading with the matching legend swatch (same colour as the chart line).
  const heading = showLabel
    ? (
      <div class="vpa-series-label">
        <span
          class="vpa-series-label__dot"
          style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }}
        />
        {s.label}
      </div>
    )
    : null;

  // Volume has only a count - one full-width block, no empty median/std cells.
  if (isVol) {
    return (
      <>
        {heading}
        <div class="vpa-stats vpa-stats--single">
          <div class="vpa-stat">
            <div class="vpa-stat__val">{String(latest?.count ?? 0)}</div>
            <div class="vpa-stat__lbl">Count</div>
            <div class={`vpa-stat__delta ${deltaClass}`}>{deltaStr}</div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {heading}
      <div class="vpa-stats">
        <div class="vpa-stat">
          <div class="vpa-stat__val">{fmt(latest?.avg ?? null, metric)}</div>
          <div class="vpa-stat__lbl">Average</div>
          <div class={`vpa-stat__delta ${deltaClass}`}>{deltaStr}</div>
        </div>
        <div class="vpa-stat">
          <div class="vpa-stat__val">{fmt(latest?.median ?? null, metric)}</div>
          <div class="vpa-stat__lbl">Median</div>
        </div>
        <div class="vpa-stat">
          <div class="vpa-stat__val">{fmt(latest?.stdDev ?? null, metric)}</div>
          <div class="vpa-stat__lbl">Std Dev</div>
        </div>
      </div>
    </>
  );
}

// Renders one stat block per series - two (List / Sold) for most metrics.
// The period caption names which window the headline figures cover.
export function StatsRow({ summary, metric }: { summary: AggregateSummary; metric: MetricKey }) {
  const multi = summary.series.length > 1;
  const period = summary.series[0]?.latest?.bucket.label ?? null;
  return (
    <div>
      {summary.series.map((s, i) => (
        <SeriesStats key={s.label} s={s} metric={metric} index={i} showLabel={multi} />
      ))}
      {period && <div class="vpa-stat-period">{period}</div>}
    </div>
  );
}
