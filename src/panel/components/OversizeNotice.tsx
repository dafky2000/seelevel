export function OversizeNotice(
  { mode, count }: { mode: "block" | "badge"; count: number },
) {
  if (mode === "block") {
    return (
      <div class="seelevel-empty">
        <div class="seelevel-empty__icon">⊘</div>
        <div class="seelevel-empty__text">
          Too many listings in view (<strong>{count.toLocaleString()}</strong>)
          to compute statistics.<br />
          Zoom in or narrow your filter to see analytics.
        </div>
      </div>
    );
  }
  return (
    <span
      class="seelevel-oversize-badge"
      title={`${count.toLocaleString()} listings in view — too many to record`}
    >
      View too large — {count.toLocaleString()} skipped
    </span>
  );
}
