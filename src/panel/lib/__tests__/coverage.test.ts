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

import { reseedCoverage, zoneSignature } from "../coverage.ts";

// A ~0.1° square zone near a grid line, big enough to hold several 0.02° cells.
const RESEED_ZONE: ZoneShape = [
  {
    outer: [[44.0, -63.0], [44.0, -62.9], [44.1, -62.9], [44.1, -63.0]],
    holes: [],
  },
];

Deno.test("reseedCoverage - no view, no in-zone listings → empty", () => {
  const outside = [{ lat: 40, lng: -70 }];
  assertEquals(reseedCoverage(outside, RESEED_ZONE, null), []);
});

Deno.test("reseedCoverage - current view bbox is seeded first", () => {
  const view: BBox = {
    sw_lat: 44.0,
    sw_lng: -63.0,
    ne_lat: 44.1,
    ne_lng: -62.9,
  };
  const seeded = reseedCoverage([], RESEED_ZONE, view);
  assertEquals(seeded[0], view);
});

Deno.test("reseedCoverage - in-zone listings each yield a covering cell", () => {
  // Three listings in three distinct 0.02° cells inside the zone.
  const listings = [
    { lat: 44.01, lng: -62.99 },
    { lat: 44.05, lng: -62.95 },
    { lat: 44.08, lng: -62.92 },
  ];
  const seeded = reseedCoverage(listings, RESEED_ZONE, null);
  assertEquals(seeded.length, 3);
  // Each cell, intersected with the zone, contributes positive coverage.
  assertEquals(computeZoneCoverage(seeded, RESEED_ZONE) > 0, true);
});

Deno.test("reseedCoverage - listings in the same cell collapse to one bbox", () => {
  const listings = [
    { lat: 44.011, lng: -62.991 },
    { lat: 44.012, lng: -62.992 }, // same 0.02° cell as above
  ];
  assertEquals(reseedCoverage(listings, RESEED_ZONE, null).length, 1);
});

Deno.test("reseedCoverage - null coordinates are skipped", () => {
  const listings = [{ lat: null, lng: null }, { lat: 44.05, lng: -62.95 }];
  assertEquals(reseedCoverage(listings, RESEED_ZONE, null).length, 1);
});

Deno.test("zoneSignature - null/empty → empty string", () => {
  assertEquals(zoneSignature(null), "");
  assertEquals(zoneSignature([]), "");
});

Deno.test("zoneSignature - stable across ~1km coordinate rounding", () => {
  const a: ZoneShape = [{
    outer: [[44.001, -63.001], [44.0, -62.9], [44.1, -62.9]],
    holes: [],
  }];
  const b: ZoneShape = [{
    outer: [[44.004, -63.004], [44.0, -62.9], [44.1, -62.9]],
    holes: [],
  }];
  assertEquals(zoneSignature(a), zoneSignature(b));
});

Deno.test("zoneSignature - differs for distinct zones", () => {
  const halifax: ZoneShape = [{
    outer: [[44.6, -63.6], [44.6, -63.5], [44.7, -63.5]],
    holes: [],
  }];
  const sydney: ZoneShape = [{
    outer: [[46.1, -60.2], [46.1, -60.1], [46.2, -60.1]],
    holes: [],
  }];
  assertEquals(zoneSignature(halifax) !== zoneSignature(sydney), true);
});
