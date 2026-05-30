import { h } from "preact";
import type { MetricKey } from "../../../types.ts";
import type { AggregateSummary } from "../lib/aggregate.ts";
import { formatLocalDate } from "../lib/format.ts";

// One section per metric currently shown - exported together as one document.
export interface ExportSection {
  metric: MetricKey;
  summary: AggregateSummary;
}

function formatValue(v: number | null, metric: MetricKey): string {
  if (v === null) return "";
  if (metric === "listToSold") return (v * 100).toFixed(2) + "%";
  return v.toFixed(2);
}

export function ExportButton(
  { sections }: { sections: ExportSection[] | null },
) {
  const ready = !!sections && sections.length > 0;

  function download() {
    if (!sections || sections.length === 0) return;
    // Every metric shares the same buckets - emit one wide table keyed by
    // bucket, with a column group per metric series.
    const buckets = sections[0].summary.series[0]?.buckets ?? [];

    const header = ["bucket_start", "bucket_end"];
    for (const sec of sections) {
      for (const s of sec.summary.series) {
        // metric prefix always; series infix only when a metric has 2 series.
        const infix = sec.summary.series.length > 1
          ? `${s.label.toLowerCase()}_`
          : "";
        const p = `${sec.metric.toLowerCase()}_${infix}`;
        header.push(`${p}count`, `${p}avg`, `${p}median`, `${p}std_dev`);
      }
    }

    const rows: string[] = [
      `# Source: ViewPoint.ca (NSAR MLS® System and Province of Nova Scotia). For personal use only.`,
      `# Generated: ${new Date().toISOString()}`,
      header.join(","),
    ];

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i].bucket;
      const cells = [
        formatLocalDate(bucket.start),
        formatLocalDate(bucket.end),
      ];
      for (const sec of sections) {
        for (const s of sec.summary.series) {
          const b = s.buckets[i];
          // Always export the actual figures - no small-sample suppression.
          cells.push(
            b ? String(b.count) : "",
            formatValue(b?.avg ?? null, sec.metric),
            formatValue(b?.median ?? null, sec.metric),
            formatValue(b?.stdDev ?? null, sec.metric),
          );
        }
      }
      rows.push(cells.join(","));
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `seelevel-${formatLocalDate(new Date())}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  return (
    <button
      class="seelevel-btn seelevel-btn--icon"
      onClick={download}
      disabled={!ready}
      title="Export all statistics (CSV)"
      aria-label="Export all statistics as CSV"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 3v11" />
        <path d="M7 10l5 5 5-5" />
        <path d="M5 20h14" />
      </svg>
    </button>
  );
}
