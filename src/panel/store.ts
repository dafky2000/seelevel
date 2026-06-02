import { pointInMultiPolygon } from "./lib/geofence.ts";
import type { ListingRow, PropertyRow, TabStore } from "../types.ts";
export { defaultTabStore } from "../types.ts";

// ViewPoint listings arrive with lat/lng=null and a pid that joins to a paired
// PropertyRow in the same batch. EV listings arrive with lat/lng populated and
// pid=null (no join needed). Only overwrite coords when a join actually
// produces a value — otherwise preserve whatever the parser gave us.
export function resolveCoordinates(
  listings: ListingRow[],
  properties: PropertyRow[],
): ListingRow[] {
  if (properties.length === 0) return listings;
  const coordMap = new Map<
    string,
    { lat: number | null; lng: number | null }
  >();
  for (const p of properties) coordMap.set(p.pid, { lat: p.lat, lng: p.lng });
  return listings.map((l) => {
    if (!l.pid) return l;
    const coords = coordMap.get(l.pid);
    if (!coords) return l;
    return { ...l, lat: coords.lat, lng: coords.lng };
  });
}

// Merge incoming listings into the session: new ids added, existing ids
// refreshed - but never lose coordinates we already resolved (a later response
// may arrive without a paired property record).
export function mergeListings(
  existing: ListingRow[],
  incoming: ListingRow[],
): ListingRow[] {
  const map = new Map(existing.map((l) => [l.id, l]));
  for (const l of incoming) {
    const prev = map.get(l.id);
    map.set(
      l.id,
      prev ? { ...l, lat: l.lat ?? prev.lat, lng: l.lng ?? prev.lng } : l,
    );
  }
  return Array.from(map.values());
}

// zone = session ∩ polygon. viewport = the verbatim search result in search
// mode, otherwise session ∩ the live map bounds.
export function scopedListings(store: TabStore): ListingRow[] {
  const { scope, session, viewportListings, viewportBbox, zone } = store;
  if (scope === "viewport") {
    // Search mode: the result set is already geo-filtered server-side - verbatim.
    if (viewportListings !== null) return viewportListings;
    if (!viewportBbox) return session;
    const b = viewportBbox;
    return session.filter(
      (l) =>
        l.lat !== null && l.lng !== null &&
        l.lat >= b.sw_lat && l.lat <= b.ne_lat &&
        l.lng >= b.sw_lng && l.lng <= b.ne_lng,
    );
  }
  if (scope === "zone") {
    if (!zone) return [];
    return session.filter(
      (l) =>
        l.lat !== null && l.lng !== null &&
        pointInMultiPolygon(l.lat!, l.lng!, zone),
    );
  }
  return session; // session scope - everything accumulated
}
