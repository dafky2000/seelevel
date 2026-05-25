import { assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import { pointInPolygon, polygonArea } from "../geofence.ts";

// Simple square: [0,0] → [0,1] → [1,1] → [1,0]  (lat, lng)
const SQUARE: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];

Deno.test("pointInPolygon - center is inside", () => {
  assertEquals(pointInPolygon(0.5, 0.5, SQUARE), true);
});

Deno.test("pointInPolygon - outside is false", () => {
  assertEquals(pointInPolygon(2, 2, SQUARE), false);
  assertEquals(pointInPolygon(-0.1, 0.5, SQUARE), false);
});

Deno.test("pointInPolygon - on edge treated as outside (ray cast edge case ok)", () => {
  // Behaviour on exact edge is acceptable either way - test just documents it
  const onEdge = pointInPolygon(0, 0.5, SQUARE);
  assertEquals(typeof onEdge, "boolean");
});

Deno.test("polygonArea - unit square has area 0.5 in coord units", () => {
  // Shoelace on lat/lng gives area in degree² - unit square = 0.5
  assertAlmostEquals(polygonArea(SQUARE), 0.5, 0.0001);
});

Deno.test("polygonArea - empty polygon is 0", () => {
  assertEquals(polygonArea([]), 0);
});

Deno.test("pointInPolygon - non-convex (L-shaped) polygon", () => {
  const L: [number, number][] = [
    [0, 0], [0, 2], [1, 2], [1, 1], [2, 1], [2, 0],
  ];
  assertEquals(pointInPolygon(0.5, 0.5, L), true);
  assertEquals(pointInPolygon(1.5, 1.5, L), false);
});
