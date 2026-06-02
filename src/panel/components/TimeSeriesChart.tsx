import { useEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
// @ts-ignore - CSS imported as a text string via the esbuild npm-css-text plugin
import uplotCss from "uplot/dist/uPlot.min.css";
import type { MetricKey, WindowSize } from "../../types.ts";
import type { AggregateSummary, SeriesSummary } from "../lib/aggregate.ts";
import { SERIES_COLORS, SERIES_FILLS } from "../lib/colors.ts";
import { formatLocalDate, formatMetricValue } from "../lib/format.ts";

// uPlot relies on its own stylesheet to overlay the cursor layer above the
// canvas - without it the hover cursor never registers. Inject it once.
function ensureUplotCss(): void {
  if (document.getElementById("seelevel-uplot-css")) return;
  const style = document.createElement("style");
  style.id = "seelevel-uplot-css";
  style.textContent = uplotCss as string;
  document.head.appendChild(style);
}

// Floating tooltip: on hover, shows the hovered bucket's date range and each
// series' value (one row per series - two for the List/Sold metrics).
function tooltipPlugin(
  series: SeriesSummary[],
  metric: MetricKey,
): uPlot.Plugin {
  let tip: HTMLDivElement | null = null;
  return {
    hooks: {
      init: (u: uPlot) => {
        tip = document.createElement("div");
        tip.className = "seelevel-chart-tip";
        tip.style.display = "none";
        u.over.appendChild(tip);
      },
      setCursor: (u: uPlot) => {
        if (!tip) return;
        const idx = u.cursor.idx;
        const base = idx == null ? undefined : series[0]?.buckets[idx];
        if (idx == null || !base) {
          tip.style.display = "none";
          return;
        }
        const rows = series.map((s, i) => {
          const b = s.buckets[idx];
          const v = metric === "volume" ? (b?.count ?? null) : (b?.avg ?? null);
          const color = SERIES_COLORS[i % SERIES_COLORS.length];
          return `<div class="seelevel-chart-tip__row">` +
            `<span class="seelevel-chart-tip__dot" style="background:${color}"></span>` +
            `${s.label}&nbsp;<strong>${
              formatMetricValue(v, metric)
            }</strong></div>`;
        }).join("");
        tip.innerHTML =
          `<div class="seelevel-chart-tip__date">${base.bucket.label}</div>${rows}`;
        tip.style.display = "block";
        // Anchor to whichever side of the cursor keeps it inside the chart.
        const x = u.cursor.left ?? 0;
        const rightHalf = x > u.over.clientWidth / 2;
        tip.style.left = rightHalf ? "auto" : `${x + 12}px`;
        tip.style.right = rightHalf
          ? `${u.over.clientWidth - x + 12}px`
          : "auto";
      },
    },
  };
}

export function TimeSeriesChart({
  summary,
  metric,
  windowSize: _windowSize,
}: { summary: AggregateSummary; metric: MetricKey; windowSize: WindowSize }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    ensureUplotCss();
    const series = summary.series;
    const xs = series[0].buckets.map((b) => b.bucket.start.getTime() / 1000);
    // Empty buckets plot as 0 so the line travels along the zero axis rather
    // than vanishing - Volume already counts 0, value metrics fall back to 0.
    const ys = series.map((s) =>
      s.buckets.map((b) => (metric === "volume" ? b.count : (b.avg ?? 0)))
    );

    const baseAxis: uPlot.Axis = {
      stroke: "oklch(42% 0.02 235)",
      ticks: { stroke: "oklch(28% 0.025 245)" },
      grid: { stroke: "oklch(28% 0.025 245)" },
    };
    const yAxis: uPlot.Axis = { ...baseAxis };
    if (metric === "price") {
      // Price ticks read as thousands - e.g. 200000 → "200k".
      yAxis.values = (_u, splits) =>
        splits.map((v) => (v == null ? "" : `${Math.round(v / 1000)}k`));
    }

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 120,
      // Sync the hover cursor across every metric chart - they all share the
      // same buckets, so hovering one shows that bucket's tooltip on all of
      // them. Only the x axis is synced; each chart keeps its own y scale.
      cursor: {
        show: true,
        sync: { key: "seelevel-metric-charts", scales: ["x", null] },
      },
      legend: { show: false },
      axes: [baseAxis, yAxis],
      plugins: [tooltipPlugin(series, metric)],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.label,
          stroke: SERIES_COLORS[i % SERIES_COLORS.length],
          fill: SERIES_FILLS[i % SERIES_FILLS.length],
          width: 1.5,
          points: { show: false },
        })),
      ],
    };

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new uPlot(
      opts,
      [xs, ...ys] as uPlot.AlignedData,
      containerRef.current,
    );
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [summary, metric]);

  // Keep the chart width matched to its container. When the panel's vertical
  // scrollbar appears it narrows the column - a chart sized to the old width
  // would overflow and produce a horizontal scrollbar.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const c = chartRef.current;
      const w = el.clientWidth;
      if (c && w > 0 && w !== c.width) {
        c.setSize({ width: w, height: c.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Full span the chart covers - first bucket's start to last bucket's end.
  // Identical for every chart since they all share the same buckets.
  const buckets = summary.series[0]?.buckets ?? [];
  const chartRange = buckets.length > 0
    ? `${formatLocalDate(buckets[0].bucket.start)} → ` +
      `${formatLocalDate(buckets[buckets.length - 1].bucket.end)}`
    : "";

  return (
    <div
      style={{
        padding: "8px 14px 0",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      }}
    >
      <div
        style={{
          fontSize: "9px",
          color: "var(--color-muted)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          display: "flex",
          gap: "9px",
        }}
      >
        {summary.series.map((s, i) => (
          <span
            key={s.label}
            style={{ display: "flex", alignItems: "center", gap: "3px" }}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "2px",
                background: SERIES_COLORS[i % SERIES_COLORS.length],
              }}
            />
            {s.label}
          </span>
        ))}
      </div>
      <div ref={containerRef} style={{ width: "100%", marginTop: "2px" }} />
      <div
        style={{
          fontSize: "9px",
          color: "var(--color-subtle)",
          fontWeight: 600,
          letterSpacing: "0.3px",
          textAlign: "center",
        }}
      >
        {chartRange}
      </div>
    </div>
  );
}
