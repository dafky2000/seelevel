# NS region zones + Zone-tab redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Nova Scotia municipal boundaries inside the extension so a user
can pick a region from a grouped dropdown in the Zone tab (pan + auto-draw the
boundary), move all zone controls off the map into the panel, and represent
every zone as a full multipolygon.

**Architecture:** A build-time pipeline fetches the Socrata "Municipality
Boundaries" GeoJSON (auth via `.env`), simplifies it (Ramer–Douglas–Peucker),
and writes a committed `src/panel/data/ns-municipalities.json` bundled into the
panel. A unified `ZoneShape` (array of parts, each with an outer ring + holes)
replaces the single-ring zone across the geofence filter, coverage, overlay,
store, relays, and panel. The Zone tab gains a region picker + "Draw custom
zone" + "Reset zone"; the persistent map buttons are removed; custom drawing
keeps a cursor-follow dot and an on-map hint banner. The existing dev-only
`drive_viewport` map-pan plumbing is promoted to production for the region pan.

**Tech Stack:** Deno + esbuild + Preact, Leaflet + Geoman overlay, uPlot
(unaffected), `jsr:@std/assert@1` tests, Socrata SODA v3 GeoJSON API.

---

## Conventions used throughout

- All coordinates are `[lat, lng]` degree pairs (the project's existing
  convention). GeoJSON is `[lng, lat]` — the transform swaps it.
- `deno fmt` is the project formatter (NOT biome here). Run `deno fmt` before
  every commit step.
- Run a single test file with: `deno test -A path/to/file.test.ts`. Full suite:
  `deno test -A src/`.
- Type-check the whole project with: `deno check src/ scripts/`.
- Commit messages end with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- New shared types (`ZonePart`, `ZoneShape`, `RegionRecord`) live in
  `src/types.ts` so both the build scripts and the panel import them.

---

## File structure

**New files**

- `scripts/boundaries/simplify.ts` — pure RDP ring simplification.
- `scripts/boundaries/simplify.test.ts`
- `scripts/boundaries/transform.ts` — pure GeoJSON-feature → `RegionRecord`.
- `scripts/boundaries/transform.test.ts`
- `scripts/boundaries/build-boundaries.ts` — I/O: fetch + transform + write JSON
  (build time only).
- `src/panel/data/ns-municipalities.json` — generated, committed.
- `src/panel/data/regions.ts` — typed wrapper around the JSON.
- `src/panel/components/ZonePanel.tsx` — Zone-tab controls.

**Modified files**

- `src/types.ts` — `ZonePart`/`ZoneShape`/`RegionRecord`; `TabStore.zone` (was
  `polygon`), `.selectedRegionId`, `.drawing`; message changes.
- `src/panel/lib/geofence.ts` — add `pointInMultiPolygon`.
- `src/panel/lib/coverage.ts` — add `computeZoneCoverage`.
- `src/panel/store.ts` — `scopedListings` zone branch uses
  `pointInMultiPolygon`.
- `src/content/geofence-overlay.ts` — shape API; draw affordances; remove
  buttons/prompt.
- `src/content/relay.ts`, `src/content/ev/relay.ts` — wire new messages.
- `src/content/shared/google-maps-hook.ts` — un-gate the `DRIVE_EVENT` listener.
- `src/panel/App.tsx` — zone payload as shape; `draw_state`; region select;
  remove `zone_prompt` effect; `computeZoneCoverage`; render `ZonePanel`.
- `src/panel/lib/parity.ts` — unchanged signature; `buildSnapshot` (in App)
  derives `polygon` from the zone.
- `build.ts` — `--refresh-boundaries` flag + conditional generation.
- `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `manifest.json` — docs + version
  bump.

---

## Task 1: RDP ring simplification (pure)

**Files:**

- Create: `scripts/boundaries/simplify.ts`
- Test: `scripts/boundaries/simplify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/boundaries/simplify.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { roundCoord, simplifyRing } from "./simplify.ts";

type Pt = [number, number];

Deno.test("simplifyRing - collinear interior points are removed", () => {
  const ring: Pt[] = [[0, 0], [0, 1], [0, 2], [0, 3]];
  // A straight line keeps only its endpoints.
  assertEquals(simplifyRing(ring, 0.0001), [[0, 0], [0, 3]]);
});

Deno.test("simplifyRing - endpoints are always preserved", () => {
  const ring: Pt[] = [[0, 0], [0.00001, 0.5], [0, 1]];
  const out = simplifyRing(ring, 0.001);
  assertEquals(out[0], [0, 0]);
  assertEquals(out[out.length - 1], [0, 1]);
});

Deno.test("simplifyRing - a real bend survives a small tolerance", () => {
  const ring: Pt[] = [[0, 0], [1, 1], [0, 2]];
  // The apex is 1 unit off the [0,0]→[0,2] chord; tolerance 0.5 keeps it.
  assertEquals(simplifyRing(ring, 0.5), [[0, 0], [1, 1], [0, 2]]);
});

Deno.test("simplifyRing - larger tolerance never yields more points", () => {
  const ring: Pt[] = [[0, 0], [0.4, 1], [0, 2], [-0.4, 3], [0, 4]];
  const fine = simplifyRing(ring, 0.1);
  const coarse = simplifyRing(ring, 0.5);
  assertEquals(coarse.length <= fine.length, true);
});

Deno.test("simplifyRing - degenerate (<=2 points) returned as-is", () => {
  assertEquals(simplifyRing([[0, 0], [1, 1]], 0.1), [[0, 0], [1, 1]]);
  assertEquals(simplifyRing([[0, 0]], 0.1), [[0, 0]]);
});

Deno.test("roundCoord - rounds to 5 decimals", () => {
  assertEquals(roundCoord([44.123456789, -63.987654321]), [
    44.12346,
    -63.98765,
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test -A scripts/boundaries/simplify.test.ts` Expected: FAIL —
`Module not found "./simplify.ts"`.

- [ ] **Step 3: Write the implementation**

```ts
// scripts/boundaries/simplify.ts
// Pure Ramer–Douglas–Peucker simplification for a single ring of [lat, lng]
// points. Planar distance in degrees is fine at municipal scale. No I/O.

type Pt = [number, number];

// Perpendicular distance from p to the line through a→b (planar, in degrees).
function perpDistance(p: Pt, a: Pt, b: Pt): number {
  const dy = b[0] - a[0];
  const dx = b[1] - a[1];
  const denom = Math.hypot(dy, dx);
  if (denom === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  // |cross product| / |a→b|
  const cross = Math.abs(dx * (p[0] - a[0]) - dy * (p[1] - a[1]));
  return cross / denom;
}

// Classic recursive RDP. Endpoints are always kept.
export function simplifyRing(ring: Pt[], tolerance: number): Pt[] {
  if (ring.length <= 2) return ring;
  let maxDist = 0;
  let idx = 0;
  const end = ring.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDistance(ring[i], ring[0], ring[end]);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist <= tolerance) return [ring[0], ring[end]];
  const left = simplifyRing(ring.slice(0, idx + 1), tolerance);
  const right = simplifyRing(ring.slice(idx), tolerance);
  // Drop the duplicated join point (last of left == first of right).
  return left.slice(0, -1).concat(right);
}

export function roundCoord([lat, lng]: Pt): Pt {
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return [r(lat), r(lng)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test -A scripts/boundaries/simplify.test.ts` Expected: PASS (6
tests).

- [ ] **Step 5: Format and commit**

```bash
deno fmt scripts/boundaries/
git add scripts/boundaries/simplify.ts scripts/boundaries/simplify.test.ts
git commit -m "$(cat <<'EOF'
Add pure RDP ring simplification for boundary build

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared types — `ZonePart`, `ZoneShape`, `RegionRecord` (additive)

This step is purely additive (no renames yet), so the project keeps compiling.

**Files:**

- Modify: `src/types.ts`

- [ ] **Step 1: Add the geometry + region types**

Insert after the `BBox` interface (after line 17 in `src/types.ts`):

```ts
// A zone is a multipolygon: one or more disjoint parts, each an outer ring with
// zero or more holes. A hand-drawn zone is exactly one part with no holes; a
// predefined region may have many parts (islands) and holes. All coords [lat,lng].
export interface ZonePart {
  outer: [number, number][];
  holes: [number, number][][];
}
export type ZoneShape = ZonePart[];

// One selectable Nova Scotia municipal boundary, generated at build time into
// src/panel/data/ns-municipalities.json and bundled into the panel.
export type RegionType =
  | "Regional Municipality"
  | "Municipal County"
  | "Municipal District"
  | "Town";

export interface RegionRecord {
  id: string; // stable slug, e.g. "halifax-regional-municipality"
  name: string; // NAME
  fullName: string; // FullName
  type: RegionType; // FeatDesc
  county: string; // County label
  bbox: BBox; // for the map pan
  shape: ZoneShape; // simplified multipolygon
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `deno check src/` Expected: PASS (no usages yet).

- [ ] **Step 3: Commit**

```bash
deno fmt src/types.ts
git add src/types.ts
git commit -m "$(cat <<'EOF'
Add ZoneShape and RegionRecord shared types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `pointInMultiPolygon` (geofence, additive)

**Files:**

- Modify: `src/panel/lib/geofence.ts`
- Test: `src/panel/lib/__tests__/geofence.test.ts` (append only — do not edit
  existing tests)

- [ ] **Step 1: Append the failing tests**

Append to `src/panel/lib/__tests__/geofence.test.ts`:

```ts
import { pointInMultiPolygon } from "../geofence.ts";
import type { ZoneShape } from "../../../types.ts";

// Two disjoint squares (mainland + island) with one hole in the mainland.
const MULTI: ZoneShape = [
  {
    outer: [[0, 0], [0, 2], [2, 2], [2, 0]],
    holes: [[[0.5, 0.5], [0.5, 1.5], [1.5, 1.5], [1.5, 0.5]]],
  },
  { outer: [[10, 10], [10, 11], [11, 11], [11, 10]], holes: [] },
];

Deno.test("pointInMultiPolygon - inside the mainland part", () => {
  assertEquals(pointInMultiPolygon(0.2, 0.2, MULTI), true);
});

Deno.test("pointInMultiPolygon - inside the hole is excluded", () => {
  assertEquals(pointInMultiPolygon(1.0, 1.0, MULTI), false);
});

Deno.test("pointInMultiPolygon - inside a secondary part (island)", () => {
  assertEquals(pointInMultiPolygon(10.5, 10.5, MULTI), true);
});

Deno.test("pointInMultiPolygon - outside all parts", () => {
  assertEquals(pointInMultiPolygon(5, 5, MULTI), false);
});

Deno.test("pointInMultiPolygon - empty shape is always false", () => {
  assertEquals(pointInMultiPolygon(0.2, 0.2, []), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test -A src/panel/lib/__tests__/geofence.test.ts` Expected: FAIL —
`pointInMultiPolygon` is not exported.

- [ ] **Step 3: Implement**

Append to `src/panel/lib/geofence.ts`:

```ts
import type { ZoneShape } from "../../types.ts";

// A point is in the multipolygon if it lies inside some part's outer ring and
// inside none of that part's holes.
export function pointInMultiPolygon(
  lat: number,
  lng: number,
  shape: ZoneShape,
): boolean {
  for (const part of shape) {
    if (!pointInPolygon(lat, lng, part.outer)) continue;
    if (part.holes.some((h) => pointInPolygon(lat, lng, h))) continue;
    return true;
  }
  return false;
}
```

> Note: move the new `import type` line to the top of the file with the other
> imports if `deno fmt` relocates it — either position type-checks; keep the
> file `deno fmt`-clean.

- [ ] **Step 4: Run to verify it passes**

Run: `deno test -A src/panel/lib/__tests__/geofence.test.ts` Expected: PASS
(original 6 + new 5).

- [ ] **Step 5: Format and commit**

```bash
deno fmt src/panel/lib/geofence.ts src/panel/lib/__tests__/geofence.test.ts
git add src/panel/lib/geofence.ts src/panel/lib/__tests__/geofence.test.ts
git commit -m "$(cat <<'EOF'
Add pointInMultiPolygon for multipolygon zone filtering

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `computeZoneCoverage` (coverage, additive)

**Files:**

- Modify: `src/panel/lib/coverage.ts`
- Test: `src/panel/lib/__tests__/coverage.test.ts` (append only)

- [ ] **Step 1: Append the failing tests**

Append to `src/panel/lib/__tests__/coverage.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test -A src/panel/lib/__tests__/coverage.test.ts` Expected: FAIL —
`computeZoneCoverage` is not exported.

- [ ] **Step 3: Implement**

Append to `src/panel/lib/coverage.ts` (note: `polygonArea` is already imported
at the top of the file):

```ts
import type { ZoneShape } from "../../types.ts";

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
```

> Move the new `import type` to the top with the existing `import type { BBox }`
> if `deno fmt` requires; keep the file fmt-clean.

- [ ] **Step 4: Run to verify it passes**

Run: `deno test -A src/panel/lib/__tests__/coverage.test.ts` Expected: PASS
(original 5 + new 4).

- [ ] **Step 5: Format and commit**

```bash
deno fmt src/panel/lib/coverage.ts src/panel/lib/__tests__/coverage.test.ts
git add src/panel/lib/coverage.ts src/panel/lib/__tests__/coverage.test.ts
git commit -m "$(cat <<'EOF'
Add computeZoneCoverage for multipolygon zones

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: GeoJSON feature → `RegionRecord` transform (pure)

**Files:**

- Create: `scripts/boundaries/transform.ts`
- Test: `scripts/boundaries/transform.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/boundaries/transform.test.ts
import { assertEquals } from "jsr:@std/assert@1";
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
  // First coord of the outer ring becomes [lat, lng] = [0, 0].
  assertEquals(r.shape[0].outer[0], [0, 0]);
});

Deno.test("featureToRegion - preserves the hole on the first part", () => {
  const r = featureToRegion(FEATURE, 0.0001);
  assertEquals(r.shape[0].holes.length, 1);
});

Deno.test("featureToRegion - drops parts that collapse below 3 vertices", () => {
  const r = featureToRegion(FEATURE, 0.0001);
  assertEquals(r.shape.length, 1); // the sliver part is gone
});

Deno.test("featureToRegion - strips the closing duplicate point", () => {
  const r = featureToRegion(FEATURE, 0.0001);
  const outer = r.shape[0].outer;
  // Closed input had 5 points (last == first); simplified open ring has 4.
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test -A scripts/boundaries/transform.test.ts` Expected: FAIL — module
not found.

- [ ] **Step 3: Implement**

```ts
// scripts/boundaries/transform.ts
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
  // Drop the closing duplicate if present.
  if (
    pts.length > 1 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
  ) {
    pts = pts.slice(0, -1);
  }
  const simplified = simplifyRing(pts, tolerance);
  // Remove consecutive duplicates the simplifier may leave at the seam.
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
  const bbox: BBox = { sw_lat, sw_lng, ne_lat, ne_lng };

  return {
    id: slugify(String(props.FullName ?? props.NAME ?? "")),
    name: String(props.NAME ?? ""),
    fullName: String(props.FullName ?? ""),
    type: String(props.FeatDesc ?? "") as RegionType,
    county: String(props.County ?? ""),
    bbox,
    shape,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `deno test -A scripts/boundaries/transform.test.ts` Expected: PASS (6
tests).

- [ ] **Step 5: Format and commit**

```bash
deno fmt scripts/boundaries/
git add scripts/boundaries/transform.ts scripts/boundaries/transform.test.ts
git commit -m "$(cat <<'EOF'
Add GeoJSON feature → RegionRecord transform

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Build-time fetch pipeline + generate the data artifact

**Files:**

- Create: `scripts/boundaries/build-boundaries.ts`
- Create: `src/panel/data/regions.ts`
- Modify: `build.ts`
- Generated (committed): `src/panel/data/ns-municipalities.json`

- [ ] **Step 1: Write the build-boundaries script (I/O)**

```ts
// scripts/boundaries/build-boundaries.ts
// Build-time only. Fetches the Socrata "Municipality Boundaries" GeoJSON with
// the SOCRATA_API_KEY/SECRET from .env (HTTP Basic auth), transforms every
// feature to a RegionRecord, and writes src/panel/data/ns-municipalities.json.
// Never bundled into the extension; never runs in the shipped code.
import { join } from "jsr:@std/path@1";
import type { RegionRecord } from "../../src/types.ts";
import { featureToRegion } from "./transform.ts";

// Minimal .env reader (KEY=VALUE per line) — avoids a dependency just to read
// two keys. Quotes are stripped; blank/comment lines ignored.
async function readEnv(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const VIEW = "7bqh-hssn";
const URL_GEOJSON =
  `https://data.novascotia.ca/api/v3/views/${VIEW}/query.geojson?$limit=200`;

// Simplification tolerance in degrees. ~0.0005° ≈ 50 m. Tuned for a few-hundred
// -KB artifact; the script prints the size so this can be adjusted.
const TOLERANCE = 0.0005;

export async function buildBoundaries(repoDir: string): Promise<void> {
  const env = await readEnv(join(repoDir, ".env"));
  const key = env.SOCRATA_API_KEY ?? Deno.env.get("SOCRATA_API_KEY");
  const secret = env.SOCRATA_API_SECRET ?? Deno.env.get("SOCRATA_API_SECRET");
  if (!key || !secret) {
    throw new Error(
      "Missing SOCRATA_API_KEY / SOCRATA_API_SECRET (.env) — needed for --refresh-boundaries.",
    );
  }
  const auth = "Basic " + btoa(`${key}:${secret}`);
  console.log("Fetching NS municipality boundaries…");
  const res = await fetch(URL_GEOJSON, { headers: { authorization: auth } });
  if (!res.ok) {
    throw new Error(`Socrata fetch failed: ${res.status} ${res.statusText}`);
  }
  const geo = await res.json() as { features: unknown[] };
  const regions: RegionRecord[] = (geo.features ?? [])
    .map((f) => featureToRegion(f, TOLERANCE))
    .filter((r) => r.shape.length > 0)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const outPath = join(repoDir, "src/panel/data/ns-municipalities.json");
  await Deno.mkdir(join(repoDir, "src/panel/data"), { recursive: true });
  const json = JSON.stringify(regions);
  await Deno.writeTextFile(outPath, json + "\n");

  const bytes = new TextEncoder().encode(json).length;
  const gz = await gzipSize(json);
  console.log(
    `Wrote ${regions.length} regions → ${outPath} ` +
      `(${(bytes / 1024).toFixed(0)} KB raw, ${(gz / 1024).toFixed(0)} KB gz)`,
  );
}

async function gzipSize(text: string): Promise<number> {
  const stream = new Blob([text]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return buf.byteLength;
}

if (import.meta.main) {
  await buildBoundaries(new URL("../..", import.meta.url).pathname);
}
```

- [ ] **Step 2: Verify the script type-checks**

Run: `deno check scripts/boundaries/build-boundaries.ts` Expected: PASS.

- [ ] **Step 3: Generate the artifact for real**

Run: `deno run -A scripts/boundaries/build-boundaries.ts` Expected: prints
`Wrote 49 regions → …/ns-municipalities.json (NNN KB raw, NN KB gz)`. If the raw
size is much larger than ~400 KB, raise `TOLERANCE` (e.g. 0.001) and re-run; if
boundaries look too coarse later, lower it. Record the final size in the commit
message.

- [ ] **Step 4: Add the typed wrapper**

```ts
// src/panel/data/regions.ts
import data from "./ns-municipalities.json" with { type: "json" };
import type { RegionRecord } from "../../types.ts";

export const NS_REGIONS = data as unknown as RegionRecord[];
```

- [ ] **Step 5: Wire build.ts to generate-on-demand**

In `build.ts`, after the `version` is read (after line 9) and before the
`npmCssPlugin` definition, add:

```ts
// Boundary data: generated once and committed. Re-fetch only when explicitly
// asked (--refresh-boundaries) or when the committed artifact is missing, so
// normal/--prod/--package builds stay offline and need no Socrata secrets.
const boundaryJson = join(dir, "src/panel/data/ns-municipalities.json");
const needBoundaries = Deno.args.includes("--refresh-boundaries") ||
  !(await exists(boundaryJson));
if (needBoundaries) {
  const { buildBoundaries } = await import(
    "./scripts/boundaries/build-boundaries.ts"
  );
  await buildBoundaries(dir);
}
```

Add this import near the top of `build.ts` (after the existing `join` import on
line 3):

```ts
import { exists } from "jsr:@std/fs@1";
```

- [ ] **Step 6: Verify a normal build does NOT refetch and the panel bundles the
      data**

Run: `deno run -A build.ts` Expected: build completes WITHOUT printing "Fetching
NS municipality boundaries…" (the committed JSON exists), and
`build/panel/panel.js` is produced.

- [ ] **Step 7: Format and commit (including the generated artifact)**

```bash
deno fmt build.ts src/panel/data/regions.ts scripts/boundaries/build-boundaries.ts
git add build.ts src/panel/data/regions.ts src/panel/data/ns-municipalities.json scripts/boundaries/build-boundaries.ts
git commit -m "$(cat <<'EOF'
Generate and bundle NS municipality boundary data

Fetched from Socrata 7bqh-hssn at build time (auth via .env), simplified
to <SIZE> KB. build.ts regenerates only on --refresh-boundaries or when
the committed artifact is missing.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Migrate the zone to `ZoneShape` end-to-end (atomic)

This is a coordinated rename + wire-format change across the type, overlay,
store, relays, the shared map hook, and App. It cannot compile in intermediate
states, so all edits land together and are verified once at the end. No existing
test is modified — `ParitySnapshot.polygon` stays a single-ring value, derived
from the zone.

**Files:**

- Modify: `src/types.ts`
- Modify: `src/content/geofence-overlay.ts`
- Modify: `src/panel/store.ts`
- Modify: `src/content/relay.ts`
- Modify: `src/content/ev/relay.ts`
- Modify: `src/content/shared/google-maps-hook.ts`
- Modify: `src/panel/App.tsx`

- [ ] **Step 1: Update message + store types in `src/types.ts`**

Replace the `ContentToPanel` `zone` variant (line 64):

```ts
| { type: "zone"; shape: ZoneShape | null }
| { type: "draw_state"; drawing: boolean }
```

Replace the entire `PanelToContent` union (lines 72-79) with:

```ts
export type PanelToContent =
  | { type: "clear_zone" }
  | { type: "begin_draw" }
  | { type: "cancel_draw" }
  | { type: "show_zone"; shape: ZoneShape }
  // Pan the page map to a bbox (region select). Promoted from the dev parity
  // harness; now a product feature, handled in both relays + the maps hook.
  | { type: "drive_viewport"; bbox: BBox };
```

In `TabStore` (lines 106-129): replace the `polygon` field (line 112) with:

```ts
zone: ZoneShape | null; // the active zone (custom draw or region) - the filter
selectedRegionId: string | null; // picked region id, or null for custom/none
drawing: boolean; // a custom draw is in progress (drives the panel button)
```

In `defaultTabStore` (lines 131-150): replace `polygon: null,` (line 138) with:

```ts
zone: null,
selectedRegionId: null,
drawing: false,
```

- [ ] **Step 2: Rework `src/content/geofence-overlay.ts`**

2a. Replace the import of `BBox` (line 9) with both types:

```ts
import type { BBox, ZoneShape } from "../types.ts";
```

2b. Replace the zone-change callback block (lines 11-18) with both callbacks:

```ts
let onZoneChange: ((shape: ZoneShape | null) => void) | null = null;
export function setOnZoneChange(
  fn: (shape: ZoneShape | null) => void,
): void {
  onZoneChange = fn;
}

let onDrawStateChange: ((drawing: boolean) => void) | null = null;
export function setOnDrawStateChange(fn: (drawing: boolean) => void): void {
  onDrawStateChange = fn;
}
```

2c. Replace the module-state block (lines 20-43) with:

```ts
let leafletMap: L.Map | null = null;
let drawnLayer: L.Polygon | null = null; // editable custom-draw layer
let regionLayers: L.Polygon[] = []; // non-editable rendered region parts
let currentShape: ZoneShape | null = null; // the active zone (custom or region)
let overlayEl: HTMLElement | null = null;
let hintEl: HTMLElement | null = null;

// ─── In-progress draw state ───────────────────────────────────────────────
let drawing = false;
let draftPts: L.LatLng[] = [];
let draftShape: L.Polyline | null = null;
let draftHint: L.Polyline | null = null;
let draftStartDot: L.CircleMarker | null = null;
let cursorDot: L.CircleMarker | null = null; // follows the mouse from draw start
let mouseDownAt: { x: number; y: number } | null = null;
```

2d. Replace `injectStyles` (lines 45-66) to drop the pulse keyframes and the
`#seelevel-draw-wrap` rule (keep the leaflet/geoman CSS and the overlay-pane
pointer-events rules):

```ts
function injectStyles(): void {
  if (document.getElementById("seelevel-leaflet-css")) return;
  const style = document.createElement("style");
  style.id = "seelevel-leaflet-css";
  style.textContent = leafletCss + "\n" + geomanCss +
    "\n#seelevel-leaflet-overlay.leaflet-container { background: transparent !important; }" +
    "\n#seelevel-leaflet-overlay .leaflet-overlay-pane svg path" +
    " { pointer-events: none !important; cursor: inherit !important; }";
  document.head.appendChild(style);
}
```

2e. Replace `clearZone` (lines 80-89) and DELETE `refreshPrompt`,
`setButtonState`, `setDrawPrompt`, `buildButtons` (lines 91-158) with:

```ts
export function clearZone(): void {
  if (drawing) endDraw(false);
  if (drawnLayer) {
    leafletMap?.removeLayer(drawnLayer);
    drawnLayer = null;
  }
  for (const lyr of regionLayers) leafletMap?.removeLayer(lyr);
  regionLayers = [];
  currentShape = null;
  setInteractivePanes(false);
  onZoneChange?.(null);
}

// Faint on-map instruction banner shown only while drawing.
function showHint(): void {
  if (!overlayEl || hintEl) return;
  hintEl = document.createElement("div");
  hintEl.id = "seelevel-draw-hint";
  hintEl.textContent =
    "Click to add points · click the first point to close · Esc to cancel";
  hintEl.style.cssText =
    "position:absolute;left:50%;top:8px;transform:translateX(-50%);z-index:3;" +
    "pointer-events:none;background:rgba(0,0,0,.62);color:#fff;font-size:10px;" +
    "font-weight:600;padding:4px 9px;border-radius:6px;white-space:nowrap;";
  overlayEl.parentElement?.appendChild(hintEl);
}
function hideHint(): void {
  if (hintEl) {
    hintEl.remove();
    hintEl = null;
  }
}
```

2f. Replace `startDraw` (lines 162-178) with an exported `beginDraw` + exported
`cancelDraw`, emitting draw-state and showing the hint:

```ts
export function beginDraw(): void {
  clearZone();
  drawing = true;
  draftPts = [];
  mouseDownAt = null;
  showHint();
  document.addEventListener("mousedown", onDraftDown, true);
  document.addEventListener("click", onDraftClick, true);
  document.addEventListener("mousemove", onDraftMove, true);
  document.addEventListener("keydown", onDraftKey, true);
  document.addEventListener("dblclick", onSuppressOverMap, true);
  document.addEventListener("contextmenu", onSuppressOverMap, true);
  onDrawStateChange?.(true);
}

export function cancelDraw(): void {
  if (drawing) endDraw(false);
}
```

2g. In `endDraw` (lines 180-205), remove the `setButtonState(...)` call in the
non-commit branch, hide the hint + cursor dot, and emit draw-state. Replace the
function body's teardown section and tail with:

```ts
function endDraw(commit: boolean): void {
  if (!drawing) return;
  drawing = false;
  document.removeEventListener("mousedown", onDraftDown, true);
  document.removeEventListener("click", onDraftClick, true);
  document.removeEventListener("mousemove", onDraftMove, true);
  document.removeEventListener("keydown", onDraftKey, true);
  document.removeEventListener("dblclick", onSuppressOverMap, true);
  document.removeEventListener("contextmenu", onSuppressOverMap, true);
  mouseDownAt = null;
  hideHint();

  for (const layer of [draftShape, draftHint, draftStartDot, cursorDot]) {
    if (layer) leafletMap?.removeLayer(layer);
  }
  draftShape =
    draftHint =
    draftStartDot =
    cursorDot =
      null;
  const pts = draftPts;
  draftPts = [];

  if (commit && pts.length >= 3 && leafletMap) {
    const poly = L.polygon(pts);
    poly.addTo(leafletMap);
    onPolygonCreated(poly);
  }
  onDrawStateChange?.(false);
}
```

2h. In `onDraftMove` (lines 225-230), render the cursor-follow dot even before
the first point:

```ts
function onDraftMove(e: MouseEvent): void {
  if (!leafletMap || !overMap(e)) return;
  const at = leafletMap.containerPointToLatLng(
    leafletMap.mouseEventToContainerPoint(e),
  );
  if (cursorDot) cursorDot.setLatLng(at);
  else {
    cursorDot = L.circleMarker(at, {
      radius: 4,
      color: "#ffc266",
      fillColor: "#ffc266",
      fillOpacity: 0.9,
      weight: 1,
    }).addTo(leafletMap);
  }
  if (draftPts.length > 0) redrawDraft(at);
}
```

2i. In `onDraftKey` (lines 277-290), add Enter-to-finish:

```ts
function onDraftKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    endDraw(false);
  } else if (e.key === "Enter") {
    endDraw(draftPts.length >= 3);
  } else if (
    (e.key === "Backspace" || e.key === "Delete") && draftPts.length > 0
  ) {
    draftPts.pop();
    if (draftHint) {
      leafletMap?.removeLayer(draftHint);
      draftHint = null;
    }
    redrawDraft();
  }
}
```

2j. In `redrawDraft` (lines 294-336), delete the trailing `if (drawBtn) { … }`
block (the button no longer exists). Leave the rest unchanged.

2k. Replace `onPolygonCreated` (lines 338-363) so it stores `currentShape` and
emits a `ZoneShape`:

```ts
function onPolygonCreated(layer: L.Polygon): void {
  drawnLayer = layer;
  layer.setStyle({
    color: "#1f9bbf",
    fillColor: "#1f9bbf",
    fillOpacity: 0.1,
    weight: 1.5,
  });
  layer.pm.enable({ allowSelfIntersection: false });
  setInteractivePanes(true);

  const updateZone = () => {
    const latlngs = layer.getLatLngs()[0] as L.LatLng[];
    const outer: [number, number][] = latlngs.map((p) => [p.lat, p.lng]);
    currentShape = [{ outer, holes: [] }];
    onZoneChange?.(currentShape);
  };
  updateZone();
  layer.on("pm:edit", updateZone);
  layer.on("pm:vertexadded", updateZone);
  layer.on("pm:vertexremoved", updateZone);
}
```

2l. In `initLeafletOverlay` (lines 365-399), DELETE the
`buildButtons(mapContainer);` call (last line of the function).

2m. Replace `getCurrentPolygon` (lines 442-445) and `setZone` (lines 450-462)
with `getCurrentShape` + `showZone`:

```ts
export function getCurrentShape(): ZoneShape | null {
  return currentShape;
}

// Render a predefined region: one non-editable Leaflet polygon per part (with
// holes). Replaces any existing zone and becomes the current shape.
export function showZone(shape: ZoneShape): void {
  if (!leafletMap || shape.length === 0) return;
  clearZone();
  for (const part of shape) {
    const rings: L.LatLngExpression[][] = [
      part.outer.map(([lat, lng]) => [lat, lng]),
      ...part.holes.map((h) => h.map(([lat, lng]) => [lat, lng])),
    ];
    const poly = L.polygon(rings, {
      color: "#1f9bbf",
      fillColor: "#1f9bbf",
      fillOpacity: 0.1,
      weight: 1.5,
    });
    poly.addTo(leafletMap);
    regionLayers.push(poly);
  }
  currentShape = shape;
  onZoneChange?.(shape);
}
```

- [ ] **Step 3: Update `src/panel/store.ts` zone scoping**

Replace the import (line 1):

```ts
import { pointInMultiPolygon } from "./lib/geofence.ts";
```

Replace the `scopedListings` destructure (line 48) and the zone branch (lines
61-69):

```ts
const { scope, session, viewportListings, viewportBbox, zone } = store;
```

```ts
if (scope === "zone") {
  if (!zone) return [];
  return session.filter(
    (l) =>
      l.lat !== null && l.lng !== null &&
      pointInMultiPolygon(l.lat!, l.lng!, zone),
  );
}
```

- [ ] **Step 4: Update `src/content/relay.ts`**

4a. Replace the overlay import block (lines 16-25):

```ts
import {
  beginDraw,
  cancelDraw,
  clearZone,
  getCurrentShape,
  initGeofenceOverlay,
  setOnDrawStateChange,
  setOnZoneChange,
  setOverlayVisible,
  showZone,
  syncMapView,
} from "./geofence-overlay.ts";
```

4b. Replace the message handler (lines 66-84) — note `__DEV__` is dropped from
`drive_viewport`, and `zone_prompt`/`drive_zone` are gone:

```ts
if (msg.type === "msg") {
  const p = msg.payload;
  if (p.type === "clear_zone") clearZone();
  else if (p.type === "begin_draw") beginDraw();
  else if (p.type === "cancel_draw") cancelDraw();
  else if (p.type === "show_zone") showZone(p.shape);
  else if (p.type === "drive_viewport") {
    document.dispatchEvent(
      new CustomEvent(DRIVE_EVENT, { detail: { bbox: p.bbox } }),
    );
  }
}
```

4c. In `clearAndReEmit` (line 131) replace the zone re-emit:

```ts
emit({ type: "zone", shape: getCurrentShape() });
```

4d. In the `EVT.listings` handler (line 207) replace the zone re-send:

```ts
emit({ type: "zone", shape: getCurrentShape() });
```

4e. Replace the `setOnZoneChange` wiring at the bottom (line 268) and add the
draw-state wiring:

```ts
setOnZoneChange((shape) => emit({ type: "zone", shape }));
setOnDrawStateChange((drawing) => emit({ type: "draw_state", drawing }));
```

4f. The `DRIVE_EVENT` import on line 15 stays. Remove the now-unused `__DEV__`
declaration (line 27) only if `deno check` flags it as unused; otherwise leave
it.

- [ ] **Step 5: Update `src/content/ev/relay.ts`**

Apply the exact same edits as Task 7 Step 4 to the EV relay:

- 5a. Replace the overlay import block (lines 11-20) with the same import list
  as 4a (path `../geofence-overlay.ts`).
- 5b. Replace the message handler (lines 48-66) with the same body as 4b.
- 5c. In `reEmit` (line 99) replace with
  `emit({ type: "zone", shape: getCurrentShape() });`.
- 5d. In the `EVT.listings` handler (line 178) replace with
  `emit({ type: "zone", shape: getCurrentShape() });`.
- 5e. Replace the bottom wiring (line 202) with the two lines from 4e.

- [ ] **Step 6: Un-gate the map driver in
      `src/content/shared/google-maps-hook.ts`**

Replace the dev-only block (lines 172-188) with an always-installed listener:

```ts
// Drive the map to a requested bbox — region pan from the Zone tab (and the
// dev parity harness). The ISOLATED relay dispatches seelevel:drive.
document.addEventListener(DRIVE_EVENT, (e) => {
  const d = (e as CustomEvent<{ bbox: BBox }>).detail;
  if (!d?.bbox || !currentMap) return;
  try {
    currentMap.fitBounds?.({
      north: d.bbox.ne_lat,
      south: d.bbox.sw_lat,
      east: d.bbox.ne_lng,
      west: d.bbox.sw_lng,
    });
  } catch { /* never break the page */ }
});
```

- [ ] **Step 7: Update `src/panel/App.tsx` (payload handling + derived parity
      polygon)**

7a. Replace the `polygonBbox` helper (lines 56-67) with a zone-outline → ring
helper used only for the parity snapshot:

```ts
// Outer ring of a single-part, hole-less zone (a custom draw) — used only to
// keep the dev parity snapshot's single-ring `polygon` field populated.
function zoneOuterRing(zone: TabStore["zone"]): [number, number][] | null {
  if (zone && zone.length === 1 && zone[0].holes.length === 0) {
    return zone[0].outer;
  }
  return null;
}
```

7b. In `buildSnapshot` (line 95) replace `polygon: store.polygon,` with:

```ts
polygon: zoneOuterRing(store.zone),
```

7c. Replace the `zone` payload handler (lines 214-222):

```ts
if (payload.type === "zone") {
  // Re-sends arrive on every listings update; only adopt zone scope when
  // a zone first appears, and clear it when the zone goes away.
  const isNewZone = !!payload.shape && !s.zone;
  s.zone = payload.shape;
  if (isNewZone) s.scope = "zone";
  else if (!payload.shape && s.scope === "zone") s.scope = "session";
}

if (payload.type === "draw_state") {
  s.drawing = payload.drawing;
}
```

7d. In the dev `__seelevelSync` block (lines 330-341), replace the zone branch
to use the new message + shape (the harness drives a single-part shape):

```ts
if ((what === "zone" || what === "both") && fromStore.zone) {
  const ring = zoneOuterRing(fromStore.zone);
  postToRelay(toStore.tabId, {
    type: "drive_viewport",
    bbox: ring
      ? {
        sw_lat: Math.min(...ring.map((p) => p[0])),
        sw_lng: Math.min(...ring.map((p) => p[1])),
        ne_lat: Math.max(...ring.map((p) => p[0])),
        ne_lng: Math.max(...ring.map((p) => p[1])),
      }
      : fromStore.viewportBbox!,
  });
  postToRelay(toStore.tabId, {
    type: "show_zone",
    shape: fromStore.zone,
  });
  result.zone = fromStore.zone;
}
```

7e. DELETE the `zone_prompt` effect (lines 429-434 — the whole `useEffect` that
posts `{ type: "zone_prompt", active }`).

7f. Replace the coverage computation (lines 440-442) to use the zone + the new
function. Add the import first — change line 20:

```ts
import { computeCoverage, computeZoneCoverage } from "./lib/coverage.ts";
```

(Keep `computeCoverage` imported — `parity.ts` does not use it, but leaving it
avoids churn; if `deno check`/`deno lint` flags it unused, drop it to just
`computeZoneCoverage`.)

```ts
const coverage = store?.zone && store.fetchedBboxes.length > 0
  ? computeZoneCoverage(store.fetchedBboxes, store.zone)
  : null;
```

7g. Replace the `zoneNoPolygon` line (line 448):

```ts
const zoneNoPolygon = !!store && store.scope === "zone" && !store.zone;
```

7h. In the footer Clear button handler (lines 592-599) replace `polygon: null,`
with the three new fields:

```ts
updateStore({
  session: [],
  viewportListings: null,
  fetchedBboxes: [],
  viewportBbox: null,
  zone: null,
  selectedRegionId: null,
  drawing: false,
  scope: "viewport",
});
```

> The Zone-tab body (the `zoneNoPolygon` empty-state block, lines 516-527) and
> the `ZonePanel` rendering are handled in Task 8. After this task the Zone tab
> still shows the old "Draw Zone" empty-state text — that is replaced next.

- [ ] **Step 8: Type-check, test, build**

Run: `deno check src/ scripts/` Expected: PASS.

Run: `deno test -A src/ scripts/` Expected: PASS — full suite green (all
existing tests + the multipolygon additions; no test was modified).

Run: `deno run -A build.ts` Expected: build completes; no boundary refetch.

- [ ] **Step 9: Format and commit**

```bash
deno fmt
git add src/types.ts src/content/geofence-overlay.ts src/panel/store.ts \
  src/content/relay.ts src/content/ev/relay.ts \
  src/content/shared/google-maps-hook.ts src/panel/App.tsx
git commit -m "$(cat <<'EOF'
Migrate zone to multipolygon ZoneShape end-to-end

Rename TabStore.polygon → zone (ZoneShape); wire {type:"zone",shape} and
{type:"draw_state"}; add begin_draw/cancel_draw/show_zone and promote
drive_viewport to production. Overlay gains showZone/getCurrentShape/
beginDraw/cancelDraw, a cursor-follow dot, an on-map hint banner, and
Enter-to-finish; persistent map buttons and the prompt pulse are removed.
Parity snapshot keeps a derived single-ring polygon, so no test changes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Zone-tab UI — region picker, draw, reset

**Files:**

- Create: `src/panel/components/ZonePanel.tsx`
- Modify: `src/panel/App.tsx`

- [ ] **Step 1: Create the `ZonePanel` component**

```tsx
// src/panel/components/ZonePanel.tsx
import { h } from "preact";
import type { RegionRecord, RegionType } from "../../types.ts";
import { NS_REGIONS } from "../data/regions.ts";

// Optgroup order + headings, grouped by unit type.
const GROUPS: { type: RegionType; label: string }[] = [
  { type: "Regional Municipality", label: "Regional Municipalities" },
  { type: "Municipal County", label: "Counties" },
  { type: "Municipal District", label: "Districts" },
  { type: "Town", label: "Towns" },
];

export function ZonePanel(
  { selectedRegionId, drawing, hasZone, onSelectRegion, onToggleDraw, onReset }:
    {
      selectedRegionId: string | null;
      drawing: boolean;
      hasZone: boolean;
      onSelectRegion: (region: RegionRecord) => void;
      onToggleDraw: () => void;
      onReset: () => void;
    },
) {
  return (
    <div class="seelevel-zone-panel">
      <div class="seelevel-row" style={{ gap: "6px" }}>
        <select
          class="seelevel-region-select"
          style={{ flex: 1 }}
          value={selectedRegionId ?? ""}
          onChange={(e) => {
            const id = (e.currentTarget as HTMLSelectElement).value;
            const region = NS_REGIONS.find((r) => r.id === id);
            if (region) onSelectRegion(region);
          }}
        >
          <option value="" disabled>Select a region…</option>
          {GROUPS.map((g) => (
            <optgroup key={g.type} label={g.label}>
              {NS_REGIONS.filter((r) => r.type === g.type).map((r) => (
                <option key={r.id} value={r.id}>{r.fullName}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {(hasZone || drawing) && (
          <button
            class="seelevel-btn seelevel-btn--ghost"
            onClick={onReset}
          >
            Reset zone
          </button>
        )}
      </div>
      <button
        class={`seelevel-btn ${drawing ? "seelevel-btn--active" : ""}`}
        style={{ width: "100%", marginTop: "6px" }}
        onClick={onToggleDraw}
      >
        {drawing ? "✕ Cancel draw" : "⬡ Draw custom zone"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Render `ZonePanel` in `App.tsx` and wire the handlers**

2a. Add the imports near the other component imports (after line 29):

```ts
import { ZonePanel } from "./components/ZonePanel.tsx";
import type { RegionRecord } from "../types.ts";
```

2b. Add a `bboxOf` helper near `zoneOuterRing` (added in Task 7) so region
selection can pan the map (regions already carry `bbox`, so just forward it). No
new helper needed — use `region.bbox` directly.

2c. In the header section, render `ZonePanel` when zone scope is active. Replace
the `ScopeSelector` + coverage block (lines 499-509) with:

```tsx
{
  store && (
    <>
      <ScopeSelector
        scope={store.scope}
        onScope={(scope) => updateStore({ scope })}
      />
      {store.scope === "zone" && (
        <ZonePanel
          selectedRegionId={store.selectedRegionId}
          drawing={store.drawing}
          hasZone={!!store.zone}
          onSelectRegion={(region: RegionRecord) => {
            updateStore({
              zone: region.shape,
              selectedRegionId: region.id,
              scope: "zone",
            });
            if (activeTabId !== null) {
              postToRelay(activeTabId, {
                type: "drive_viewport",
                bbox: region.bbox,
              });
              postToRelay(activeTabId, {
                type: "show_zone",
                shape: region.shape,
              });
            }
          }}
          onToggleDraw={() => {
            if (activeTabId === null) return;
            if (store.drawing) {
              postToRelay(activeTabId, { type: "cancel_draw" });
            } else {
              updateStore({ selectedRegionId: null });
              postToRelay(activeTabId, { type: "begin_draw" });
            }
          }}
          onReset={() => {
            updateStore({
              zone: null,
              selectedRegionId: null,
              drawing: false,
              scope: "viewport",
            });
            if (activeTabId !== null) {
              postToRelay(activeTabId, { type: "clear_zone" });
            }
          }}
        />
      )}
      {store.scope === "zone" && coverage !== null && (
        <ZoneCoverage coverage={coverage} count={listingCount} />
      )}
    </>
  );
}
```

2d. Replace the `zoneNoPolygon` empty-state body (lines 516-527) with a short
hint that points at the now-visible controls:

```tsx
: zoneNoPolygon
? (
  <div class="seelevel-empty">
    <div class="seelevel-empty__icon">⬡</div>
    <div class="seelevel-empty__text">
      No zone yet. Pick a region above, or draw a custom zone — results
      are then filtered to listings inside it.
    </div>
  </div>
)
```

- [ ] **Step 3: Add minimal styles for the region select**

Append to `src/panel/panel.css`:

```css
.seelevel-zone-panel {
  margin-top: 7px;
}
.seelevel-region-select {
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.2));
  background: var(--color-surface, #fff);
  color: inherit;
}
```

> If `panel.css` already defines `--color-border`/`--color-surface`/
> `.seelevel-btn--active`, the fallbacks are harmless. Check the existing token
> names in `panel.css` and prefer them; only add a token if it is genuinely
> missing.

- [ ] **Step 4: Type-check and build**

Run: `deno check src/` Expected: PASS.

Run: `deno run -A build.ts` Expected: build completes.

- [ ] **Step 5: Manual smoke test (load unpacked from `build/`)**

In `chrome://extensions` → reload SeeLevel → open ViewPoint map and the panel.
Verify:

- The map no longer shows the `Draw Zone` / `Redraw` / `Clear` buttons.
- Zone tab shows the region dropdown + "Draw custom zone".
- Selecting a region pans the map and draws the boundary; scope switches to
  Zone; coverage + count populate as listings load.
- "Draw custom zone" starts a draw with a cursor-follow dot + hint banner; the
  panel button reads "✕ Cancel draw"; finishing (click first point / Enter) or
  cancelling (Esc / the button) returns it to "⬡ Draw custom zone".
- "Reset zone" clears the boundary + selection and returns to Viewport scope.
- Repeat on an Engel & Völkers map tab.

- [ ] **Step 6: Format and commit**

```bash
deno fmt
git add src/panel/components/ZonePanel.tsx src/panel/App.tsx src/panel/panel.css
git commit -m "$(cat <<'EOF'
Add Zone-tab region picker, draw, and reset controls

Region dropdown grouped by unit type pans the map and auto-draws the
boundary; "Draw custom zone" toggles draw mode (synced via draw_state);
"Reset zone" clears the zone and selection. Replaces the removed on-map
zone buttons.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Docs + version bump

**Files:**

- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `manifest.json`

- [ ] **Step 1: Bump the version**

In `manifest.json` change `"version": "0.2.0"` → `"version": "0.3.0"`.

- [ ] **Step 2: CHANGELOG**

Add a `## 0.3.0` section at the top of `CHANGELOG.md` describing: predefined NS
municipal region zones (Socrata 7bqh-hssn, simplified at build time), the
Zone-tab redesign (region picker, draw-custom, reset; on-map buttons removed),
and the multipolygon `ZoneShape` zone model.

- [ ] **Step 3: README**

In `README.md`, document: selecting a region in the Zone tab pans the map and
draws the boundary; the build-time boundary data step
(`deno run -A build.ts --refresh-boundaries`, requires `SOCRATA_API_KEY`/
`SOCRATA_API_SECRET` in `.env`); and that the committed
`src/panel/data/ns-municipalities.json` means normal builds need no secrets.

- [ ] **Step 4: CLAUDE.md**

Add to the build-system section: the `scripts/boundaries/` pipeline and the
`--refresh-boundaries` flag. Add to the compliance section a line noting the
bundled boundary JSON is a static asset (not `chrome.storage`) and that the
Socrata fetch is build-time only, never in the shipped extension; permissions
remain `["sidePanel"]`.

- [ ] **Step 5: Verify formatting and commit**

```bash
deno fmt
git add README.md CHANGELOG.md CLAUDE.md manifest.json
git commit -m "$(cat <<'EOF'
Document region zones + bump to 0.3.0

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full type-check**

Run: `deno check src/ scripts/` Expected: PASS.

- [ ] **Step 2: Full test suite**

Run: `deno test -A src/ scripts/` Expected: PASS — all tests green.

- [ ] **Step 3: Lint + format check**

Run: `deno lint && deno fmt --check` Expected: clean.

- [ ] **Step 4: Production build + package**

Run: `deno run -A build.ts --package` Expected: minified build with no boundary
refetch; `seelevel-0.3.0.zip` produced. Confirm the zip size is reasonable (the
boundary JSON adds the few-hundred-KB artifact). Confirm `__DEV__`-gated parity
code is stripped (no `seelevel:drive` producer remains except the now-production
hook listener, which is intended).

- [ ] **Step 5: Final manual smoke test**

Load the `build/` unpacked extension and re-run the Task 8 Step 5 checklist on
both ViewPoint and EV, plus: open two tabs and confirm region zones are
independent per tab, and that closing/reopening the panel re-derives the zone
state without error.

---

## Self-review notes (for the implementer)

- **Spec coverage:** boundary pipeline (T1, T5, T6), simplification (T1),
  full-multipolygon `ZoneShape` (T2, T3, T4, T7), overlay rework + draw
  affordances + button removal (T7), Zone-tab UI with picker/draw/reset (T8),
  messaging + drive promotion (T7), compliance (unchanged — verified T10), tests
  (T1, T3, T4, T5 + zone scoping covered by `pointInMultiPolygon`/
  `computeZoneCoverage` unit tests). The spec's "zone scoping in store.test.ts"
  is satisfied by the `pointInMultiPolygon` tests that the store branch calls;
  if a store-level test is desired, add a `scopedListings` zone test in
  `src/panel/__tests__/store.test.ts` (append-only).
- **No existing test is modified** anywhere — every test change is an append or
  a new file. `ParitySnapshot.polygon` stays single-ring (derived), so
  `parity.test.ts` is untouched;
  `computeCoverage`/`pointInPolygon`/`polygonArea` keep their signatures, so
  `coverage.test.ts`/`geofence.test.ts` are untouched.
- **Type consistency:** overlay exports used by relays are `beginDraw`,
  `cancelDraw`, `clearZone`, `getCurrentShape`, `showZone`, `setOnZoneChange`,
  `setOnDrawStateChange`, `setOverlayVisible`, `syncMapView`,
  `initGeofenceOverlay` — matched in both relays (T7 S4/S5). Message types
  (`begin_draw`, `cancel_draw`, `show_zone`, `drive_viewport`, `zone`,
  `draw_state`) match across `types.ts`, both relays, and `App.tsx`.
