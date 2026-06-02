import { h } from "preact";

export function EulaGate({ onAcknowledge }: { onAcknowledge: () => void }) {
  return (
    <div
      style={{
        padding: "24px 18px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      <strong style={{ fontSize: "14px" }}>
        See<span style={{ color: "var(--color-accent)" }}>Level</span>
      </strong>
      <p
        style={{
          fontSize: "11px",
          color: "var(--color-muted)",
          lineHeight: 1.6,
        }}
      >
        Personal, non-commercial use only. Commercial or professional users must
        contact ViewPoint.ca or Engel & Völkers directly before use.
      </p>
      <p
        style={{
          fontSize: "10px",
          color: "var(--color-muted)",
          lineHeight: 1.6,
        }}
      >
        Data: NSAR MLS® via ViewPoint.ca and engelvoelkersnovascotia.com. On
        ViewPoint, SeeLevel observes data your browser already receives. On
        Engel & Völkers, SeeLevel issues one small filtered request per map move
        to provide complete viewport coverage, using your existing session.
        Nothing is stored, transmitted off-device, or redistributed.
      </p>
      <button
        class="seelevel-btn seelevel-btn--primary"
        style={{
          fontSize: "11px",
          padding: "8px 0",
          borderRadius: "6px",
          fontWeight: 700,
        }}
        onClick={onAcknowledge}
      >
        I understand — continue
      </button>
    </div>
  );
}
