import type {
  BBox,
  ListingRow,
  PropertyRow,
  RawListing,
  RawProperty,
  SearchStatus,
} from "../../types.ts";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function intish(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

export function mapListing(raw: RawListing): ListingRow {
  return {
    id: String(raw.id ?? ""),
    listing_id: String(raw.listing_id ?? ""),
    class_id: intish(raw.class_id) ?? 0,
    status_id: intish(raw.status_id) ?? 0,
    list_price: intish(raw.list_price),
    sold_price: intish(raw.sold_price),
    close_dt: str(raw.close_dt),
    list_dt: str(raw.list_dt),
    sold_dt: str(raw.sold_dt),
    tla: intish(raw.tla),
    pid: str(raw.pid),
    lat: null,
    lng: null,
  };
}

export function mapProperty(raw: RawProperty): PropertyRow {
  return {
    pid: String(raw.pid ?? ""),
    lat: num(raw.lat),
    lng: num(raw.lng),
  };
}

function parseBbox(searchUrl: string): BBox | null {
  try {
    const params = new URLSearchParams(searchUrl.split("?")[1] ?? "");

    // Direct bbox params (boundsinfo format - also used as fallback source)
    const sw_lat = parseFloat(params.get("sw_lat") ?? "");
    const sw_lng = parseFloat(params.get("sw_lng") ?? "");
    const ne_lat = parseFloat(params.get("ne_lat") ?? "");
    const ne_lng = parseFloat(params.get("ne_lng") ?? "");
    if (!isNaN(sw_lat) && !isNaN(sw_lng) && !isNaN(ne_lat) && !isNaN(ne_lng)) {
      return { sw_lat, sw_lng, ne_lat, ne_lng };
    }

    // Listing search format: parameters[search_area] = "ctrLat, ctrLng, zoom, sw_lat, sw_lng, ne_lat, ne_lng"
    const area = params.get("parameters[search_area]");
    if (!area) return null;
    const parts = area.split(",").map((s) => parseFloat(s.trim()));
    if (parts.length < 7 || parts.some(isNaN)) return null;
    return {
      sw_lat: parts[3],
      sw_lng: parts[4],
      ne_lat: parts[5],
      ne_lng: parts[6],
    };
  } catch {
    return null;
  }
}

function parseStatus(searchUrl: string): SearchStatus {
  try {
    const params = new URLSearchParams(searchUrl.split("?")[1] ?? "");
    const s = params.get("parameters[status]") ?? params.get("status");
    // ViewPoint labels a for-sale search "forsale"; normalise it to "active".
    if (s === "sold") return "sold";
    if (s === "forsale" || s === "active") return "active";
    return "any";
  } catch {
    return "any";
  }
}

export interface ParsedResponse {
  listings: ListingRow[];
  properties: PropertyRow[];
  bbox: BBox | null; // null for endpoints that carry no geographic params (newtoday, top_listings, map/va)
  status: SearchStatus;
}

// ViewPoint mirrors its NEW TODAY dataset into localStorage["vp.new_today"]
// with the same { listings, properties } shape as the XHR responses - that mode
// is never delivered as an interceptable request, so we read the cache directly.
export function parseViewpointCache(
  raw: string,
): { listings: ListingRow[]; properties: PropertyRow[] } | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawListings = Array.isArray(data.listings) ? data.listings : [];
  const rawProps = Array.isArray(data.properties) ? data.properties : [];
  if (rawListings.length === 0 && rawProps.length === 0) return null;
  return {
    listings: rawListings.map((l) => mapListing(l as RawListing)),
    properties: rawProps.map((p) => mapProperty(p as RawProperty)),
  };
}

export function parseInterceptedResponse(
  body: string,
  searchUrl: string,
): ParsedResponse | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed.status !== "success") return null;

  const rawListings = Array.isArray(parsed.listings) ? parsed.listings : [];
  const rawProps = Array.isArray(parsed.properties) ? parsed.properties : [];

  // No listings in response - skip (e.g. boundsinfo metadata-only response)
  if (rawListings.length === 0 && rawProps.length === 0) return null;

  // Coverage bbox - only a geo-scoped listing/search URL carries a search_area.
  // Global datasets (top_listings, newtoday) have none → null → they never
  // count toward zone coverage. No viewport fallback: coverage must reflect
  // only areas an actual successful search returned a complete result for.
  const bbox = parseBbox(searchUrl);

  return {
    listings: rawListings.map((l) => mapListing(l as RawListing)),
    properties: rawProps.map((p) => mapProperty(p as RawProperty)),
    bbox,
    status: parseStatus(searchUrl),
  };
}
