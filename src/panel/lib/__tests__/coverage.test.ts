import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { computeCoverage } from "../coverage.ts";
import type { BBox } from "../../../types.ts";

// Polygon: 1×1 square [0,0]→[0,1]→[1,1]→[1,0]
const POLYGON: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];

// Bbox covering the full polygon
const FULL_BBOX: BBox = { sw_lat: 0, sw_lng: 0, ne_lat: 1, ne_lng: 1 };

// Bbox covering bottom-left half
const HALF_BBOX: BBox = { sw_lat: 0, sw_lng: 0, ne_lat: 0.5, ne_lng: 1 };

// Bbox outside the polygon entirely
const OUTSIDE_BBOX: BBox = { sw_lat: 5, sw_lng: 5, ne_lat: 6, ne_lng: 6 };

Deno.test("computeCoverage - full bbox → ~100%", () => {
  assertAlmostEquals(computeCoverage([FULL_BBOX], POLYGON), 1.0, 0.01);
});

Deno.test("computeCoverage - half bbox → ~50%", () => {
  assertAlmostEquals(computeCoverage([HALF_BBOX], POLYGON), 0.5, 0.05);
});

Deno.test("computeCoverage - bbox outside → 0%", () => {
  assertAlmostEquals(computeCoverage([OUTSIDE_BBOX], POLYGON), 0.0, 0.001);
});

Deno.test("computeCoverage - no bboxes → 0", () => {
  assertEquals(computeCoverage([], POLYGON), 0);
});

Deno.test("computeCoverage - two half bboxes → ~100%", () => {
  const top: BBox = { sw_lat: 0.5, sw_lng: 0, ne_lat: 1, ne_lng: 1 };
  assertAlmostEquals(computeCoverage([HALF_BBOX, top], POLYGON), 1.0, 0.05);
});
