import { h } from "preact";

export function EmptyState({ host }: { host?: string | null }) {
  const isViewPoint = host != null &&
    (host === "viewpoint.ca" || host.endsWith(".viewpoint.ca"));
  const isEV = host === "engelvoelkersnovascotia.com";

  let body: h.JSX.Element;
  if (isViewPoint) {
    body = (
      <>
        Browse <strong>viewpoint.ca/map</strong> to start collecting data.<br />
        Listings appear as you pan and filter. Use ViewPoint's Search tool for
        the best results.
      </>
    );
  } else if (isEV) {
    body = (
      <>
        Browse <strong>engelvoelkersnovascotia.com/map</strong>{" "}
        to start collecting data.<br />
        Listings appear as you pan and filter.
      </>
    );
  } else {
    body = (
      <>
        Open <strong>viewpoint.ca/map</strong> or{" "}
        <strong>engelvoelkersnovascotia.com/map</strong>{" "}
        to start collecting data.<br />
        Listings appear as you pan and filter.
      </>
    );
  }

  return (
    <div class="seelevel-empty">
      <div class="seelevel-empty__icon">🗺️</div>
      <div class="seelevel-empty__text">{body}</div>
    </div>
  );
}
