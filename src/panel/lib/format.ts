import type { MetricKey } from "../../types.ts";

// A date as YYYY-MM-DD in the *local* time zone - `toISOString()` would render
// it in UTC and can show tomorrow's date late in the evening for the user.
export function formatLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Human-readable value for a metric - shared by the stat cards and the chart
// hover tooltip so a figure reads identically wherever it appears.
export function formatMetricValue(v: number | null, metric: MetricKey): string {
  if (v === null) return "-";
  if (metric === "price") return `$${Math.round(v / 1000)}k`;
  if (metric === "ppsf") return `$${Math.round(v)}`;
  if (metric === "dom") return `${Math.round(v)}d`;
  if (metric === "listToSold") return `${(v * 100).toFixed(1)}%`;
  return String(Math.round(v));
}
