import type { ListingRow } from "../../types.ts";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Keep the calendar-date portion (YYYY-MM-DD) of a date or ISO timestamp. EV
// dates arrive as UTC-midnight ISO strings; taking the date portion lets them
// bucket by local calendar day exactly like ViewPoint's date-only fields,
// instead of drifting a day under timezone conversion.
function dateOnly(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

// Map an Engel & Völkers RESO row (slim projection + the 4 fields the server
// always appends — createdAt, FirstMedia, ListingId, OpenHouse) to the
// canonical SeeLevel ListingRow shape. Pure. Tested.
//
// status_id mapping mirrors ViewPoint's existing constants used by aggregate.ts:
//   1 = Active, 2 = Sold (closed), 6 = Pending (under contract)
//
// sold_dt / close_dt use CloseDate — the actual closing date — to match the
// semantics of ViewPoint's sold_dt, so the shared aggregate counts both feeds
// identically. A "Closed" row whose CloseDate is in the future is a
// pending/scheduled closing; carrying the real (future) date means it falls
// outside completed (past) windows on its own, the same way ViewPoint's
// pending listings never reach the sold series.
//
// lat / lng arrive on the row directly — no pid → coordinate join needed.
export function parseEvListing(raw: Record<string, unknown>): ListingRow {
  const isClosed = raw.StandardStatus === "Closed";
  const status_id = (() => {
    if (raw.MlsStatus === "ACTIVE") return 1;
    if (raw.MlsStatus === "SOLD" && isClosed) return 2;
    if (raw.MlsStatus === "SOLD") return 6;
    return 0;
  })();
  const closeDate = isClosed ? dateOnly(raw.CloseDate) : null;
  return {
    id: String(raw.id ?? ""),
    listing_id: String(raw.ListingId ?? ""),
    class_id: 0,
    status_id,
    list_price: num(raw.ListPrice),
    // EV leaves ClosedPrice null on most closed rows; the same transacted price
    // is carried in PurchasePrice (identical where both exist), so fall back to
    // it - otherwise ~⅔ of sold listings would have no price to chart.
    sold_price: num(raw.ClosedPrice) ?? num(raw.PurchasePrice),
    list_dt: dateOnly(raw.ListingContractDate),
    sold_dt: closeDate,
    close_dt: closeDate,
    tla: num(raw.BuildingAreaTotal),
    pid: null,
    lat: num(raw.Latitude),
    lng: num(raw.Longitude),
  };
}
