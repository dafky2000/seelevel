// Pure: convert one Socrata GeoJSON Feature (Polygon or MultiPolygon) of the
// "Municipality Boundaries" dataset to a RegionRecord. No I/O.
import type {
  BBox,
  RegionRecord,
  RegionType,
  ZonePart,
  ZoneShape,
} from "../../src/types.ts";
import { roundCoord, simplifyRing } from "./simplify.ts";

type Pt = [number, number];
// deno-lint-ignore no-explicit-any
type GeoFeature = any;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// GeoJSON ring ([lng,lat], closed) → simplified open [lat,lng] ring. Drops the
// closing duplicate and de-dupes consecutive identical points after rounding.
function ringToLatLng(ring: number[][], tolerance: number): Pt[] {
  let pts: Pt[] = ring.map(([lng, lat]) => roundCoord([lat, lng]));
  if (
    pts.length > 1 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
  ) {
    pts = pts.slice(0, -1);
  }
  const simplified = simplifyRing(pts, tolerance);
  const out: Pt[] = [];
  for (const p of simplified) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

// Normalise Polygon vs MultiPolygon into a list of GeoJSON polygons
// (each polygon = [outerRing, ...holeRings]).
function polygonsOf(geometry: GeoFeature): number[][][][] {
  if (!geometry) return [];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "Polygon") return [geometry.coordinates];
  return [];
}

export function featureToRegion(
  feature: GeoFeature,
  tolerance: number,
): RegionRecord {
  const props = feature.properties ?? {};
  const shape: ZoneShape = [];
  for (const polygon of polygonsOf(feature.geometry)) {
    const outer = ringToLatLng(polygon[0], tolerance);
    if (outer.length < 3) continue; // zero-area part — lossless to drop
    const holes = polygon.slice(1)
      .map((h: number[][]) => ringToLatLng(h, tolerance))
      .filter((h: Pt[]) => h.length >= 3);
    const part: ZonePart = { outer, holes };
    shape.push(part);
  }

  let sw_lat = Infinity,
    sw_lng = Infinity,
    ne_lat = -Infinity,
    ne_lng = -Infinity;
  for (const part of shape) {
    for (const ring of [part.outer, ...part.holes]) {
      for (const [lat, lng] of ring) {
        if (lat < sw_lat) sw_lat = lat;
        if (lat > ne_lat) ne_lat = lat;
        if (lng < sw_lng) sw_lng = lng;
        if (lng > ne_lng) ne_lng = lng;
      }
    }
  }
  // Empty shape (all parts dropped) leaves the sentinels untouched; collapse to
  // a zero bbox so the record never serializes Infinity. The build step filters
  // out shape-less records anyway, so this is belt-and-suspenders.
  const bbox: BBox = shape.length === 0
    ? { sw_lat: 0, sw_lng: 0, ne_lat: 0, ne_lng: 0 }
    : { sw_lat, sw_lng, ne_lat, ne_lng };

  // Socrata's v3 query.geojson keys properties by the lowercase fieldName
  // (name/fullname/featdesc/county). Fall back to PascalCase column names so the
  // transform is robust to either source shape.
  const name = String(props.name ?? props.NAME ?? "");
  const fullName = String(props.fullname ?? props.FullName ?? "");
  const featDesc = String(props.featdesc ?? props.FeatDesc ?? "");
  const county = String(props.county ?? props.County ?? "");
  return {
    id: slugify(fullName || name),
    name,
    fullName,
    type: featDesc as RegionType,
    county,
    bbox,
    shape,
  };
}
