// MAIN-world. Fires one slim get-listing per observed page-fired get-ev-listing.
// Dedup + at-most-one-in-flight + filter-change detection are all module-scoped.
//
// Dispatches three CustomEvents on document (detail shapes documented inline):
//   - seelevel:listings    { listings, bbox, kind, status }
//   - seelevel:oversize    { bbox, count }
//   - seelevel:clear-session  (no detail)
// Plus loading_state events bracketing each fetch:
//   - seelevel:loading-state { loading: true }   before fetch
//   - seelevel:loading-state { loading: false }  in finally

import { EVT } from "../../types.ts";
import type { BBox, ListingRow, SearchStatus } from "../../types.ts";
import { parseEvListing } from "./parse.ts";

const API_URL =
  "https://dev-api.engelvoelkersnovascotia.com/api/v1/property/get-listing";
const THRESHOLD = 2000;
// ClosedPrice is null on most closed rows; PurchasePrice carries the same
// transacted price and fills the gap. CloseDate is the actual closing date used
// as sold_dt (see parseEvListing). ModificationTimestamp is unused by the parser
// but MUST stay in the projection: the server sorts by it, and a sortBy column
// absent from `fields` makes the query 500 ("column ... does not exist").
const SLIM_FIELDS =
  "id,MlsStatus,StandardStatus,ListPrice,ClosedPrice,PurchasePrice,ListingContractDate,CloseDate,ModificationTimestamp,BuildingAreaTotal,Latitude,Longitude";

let lastFiredKey: string | null = null;
let lastFilterKey: string | null = null;
let inFlight = false;

interface EvFilters {
  boundingBox?: { top: number; right: number; bottom: number; left: number };
  MlsStatus?: string[];
  [key: string]: unknown;
}

function deriveStatus(filters: EvFilters): SearchStatus {
  const s = filters.MlsStatus;
  if (!Array.isArray(s) || s.length === 0) return "any";
  if (s.length === 1 && s[0] === "ACTIVE") return "active";
  if (s.length === 1 && s[0] === "SOLD") return "sold";
  return "any";
}

function bboxFromFilters(filters: EvFilters): BBox | null {
  const b = filters.boundingBox;
  if (!b) return null;
  return { sw_lat: b.bottom, sw_lng: b.left, ne_lat: b.top, ne_lng: b.right };
}

// Called by ev/main.ts for every observed get-ev-listing POST. The argument is
// the parsed request body (not a string). We never re-parse JSON here.
export function fireIfNeeded(
  observedBody: { filters?: EvFilters } | null,
): void {
  if (!observedBody || !observedBody.filters) return;
  const filters = observedBody.filters;
  const bbox = bboxFromFilters(filters);
  if (!bbox) return; // page hasn't settled on a viewport yet

  // Detect filter change (everything in filters except boundingBox) → clear session.
  const { boundingBox: _b, ...filtersSansBbox } = filters;
  const filterKey = JSON.stringify(filtersSansBbox);
  if (lastFilterKey !== null && lastFilterKey !== filterKey) {
    document.dispatchEvent(new CustomEvent(EVT.clearSession));
  }
  lastFilterKey = filterKey;

  // Dedup against the most recently fired (bbox, filters) pair.
  const firedKey = JSON.stringify({
    bbox: filters.boundingBox,
    filters: filtersSansBbox,
  });
  if (firedKey === lastFiredKey) return;

  // At-most-one-in-flight; next page-fired trigger retriggers.
  if (inFlight) return;

  lastFiredKey = firedKey;
  inFlight = true;
  document.dispatchEvent(
    new CustomEvent(EVT.loadingState, { detail: { loading: true } }),
  );

  void fireSlim(filters, bbox);
}

async function fireSlim(filters: EvFilters, bbox: BBox): Promise<void> {
  try {
    const token = localStorage.getItem("authToken");
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const body = {
      limit: 2001,
      skip: 0,
      sortBy: "ModificationTimestamp",
      sortOrder: "desc",
      fields: SLIM_FIELDS,
      filters, // verbatim copy — includes boundingBox + MlsStatus + anything else
    };

    const r = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      // 401 (token expired), 4xx, 5xx — silently swallow per spec.
      if (r.status === 400) {
        try {
          console.warn(
            "[seelevel] EV sibling 400:",
            (await r.text()).slice(0, 200),
          );
        } catch { /* logging only - never block */ }
      }
      return;
    }
    const json = await r.json() as {
      data?: {
        mlsPropertyResult?: {
          count?: number;
          rows?: Record<string, unknown>[];
        };
      };
    };
    const result = json?.data?.mlsPropertyResult;
    if (!result || typeof result.count !== "number") {
      try {
        console.warn("[seelevel] EV sibling: malformed response");
      } catch { /* logging only - never block */ }
      return;
    }

    if (result.count > THRESHOLD) {
      document.dispatchEvent(
        new CustomEvent(EVT.oversize, {
          detail: { bbox, count: result.count },
        }),
      );
      return;
    }

    const rows = Array.isArray(result.rows) ? result.rows : [];
    const listings: ListingRow[] = rows.map(parseEvListing);
    document.dispatchEvent(
      new CustomEvent(EVT.listings, {
        detail: {
          listings,
          bbox,
          kind: "search" as const,
          status: deriveStatus(filters),
        },
      }),
    );
  } catch {
    // Network error / abort / aborted JSON — silent. Next pan retriggers.
  } finally {
    inFlight = false;
    document.dispatchEvent(
      new CustomEvent(EVT.loadingState, { detail: { loading: false } }),
    );
  }
}
