import { h } from "preact";

export function ZoneCoverage(
  { coverage, count }: { coverage: number; count: number },
) {
  const pct = Math.round(coverage * 100);
  return (
    <div class="seelevel-coverage" style={{ marginTop: "7px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: "9px",
            color: "var(--color-green)",
            fontWeight: 700,
          }}
        >
          Zone coverage
        </span>
        <span
          style={{
            fontSize: "12px",
            fontWeight: 800,
            color: "var(--color-green)",
          }}
        >
          {pct}%
        </span>
      </div>
      <div class="seelevel-coverage__track">
        <div class="seelevel-coverage__fill" style={{ width: `${pct}%` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: "8px", color: "oklch(40% 0.08 160)" }}>
          {count} listings in zone
        </span>
        {pct < 90 && (
          <span
            style={{
              fontSize: "8px",
              color: "oklch(35% 0.06 160)",
              fontStyle: "italic",
            }}
          >
            Pan to fill gaps
          </span>
        )}
      </div>
    </div>
  );
}
