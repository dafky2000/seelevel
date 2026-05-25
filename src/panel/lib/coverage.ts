import type { BBox } from "../../types.ts";
import { polygonArea } from "./geofence.ts";

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
export function computeCoverage(fetchedBboxes: BBox[], polygon: [number, number][]): number {
  const total = polygonArea(polygon);
  if (total === 0 || fetchedBboxes.length === 0) return 0;
  let covered = 0;
  for (const bbox of fetchedBboxes) {
    const clipped = sutherlandHodgman(polygon, bboxToPolygon(bbox));
    covered += polygonArea(clipped);
  }
  return Math.min(1, covered / total);
}
