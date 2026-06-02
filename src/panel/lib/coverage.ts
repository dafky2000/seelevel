import type { BBox } from "../../types.ts";
import type { ZoneShape } from "../../types.ts";
import { pointInMultiPolygon, polygonArea } from "./geofence.ts";

type Pt = [number, number]; // [lat, lng]

// Sutherland-Hodgman - clips `polygon` to the convex `clipPolygon`
function sutherlandHodgman(polygon: Pt[], clipPolygon: Pt[]): Pt[] {
  let output = [...polygon];
  if (output.length === 0) return [];
  const n = clipPolygon.length;
  for (let i = 0; i < n; i++) {
    if (output.length === 0) return [];
    const input = output;
    output = [];
    const edgeStart = clipPolygon[i];
    const edgeEnd = clipPolygon[(i + 1) % n];
    for (let j = 0; j < input.length; j++) {
      const curr = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const currInside = isInside(curr, edgeStart, edgeEnd);
      const prevInside = isInside(prev, edgeStart, edgeEnd);
      if (currInside) {
        if (!prevInside) output.push(intersect(prev, curr, edgeStart, edgeEnd));
        output.push(curr);
      } else if (prevInside) {
        output.push(intersect(prev, curr, edgeStart, edgeEnd));
      }
    }
  }
  return output;
}

function isInside(p: Pt, a: Pt, b: Pt): boolean {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
}

function intersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt {
  const A1 = b[1] - a[1], B1 = a[0] - b[0], C1 = A1 * a[0] + B1 * a[1];
  const A2 = d[1] - c[1], B2 = c[0] - d[0], C2 = A2 * c[0] + B2 * c[1];
  const det = A1 * B2 - A2 * B1;
  if (Math.abs(det) < 1e-10) return a;
  return [(B2 * C1 - B1 * C2) / det, (A1 * C2 - A2 * C1) / det];
}

function bboxToPolygon(bbox: BBox): Pt[] {
  return [
    [bbox.sw_lat, bbox.sw_lng],
    [bbox.ne_lat, bbox.sw_lng],
    [bbox.ne_lat, bbox.ne_lng],
    [bbox.sw_lat, bbox.ne_lng],
  ];
}

// Returns fraction [0-1] of polygon area covered by the union of fetched bboxes.
// Approximation: sums clipped areas without deduplicating bbox overlaps.
// Good enough for Nova Scotia zoom levels where quadtree bboxes rarely overlap.
export function computeCoverage(
  fetchedBboxes: BBox[],
  polygon: [number, number][],
): number {
  const total = polygonArea(polygon);
  if (total === 0 || fetchedBboxes.length === 0) return 0;
  let covered = 0;
  for (const bbox of fetchedBboxes) {
    const clipped = sutherlandHodgman(polygon, bboxToPolygon(bbox));
    covered += polygonArea(clipped);
  }
  return Math.min(1, covered / total);
}

// Coverage of a multipolygon zone: net area = Σ(outer − holes) across parts;
// covered area uses computeCoverage() per ring scaled by that ring's area.
export function computeZoneCoverage(
  fetchedBboxes: BBox[],
  shape: ZoneShape,
): number {
  let total = 0;
  let covered = 0;
  for (const part of shape) {
    const outerArea = polygonArea(part.outer);
    let netArea = outerArea;
    let netCovered = computeCoverage(fetchedBboxes, part.outer) * outerArea;
    for (const hole of part.holes) {
      const holeArea = polygonArea(hole);
      netArea -= holeArea;
      netCovered -= computeCoverage(fetchedBboxes, hole) * holeArea;
    }
    total += netArea;
    covered += Math.max(0, netCovered);
  }
  if (total <= 0) return 0;
  return Math.min(1, covered / total);
}

// Grid cell used when crediting coverage from stored listing positions, in
// degrees. ~0.02° latitude ≈ 2.2 km - roughly a neighbourhood. Each cell that
// holds at least one stored listing is treated as fetched, so listings we
// already have count toward coverage without crediting the empty gaps between
// them. Tunable: larger overstates coverage, smaller understates it.
const RESEED_CELL_DEG = 0.02;

// Rebuild the fetched-bbox list when the active zone changes. The raw fetch
// bboxes are tied to where the map was when each batch arrived, so switching to
// a different zone (or one populated from a bbox-less source like NEW TODAY)
// leaves coverage reading 0% even when the zone is full of listings we already
// hold. Reseed from what we know: the current map view (if any) plus a grid
// cell around every session listing inside the new zone - including ones now
// off-screen. As the user pans, fresh fetch bboxes append on top of this seed.
export function reseedCoverage(
  listings: { lat: number | null; lng: number | null }[],
  zone: ZoneShape,
  viewportBbox: BBox | null,
): BBox[] {
  const out: BBox[] = [];
  if (viewportBbox) out.push(viewportBbox);
  const seen = new Set<string>();
  for (const l of listings) {
    if (l.lat === null || l.lng === null) continue;
    if (!pointInMultiPolygon(l.lat, l.lng, zone)) continue;
    const gy = Math.floor(l.lat / RESEED_CELL_DEG);
    const gx = Math.floor(l.lng / RESEED_CELL_DEG);
    const key = `${gy}:${gx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sw_lat: gy * RESEED_CELL_DEG,
      sw_lng: gx * RESEED_CELL_DEG,
      ne_lat: (gy + 1) * RESEED_CELL_DEG,
      ne_lng: (gx + 1) * RESEED_CELL_DEG,
    });
  }
  return out;
}

// Cheap fingerprint of a zone shape, used to detect a genuine zone change vs the
// relay's harmless re-sends of the same zone on every listings tick. Stable
// against minor coordinate rounding (counts + first vertex at ~1 km precision),
// so re-sends don't wipe accumulated fetch bboxes, while a region switch or a
// custom redraw does. Returns "" for no zone.
export function zoneSignature(shape: ZoneShape | null): string {
  if (!shape || shape.length === 0) return "";
  const outer = shape[0].outer;
  const p = outer[0];
  const coord = p ? `${p[0].toFixed(2)},${p[1].toFixed(2)}` : "";
  return `${shape.length}:${outer.length}:${coord}`;
}
