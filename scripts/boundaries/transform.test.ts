import { assertEquals } from "@std/assert";
import { featureToRegion, slugify } from "./transform.ts";

// Minimal GeoJSON Feature: a MultiPolygon with two parts; the first has a hole;
// the second is a degenerate sliver that must be dropped after simplification.
// GeoJSON coords are [lng, lat]; rings are closed (first point repeated).
const FEATURE = {
  type: "Feature",
  properties: {
    NAME: "Sample",
    FullName: "Town of Sample",
    FeatDesc: "Town",
    County: "Halifax",
  },
  geometry: {
    type: "MultiPolygon",
    coordinates: [
      [
        // outer ring (2×2 box at lat 0..2, lng 0..2), closed
        [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]],
        // hole
        [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]],
      ],
      // a part that collapses to < 3 distinct points after rounding → dropped
      [[[5, 5], [5, 5], [5.0000001, 5], [5, 5]]],
    ],
  },
};

Deno.test("featureToRegion - maps props and swaps [lng,lat]→[lat,lng]", () => {
  const r = featureToRegion(FEATURE, 0.0001);
  assertEquals(r.id, "town-of-sample");
  assertEquals(r.name, "Sample");
  assertEquals(r.fullName, "Town of Sample");
  assertEquals(r.type, "Town");
  assertEquals(r.county, "Halifax");
  assertEquals(r.shape[0].outer[0], [0, 0]);
});

Deno.test("featureToRegion - preserves the hole on the first part", () => {
  const r = featureToRegion(FEATURE, 0.0001);
  assertEquals(r.shape[0].holes.length, 1);
});

Deno.test("featureToRegion - drops parts that collapse below 3 vertices", () => {
  const r = featureToRegion(FEATURE, 0.0001);
  assertEquals(r.shape.length, 1);
});

Deno.test("featureToRegion - strips the closing duplicate point", () => {
  const r = featureToRegion(FEATURE, 0.0001);
  const outer = r.shape[0].outer;
  assertEquals(outer.length, 4);
});

Deno.test("featureToRegion - bbox spans all retained coords", () => {
  const r = featureToRegion(FEATURE, 0.0001);
  assertEquals(r.bbox, { sw_lat: 0, sw_lng: 0, ne_lat: 2, ne_lng: 2 });
});

Deno.test("slugify - lowercases and dashes non-alphanumerics", () => {
  assertEquals(
    slugify("Halifax Regional Municipality"),
    "halifax-regional-municipality",
  );
  assertEquals(slugify("Clark's Harbour"), "clark-s-harbour");
});

Deno.test("featureToRegion - reads Socrata's lowercase property keys", () => {
  // The v3 query.geojson keys properties by the lowercase fieldName, not the
  // PascalCase column display name. Real data must map correctly.
  const real = {
    type: "Feature",
    properties: {
      objectid: "51",
      featdesc: "Town",
      name: "Clark's Harbour",
      county: "Shelburne",
      fullname: "Town of Clark's Harbour",
    },
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
    },
  };
  const r = featureToRegion(real, 0.0001);
  assertEquals(r.id, "town-of-clark-s-harbour");
  assertEquals(r.name, "Clark's Harbour");
  assertEquals(r.fullName, "Town of Clark's Harbour");
  assertEquals(r.type, "Town");
  assertEquals(r.county, "Shelburne");
});
