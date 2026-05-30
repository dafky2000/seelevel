import { h } from "preact";
import type { ScopeKey } from "../../../types.ts";

const SCOPES: { key: ScopeKey; label: string }[] = [
  { key: "viewport", label: "Viewport" },
  { key: "session", label: "Session" },
  { key: "zone", label: "⬡ Zone" },
];

export function ScopeSelector(
  { scope, onScope }: { scope: ScopeKey; onScope: (s: ScopeKey) => void },
) {
  return (
    <div class="seelevel-row">
      <span class="seelevel-label">Scope</span>
      <div class="seelevel-tabs" style={{ flex: 1 }}>
        {SCOPES.map(({ key, label }) => (
          <button
            key={key}
            class={`seelevel-tab seelevel-tab--${key}${
              scope === key ? " seelevel-tab--active" : ""
            }`}
            onClick={() => onScope(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
