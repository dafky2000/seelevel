import { h } from "preact";

export function EmptyState() {
  return (
    <div class="seelevel-empty">
      <div class="seelevel-empty__icon">🗺️</div>
      <div class="seelevel-empty__text">
        Browse <strong>viewpoint.ca/map</strong> to start collecting data.<br />
        Listings appear as you pan and filter. Use ViewPoint Search tool for the
        best results.
      </div>
    </div>
  );
}
