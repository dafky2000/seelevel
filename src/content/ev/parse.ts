import type { ListingRow } from "../../types.ts";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

// Map an Engel & Völkers RESO row (slim 10-field projection + the 4 fields the
// server always appends — createdAt, FirstMedia, ListingId, OpenHouse) to the
// canonical SeeLevel ListingRow shape. Pure. Tested.
//
// status_id mapping mirrors ViewPoint's existing constants used by aggregate.ts:
//   1 = Active, 2 = Sold (closed), 6 = Pending (under contract)
//
// sold_dt / close_dt use ModificationTimestamp as a proxy ONLY when
// StandardStatus === "Closed". The EV feed nulls CloseDate even on closed
// rows; ModificationTimestamp is the best available "this row reached its
// terminal state at" signal.
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
  const modTs = typeof raw.ModificationTimestamp === "string"
    ? raw.ModificationTimestamp
    : null;
  return {
    id: String(raw.id ?? ""),
    listing_id: String(raw.ListingId ?? ""),
    class_id: 0,
    status_id,
    list_price: num(raw.ListPrice),
    sold_price: num(raw.ClosedPrice),
    list_dt: str(raw.ListingContractDate),
    sold_dt: isClosed ? modTs : null,
    close_dt: isClosed ? modTs : null,
    tla: num(raw.BuildingAreaTotal),
    pid: null,
    lat: num(raw.Latitude),
    lng: num(raw.Longitude),
  };
}
