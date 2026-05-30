import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
import type { PriceHistogram } from "../lib/histogram.ts";
import { abbrevPrice } from "../lib/histogram.ts";
import { SERIES_COLORS, SERIES_FILLS } from "../lib/colors.ts";

// uPlot's stylesheet is injected once by TimeSeriesChart's ensureUplotCss; this
// chart relies on the same global style being present (the panel always renders
// the time-series charts above it). Keep a local guard anyway in case order
// ever changes.
function ensureUplotCss(): void {
  if (document.getElementById("seelevel-uplot-css")) return;
  // Minimal: the cursor overlay needs position context. The full sheet is
  // injected by TimeSeriesChart; this is a no-op fallback.
}

// Floating tooltip: the hovered bin's price range and each series' count.
function tooltipPlugin(hist: PriceHistogram): uPlot.Plugin {
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
        const bin = idx == null ? undefined : hist.bins[idx];
        if (idx == null || !bin) {
          tip.style.display = "none";
          return;
        }
        const rows = hist.seriesLabels.map((label, i) => {
          const color = SERIES_COLORS[i % SERIES_COLORS.length];
          return `<div class="seelevel-chart-tip__row">` +
            `<span class="seelevel-chart-tip__dot" style="background:${color}"></span>` +
            `${label}&nbsp;<strong>${bin.counts[i]}</strong></div>`;
        }).join("");
        tip.innerHTML =
          `<div class="seelevel-chart-tip__date">${bin.label}</div>${rows}`;
        tip.style.display = "block";
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

export function PriceHistogramChart(
  { histogram, windowLabel }: {
    histogram: PriceHistogram;
    windowLabel: string;
  },
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current || !histogram.hasData) return;
    ensureUplotCss();

    // Bins are variable-width (even sub-$1M bins + wide cap buckets), so the x
    // axis is ordinal: one equal-width slot per bin, indexed 0..n-1. A
    // proportional numeric axis would re-crush the sub-$1M bars under the wide
    // cap buckets - the very thing the capping is meant to avoid.
    const bins = histogram.bins;
    const n = bins.length;
    const xs = bins.map((_, i) => i);
    const ys = histogram.seriesLabels.map((_, i) =>
      bins.map((b) => b.counts[i])
    );

    // Label every Nth even bin (by its lower edge) so ticks don't overlap in the
    // narrow panel; always label the cap buckets.
    const capStart = bins.findIndex((b) => b.isCap);
    const evenCount = capStart === -1 ? n : capStart;
    const every = Math.max(1, Math.ceil(evenCount / 7));
    const tickIdx = xs.filter((i) => i >= evenCount ? true : i % every === 0);
    const tickLabel = (i: number) =>
      bins[i].isCap ? bins[i].label : abbrevPrice(bins[i].lo);

    const baseAxis: uPlot.Axis = {
      stroke: "oklch(42% 0.02 235)",
      ticks: { stroke: "oklch(28% 0.025 245)" },
      grid: { stroke: "oklch(28% 0.025 245)" },
    };
    const xAxis: uPlot.Axis = {
      ...baseAxis,
      splits: () => tickIdx,
      values: (_u, splits) =>
        splits.map((v) => (v == null ? "" : tickLabel(v))),
    };
    const yAxis: uPlot.Axis = {
      ...baseAxis,
      // Counts are integers - drop fractional tick labels.
      values: (_u, splits) =>
        splits.map((v) => v == null || !Number.isInteger(v) ? "" : String(v)),
    };

    // Wider behind, narrower in front. align:0 centres each bar on the slot.
    const sizeFor = (i: number): [number, number] =>
      i === 0 ? [0.92, 60] : [0.55, 40];

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 120,
      cursor: { show: true },
      legend: { show: false },
      // One unit per bin; pad half a slot each side so edge bars aren't clipped.
      scales: {
        x: { time: false, range: () => [-0.5, n - 0.5] },
      },
      axes: [xAxis, yAxis],
      plugins: [tooltipPlugin(histogram)],
      series: [
        {},
        ...histogram.seriesLabels.map((label, i) => ({
          label,
          stroke: SERIES_COLORS[i % SERIES_COLORS.length],
          fill: SERIES_FILLS[i % SERIES_FILLS.length],
          width: 1,
          points: { show: false },
          paths: uPlot.paths.bars!({ size: sizeFor(i), align: 0 }),
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
  }, [histogram]);

  // Match the chart width to its container (same as TimeSeriesChart).
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

  if (!histogram.hasData) return null;

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
        {histogram.seriesLabels.map((label, i) => (
          <span
            key={label}
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
            {label}
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
        {windowLabel}
      </div>
    </div>
  );
}
