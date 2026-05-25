import { h } from "preact";
import type { ScopeKey } from "../../../types.ts";

const SCOPES: { key: ScopeKey; label: string }[] = [
  { key: "viewport", label: "Viewport" },
  { key: "session", label: "Session" },
  { key: "zone", label: "⬡ Zone" },
];

export function ScopeSelector({ scope, onScope }: { scope: ScopeKey; onScope: (s: ScopeKey) => void }) {
  return (
    <div class="vpa-row">
      <span class="vpa-label">Scope</span>
      <div class="vpa-tabs" style={{ flex: 1 }}>
        {SCOPES.map(({ key, label }) => (
          <button
            key={key}
            class={`vpa-tab vpa-tab--${key}${scope === key ? " vpa-tab--active" : ""}`}
            onClick={() => onScope(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
