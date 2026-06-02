import { useState } from "preact/hooks";
import type { AlignmentMode, WindowSize } from "../../types.ts";

const WINDOWS: { key: WindowSize; label: string }[] = [
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "yearly", label: "Yearly" },
];

// Shown when a window size is withheld - phrased as the regulator's rule, not
// ours: the data is published under an anonymity standard, and a finer time
// breakdown of too small a sample would risk resolving individual listings.
const WITHHELD_TOOLTIP =
  "Weekly figures are withheld for this selection - the anonymity standard this " +
  "data is published under requires a larger sample size or wider window.";

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WindowPicker({
  windowSize,
  alignmentMode,
  anchorDayOfWeek,
  anchorDayOfMonth,
  availableSizes,
  onWindowSize,
  onAlignmentMode,
  onAnchorDow,
  onAnchorDom,
}: {
  windowSize: WindowSize;
  alignmentMode: AlignmentMode;
  anchorDayOfWeek: number;
  anchorDayOfMonth: number;
  availableSizes: WindowSize[];
  onWindowSize: (w: WindowSize) => void;
  onAlignmentMode: (m: AlignmentMode) => void;
  onAnchorDow: (d: number) => void;
  onAnchorDom: (d: number) => void;
}) {
  const [showPopover, setShowPopover] = useState(false);

  // Yearly is a single past-year figure - it has no alignment / anchor config.
  const hasConfig = windowSize !== "yearly";

  const calendarLabel = windowSize === "monthly"
    ? `${anchorDayOfMonth}${ordinal(anchorDayOfMonth)}`
    : DOW_NAMES[anchorDayOfWeek];

  return (
    <div style={{ position: "relative" }}>
      <div class="seelevel-window-row">
        <span class="seelevel-label">Window</span>
        <div class="seelevel-window-tabs">
          {WINDOWS.map(({ key, label }) => {
            const disabled = !availableSizes.includes(key);
            return (
              <button
                type="button"
                key={key}
                class={`seelevel-window-tab${
                  windowSize === key ? " seelevel-window-tab--active" : ""
                }${disabled ? " seelevel-window-tab--disabled" : ""}`}
                disabled={disabled}
                title={disabled ? WITHHELD_TOOLTIP : undefined}
                onClick={() => !disabled && onWindowSize(key)}
              >
                {label}
              </button>
            );
          })}
        </div>
        {hasConfig && (
          <div class="seelevel-align-split">
            <button
              type="button"
              class={`seelevel-align-btn${
                alignmentMode === "today" ? " seelevel-align-btn--active" : ""
              }`}
              onClick={() => {
                onAlignmentMode("today");
                setShowPopover(false);
              }}
            >
              Today
            </button>
            <div style={{ width: "1px", background: "var(--color-border)" }} />
            <button
              type="button"
              class={`seelevel-align-btn${
                alignmentMode === "calendar"
                  ? " seelevel-align-btn--active"
                  : ""
              }`}
              onClick={() => {
                onAlignmentMode("calendar");
                setShowPopover((v) => !v);
              }}
            >
              {calendarLabel}
            </button>
          </div>
        )}
      </div>
      {hasConfig && showPopover && alignmentMode === "calendar" && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius)",
            padding: "8px",
            zIndex: 10,
            marginTop: "4px",
          }}
        >
          {windowSize === "monthly"
            ? (
              <div>
                <div class="seelevel-label" style={{ marginBottom: "4px" }}>
                  Day of month
                </div>
                <input
                  type="number"
                  min="1"
                  max="28"
                  value={anchorDayOfMonth}
                  onInput={(e) =>
                    onAnchorDom(
                      parseInt((e.target as HTMLInputElement).value) || 1,
                    )}
                  style={{
                    width: "48px",
                    background: "var(--color-bg)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "4px",
                    color: "var(--color-text)",
                    padding: "2px 4px",
                    fontSize: "11px",
                  }}
                />
              </div>
            )
            : (
              <div>
                <div class="seelevel-label" style={{ marginBottom: "4px" }}>
                  Start of week
                </div>
                <div style={{ display: "flex", gap: "2px" }}>
                  {DOW_NAMES.map((name, i) => (
                    <button
                      type="button"
                      key={i}
                      onClick={() => {
                        onAnchorDow(i);
                        setShowPopover(false);
                      }}
                      style={{
                        fontSize: "8px",
                        padding: "2px 4px",
                        borderRadius: "3px",
                        border: "1px solid var(--color-border)",
                        background: anchorDayOfWeek === i
                          ? "var(--color-accent)"
                          : "transparent",
                        color: anchorDayOfWeek === i
                          ? "#fff"
                          : "var(--color-muted)",
                        cursor: "pointer",
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0];
}
