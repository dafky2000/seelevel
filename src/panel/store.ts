import { pointInPolygon } from "./lib/geofence.ts";
import type { ListingRow, PropertyRow, ScopeKey, TabStore } from "../types.ts";
export { defaultTabStore } from "../types.ts";

export function resolveCoordinates(
  listings: ListingRow[],
  properties: PropertyRow[],
): ListingRow[] {
  const coordMap = new Map<string, { lat: number | null; lng: number | null }>();
  for (const p of properties) coordMap.set(p.pid, { lat: p.lat, lng: p.lng });
  return listings.map((l) => {
    const coords = l.pid ? (coordMap.get(l.pid) ?? { lat: null, lng: null }) : { lat: null, lng: null };
    return { ...l, lat: coords.lat, lng: coords.lng };
  });
}

// Merge incoming listings into the session: new ids added, existing ids
// refreshed - but never lose coordinates we already resolved (a later response
// may arrive without a paired property record).
export function mergeListings(existing: ListingRow[], incoming: ListingRow[]): ListingRow[] {
  const map = new Map(existing.map((l) => [l.id, l]));
  for (const l of incoming) {
    const prev = map.get(l.id);
    map.set(l.id, prev ? { ...l, lat: l.lat ?? prev.lat, lng: l.lng ?? prev.lng } : l);
  }
  return Array.from(map.values());
}

// zone = session ∩ polygon. viewport = the verbatim search result in search
// mode, otherwise session ∩ the live map bounds.
export function scopedListings(store: TabStore): ListingRow[] {
  const { scope, session, viewportListings, viewportBbox, polygon } = store;
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
    // No zone drawn yet → nothing is "in the zone" (the panel shows a prompt).
    if (!polygon) return [];
    return session.filter(
      (l) => l.lat !== null && l.lng !== null && pointInPolygon(l.lat!, l.lng!, polygon),
    );
  }
  return session; // session scope - everything accumulated
}
