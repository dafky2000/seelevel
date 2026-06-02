import { assertAlmostEquals, assertEquals } from "@std/assert";
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

import { computeZoneCoverage } from "../coverage.ts";
import type { ZoneShape } from "../../../types.ts";

// Two unit squares: [0,1]² and [10,11]². Total area 2 (degree²).
const TWO_PARTS: ZoneShape = [
  { outer: [[0, 0], [0, 1], [1, 1], [1, 0]], holes: [] },
  { outer: [[10, 10], [10, 11], [11, 11], [11, 10]], holes: [] },
];

Deno.test("computeZoneCoverage - one of two parts fully covered → ~50%", () => {
  const coverFirst: BBox = { sw_lat: 0, sw_lng: 0, ne_lat: 1, ne_lng: 1 };
  assertAlmostEquals(computeZoneCoverage([coverFirst], TWO_PARTS), 0.5, 0.02);
});

Deno.test("computeZoneCoverage - both parts covered → ~100%", () => {
  const a: BBox = { sw_lat: 0, sw_lng: 0, ne_lat: 1, ne_lng: 1 };
  const b: BBox = { sw_lat: 10, sw_lng: 10, ne_lat: 11, ne_lng: 11 };
  assertAlmostEquals(computeZoneCoverage([a, b], TWO_PARTS), 1.0, 0.02);
});

Deno.test("computeZoneCoverage - hole is excluded from total area", () => {
  // 2×2 outer (area 4) with a 1×1 hole (area 1) → net area 3, fully covered.
  const holed: ZoneShape = [{
    outer: [[0, 0], [0, 2], [2, 2], [2, 0]],
    holes: [[[0.5, 0.5], [0.5, 1.5], [1.5, 1.5], [1.5, 0.5]]],
  }];
  const full: BBox = { sw_lat: 0, sw_lng: 0, ne_lat: 2, ne_lng: 2 };
  assertAlmostEquals(computeZoneCoverage([full], holed), 1.0, 0.02);
});

Deno.test("computeZoneCoverage - empty shape → 0", () => {
  assertEquals(computeZoneCoverage([], []), 0);
});
