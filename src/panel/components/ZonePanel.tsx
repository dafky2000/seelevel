import type { RegionRecord, RegionType } from "../../types.ts";
import { NS_REGIONS } from "../data/regions.ts";

// Optgroup order + headings, grouped by unit type.
const GROUPS: { type: RegionType; label: string }[] = [
  { type: "Regional Municipality", label: "Regional Municipalities" },
  { type: "Municipal County", label: "Counties" },
  { type: "Municipal District", label: "Districts" },
  { type: "Town", label: "Towns" },
];

export function ZonePanel(
  {
    selectedRegionId,
    drawing,
    hasZone,
    onSelectRegion,
    onToggleDraw,
    onReset,
  }: {
    selectedRegionId: string | null;
    drawing: boolean;
    hasZone: boolean;
    onSelectRegion: (region: RegionRecord) => void;
    onToggleDraw: () => void;
    onReset: () => void;
  },
) {
  return (
    <div class="seelevel-zone-panel">
      <div class="seelevel-row">
        <select
          class="seelevel-region-select"
          style={{ flex: 1 }}
          aria-label="Select a Nova Scotia region"
          value={selectedRegionId ?? ""}
          onChange={(e) => {
            const id = (e.currentTarget as HTMLSelectElement).value;
            const region = NS_REGIONS.find((r) => r.id === id);
            if (region) onSelectRegion(region);
          }}
        >
          <option value="" disabled hidden>Select a region…</option>
          {GROUPS.map((g) => (
            <optgroup key={g.type} label={g.label}>
              {NS_REGIONS.filter((r) => r.type === g.type).map((r) => (
                <option key={r.id} value={r.id}>{r.fullName}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {selectedRegionId && (
          <button
            type="button"
            class="seelevel-btn seelevel-btn--ghost"
            aria-label="Re-center the map on the selected region"
            title="Re-center on the selected region"
            onClick={() => {
              const region = NS_REGIONS.find((r) => r.id === selectedRegionId);
              // Re-applying the selected region re-pans (drive_viewport) and
              // re-draws (show_zone) — covers the native <select> not re-firing
              // when the same option is picked after the user has panned away.
              if (region) onSelectRegion(region);
            }}
          >
            ⌖ Re-center
          </button>
        )}
        {(hasZone || drawing) && (
          <button
            type="button"
            class="seelevel-btn seelevel-btn--ghost"
            onClick={onReset}
          >
            Reset zone
          </button>
        )}
      </div>
      <button
        type="button"
        class={`seelevel-btn ${drawing ? "seelevel-btn--active" : ""}`}
        style={{ width: "100%", marginTop: "6px" }}
        onClick={onToggleDraw}
      >
        {drawing ? "✕ Cancel draw" : "⬡ Draw custom zone"}
      </button>
    </div>
  );
}
