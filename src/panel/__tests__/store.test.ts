import { assertEquals } from "@std/assert";
import { mergeListings, resolveCoordinates } from "../store.ts";
import type { ListingRow, PropertyRow } from "../../types.ts";

function listing(id: string, overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id,
    listing_id: id,
    class_id: 1,
    status_id: 1,
    list_price: null,
    sold_price: null,
    close_dt: null,
    list_dt: null,
    sold_dt: null,
    tla: null,
    pid: null,
    lat: null,
    lng: null,
    ...overrides,
  };
}

Deno.test(
  "resolveCoordinates - ViewPoint: joins lat/lng by pid",
  () => {
    const listings = [listing("L1", { pid: "P1" })];
    const properties: PropertyRow[] = [{ pid: "P1", lat: 44.5, lng: -63.5 }];
    const resolved = resolveCoordinates(listings, properties);
    assertEquals(resolved[0].lat, 44.5);
    assertEquals(resolved[0].lng, -63.5);
  },
);

Deno.test(
  "resolveCoordinates - EV: preserves direct lat/lng when properties is empty",
  () => {
    // EV listings arrive with lat/lng already populated and pid=null. Previously
    // this function unconditionally wiped them, breaking zone filtering.
    const listings = [listing("L1", { lat: 44.65, lng: -63.59 })];
    const resolved = resolveCoordinates(listings, []);
    assertEquals(resolved[0].lat, 44.65);
    assertEquals(resolved[0].lng, -63.59);
  },
);

Deno.test(
  "resolveCoordinates - preserves existing lat/lng when pid not in coordMap",
  () => {
    const listings = [listing("L1", { pid: "P-UNKNOWN", lat: 1, lng: 2 })];
    const properties: PropertyRow[] = [{ pid: "P1", lat: 44.5, lng: -63.5 }];
    const resolved = resolveCoordinates(listings, properties);
    assertEquals(resolved[0].lat, 1);
    assertEquals(resolved[0].lng, 2);
  },
);

Deno.test(
  "mergeListings - later null lat/lng never replaces existing coords",
  () => {
    const existing = [listing("L1", { lat: 44.5, lng: -63.5 })];
    const incoming = [listing("L1", { lat: null, lng: null, list_price: 100 })];
    const merged = mergeListings(existing, incoming);
    assertEquals(merged[0].lat, 44.5);
    assertEquals(merged[0].lng, -63.5);
    assertEquals(merged[0].list_price, 100);
  },
);
