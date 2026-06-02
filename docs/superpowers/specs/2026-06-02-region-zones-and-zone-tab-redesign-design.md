# NS region zones + Zone-tab redesign

Date: 2026-06-02 Status: Approved (design)

## Summary

Two interlocking changes to the zone feature:

1. **Predefined region zones.** Ship Nova Scotia municipal boundaries (towns,
   districts, counties, regional municipalities) inside the extension artifact.
   The user picks a region from a dropdown in the Zone tab; the map pans to it
   and the boundary is drawn automatically as the active zone filter.
2. **Zone-tab redesign.** Move the zone controls off the map and into the Zone
   tab: a region picker, a "Draw custom zone" button, and a "Reset zone" button.
   The persistent map buttons (`Draw Zone` / `Redraw` / `Clear`) are removed.
   Custom drawing still happens on the map, with a cursor-follow point
   affordance and an on-map hint banner.

Both feed the same canonical zone filter, so aggregation, coverage, and CSV
export are unchanged downstream.

## Data source

Socrata view `7bqh-hssn` — **"Municipality Boundaries"** on
`data.novascotia.ca`. 49 features:

| Unit type (`FeatDesc`) | Count |
| ---------------------- | ----- |
| Town                   | 25    |
| Municipal District     | 11    |
| Municipal County       | 9     |
| Regional Municipality  | 4     |

Columns used: `NAME`, `FullName`, `FeatDesc`, `County`, and `the_geom`
(MultiPolygon). Each feature also carries a geographic `County` label.

The full-resolution GeoJSON is **72 MB raw / 27 MB gzipped, ~1.8M vertices**,
with up to **1,797 polygon parts** in a single feature (HRM coastline +
islands). Shipping it raw is impossible; aggressive build-time simplification is
mandatory.

The v3 GeoJSON endpoint (`/api/v3/views/7bqh-hssn/query.geojson`) requires
authentication. We pass the `SOCRATA_API_KEY` / `SOCRATA_API_SECRET` from `.env`
as HTTP Basic auth (`-u key:secret`). Verified working.

## Key decision: full multipolygon, no collapsing

A region's parts are separated by water (e.g. HRM mainland +
McNabs/Lawlor/Devils islands). Collapsing them into a single ring cannot be
lossless:

- A convex/concave hull **adds** area (harbour, neighbouring municipalities) and
  would count out-of-zone listings as in-zone — over-inclusive.
- A true union of disjoint parts is still multiple rings; no single ring covers
  two islands without covering the sea between them.

Collapsing only buys performance, and there is none to gain: point-in-polygon
over 49 regions × a few hundred simplified vertices against a few hundred
listings is microseconds. So we keep the **full multipolygon** (every part and
hole) and use **vertex simplification** as the only size lever. "Lossless" here
means topology-preserving — the sole error is sub-meter vertex simplification,
far below listing/display resolution.

## Architecture

### 1. Boundary data pipeline (build time)

New directory `scripts/boundaries/`:

- **`simplify.ts`** — pure Ramer–Douglas–Peucker simplification of a single ring
  (`[number,number][] → [number,number][]`), endpoints always preserved. No I/O,
  no deps. Unit-tested.
- **`build-boundaries.ts`** — the fetch + transform pipeline (Deno, build time
  only):
  1. Read `SOCRATA_API_KEY` / `SOCRATA_API_SECRET` from `.env` (fail with a
     clear message if absent).
  2. `fetch` the v3 GeoJSON with Basic auth.
  3. For each feature, convert `the_geom` (GeoJSON `[lng,lat]`) to the canonical
     `ZoneShape` (`[lat,lng]`), simplify every ring, round coords to 5 decimals.
  4. Drop only parts that simplify below 3 distinct vertices (zero area — cannot
     contain a listing, so lossless). Compute each region's `bbox`.
  5. Write **`src/panel/data/ns-municipalities.json`** (committed) and print its
     raw + gzipped size.

`build.ts` gains a `--refresh-boundaries` flag. The fetch step runs **only**
when that flag is passed **or** the committed JSON is missing. Normal dev
builds, `--prod`, and `--package` use the committed artifact — offline-safe and
requiring no secrets in CI or Web Store packaging. The raw 72 MB GeoJSON is
never written to the repo.

**Per-region record** in the JSON:

```ts
interface RegionRecord {
  id: string; // stable slug, e.g. "halifax-regional-municipality"
  name: string; // NAME, e.g. "Halifax"
  fullName: string; // FullName, e.g. "Halifax Regional Municipality"
  type:
    | "Regional Municipality"
    | "Municipal County"
    | "Municipal District"
    | "Town";
  county: string; // County label
  bbox: BBox; // for the map pan
  shape: ZoneShape; // simplified multipolygon
}
```

**Size budget:** tolerance is dialed to target a few-hundred-KB JSON. The build
prints the gzipped size so the tolerance can be tuned. Lossless on topology,
sub-meter on vertices.

### 2. Unified zone shape (the type change)

New canonical types in `src/types.ts`:

```ts
interface ZonePart {
  outer: [number, number][];
  holes: [number, number][][];
}
type ZoneShape = ZonePart[];
```

A hand-drawn zone is exactly one part with no holes; a region is N parts. This
unifies custom and predefined zones onto one filter/render path.

Changes that ripple from this:

- `TabStore.polygon: [number,number][] | null` →
  `TabStore.zone: ZoneShape | null`.
- Wire message `{ type: "zone", polygon }` → `{ type: "zone", shape }`.
- **`geofence.ts`** — add `pointInMultiPolygon(lat, lng, shape)`: a point is
  inside the shape when it lies in some part's `outer` ring and in none of that
  part's `holes`. Built on the existing `pointInPolygon`. The existing
  single-ring `pointInPolygon` and `polygonArea` are kept as primitives.
- **`coverage.ts`** — zone area = Σ over parts of (outer area − Σ hole areas);
  coverage intersects fetched bboxes against the multipolygon. Extended to
  accept `ZoneShape`.
- **`store.ts`** — `scopedListings` zone branch uses `pointInMultiPolygon`.

### 3. Map overlay (`src/content/geofence-overlay.ts`)

- **Remove** the persistent `Draw Zone` / `Redraw` / `Clear` buttons
  (`buildButtons`) and the pulse-prompt machinery (`setDrawPrompt`,
  `refreshPrompt`, `promptActive`, the pulse keyframes).
- New / changed exports:
  - `beginDraw()` — start a custom click-to-place draw (panel-triggered). Same
    click-to-place mechanics as today (overlay stays `pointer-events:none`,
    vertices placed from a document-level click listener).
  - `cancelDraw()` — abort an in-progress draw (panel-triggered).
  - `showZone(shape: ZoneShape)` — render a predefined region: one styled
    Leaflet polygon per part (with holes), **non-editable**. Replaces any
    existing zone.
  - `clearZone()` — unchanged contract; clears drawn/shown zone and any draft.
  - `getCurrentShape(): ZoneShape | null` — replaces `getCurrentPolygon`.
- Custom draw stays single-ring and **Geoman-editable** exactly as today, plus:
  - A **cursor-follow point dot** rendered from the moment `beginDraw()` starts,
    before the first click (currently the draft only appears after point 1).
  - A **faint on-map hint banner** while drawing: "Click to add points · click
    the first point to close · Esc to cancel".
  - **Enter** also finishes (≥3 points); **Esc** cancels (unchanged).
- `onZoneChange` now emits a `ZoneShape` (custom draw → single part, no holes).
- Predefined regions are **non-editable** — `showZone` does not enable Geoman on
  the rendered parts.

### 4. Panel Zone tab (`src/panel/components/ZonePanel.tsx`, new)

Rendered when the Zone scope is selected. Layout, top to bottom:

1. **"Reset zone"** button at the top — clears the zone, the picker selection,
   and drops scope back to `viewport`. Sends `clear_zone`.
2. Region **`<select>`** grouped by unit type via `<optgroup>`: Regional
   Municipalities, Counties, Districts, Towns. Options use `fullName` so unit
   type and relative area are unambiguous. Sourced from the bundled
   `ns-municipalities.json`.
3. **"Draw custom zone"** button → sends `begin_draw`; toggles to **"Cancel
   draw"** (sends `cancel_draw`) while a draw is in progress.
4. `ZoneCoverage` shown whenever a zone exists.

Behaviour:

- **Select a region:** set `store.zone = region.shape`, `store.scope = "zone"`,
  remember `selectedRegionId`; send `drive_viewport(region.bbox)` (pan the page
  map) and `show_zone(region.shape)` (render the boundary).
- **Draw custom zone:** send `begin_draw`; the resulting `ZoneShape` arrives
  back via the existing `{ type: "zone", shape }` message. Clears
  `selectedRegionId`.
- **Reset zone:** clear zone + selection, scope → `viewport`, send `clear_zone`.

`ScopeSelector` keeps its `⬡ Zone` tab; selecting it shows the `ZonePanel`. The
old in-`App.tsx` "No zone drawn yet — use the pulsing Draw Zone button" empty
state is replaced by the `ZonePanel` controls themselves.

### 5. Messaging & contexts

Message-type changes in `src/types.ts`:

- Promote `drive_viewport { bbox }` to **production** (was dev-only) — region
  pan.
- Add production `begin_draw`, `cancel_draw`, and `show_zone { shape }`.
- The dev-only parity `drive_zone { polygon }` folds into `show_zone { shape }`
  (the parity harness sends a one-part shape).
- `{ type: "zone", polygon }` → `{ type: "zone", shape }` (relay → panel).
- **Remove** `zone_prompt { active }` and its `App.tsx` effect — it only drove
  the map button's attention pulse, which is gone with the persistent buttons.

Both relays (`src/content/relay.ts`, `src/content/ev/relay.ts`) handle
`begin_draw` / `cancel_draw` / `show_zone` / `drive_viewport` → overlay calls.
The `__DEV__` gate is removed from `drive_viewport` (now a product feature); the
shared `google-maps-hook.ts` `fitBounds` driver is likewise un-gated for the pan
path.

### Data flow (region select)

```
ZonePanel <select> change
  → App: store.zone = region.shape, scope = "zone", selectedRegionId = id
  → port "panel" → SW → relay:
       drive_viewport(region.bbox)   → seelevel:drive → google.maps fitBounds
       show_zone(region.shape)        → overlay.showZone (render parts)
  → page map pans → page fires its own listing XHR
       (VP: observed; EV: one documented sibling fetch per resolve)
  → listings flow back → aggregate over scopedListings (zone branch)
       using pointInMultiPolygon
```

## Compliance

Unchanged and preserved:

- **Permissions stay exactly `["sidePanel"]`.** No new permissions.
- **Nothing persisted.** `ns-municipalities.json` is a bundled static asset read
  at runtime, not `chrome.storage`. No new persistence.
- **No new request paths on either site.** Panning to a region triggers only the
  page's own listing requests — passively observed on ViewPoint, and on EV the
  single already-documented `get-listing` sibling fetch per map resolve. The
  build-time Socrata fetch runs on the developer's machine, never in the shipped
  extension.
- CSV export, EULA gate, and aggregate logic are untouched.

## Testing

- `scripts/boundaries/__tests__/simplify.test.ts` — RDP correctness: endpoints
  preserved, collinear points removed, tolerance monotonicity, degenerate ring
  (<3 pts) handling.
- A transform test (feature → `RegionRecord`) against a small inline GeoJSON
  fixture: `[lng,lat]`→`[lat,lng]`, hole preservation, bbox computation,
  sub-3-vertex part dropping.
- `geofence.test.ts` — add `pointInMultiPolygon` cases: point in a secondary
  part (island), point inside a hole (excluded), point outside all parts.
- `coverage.test.ts` — multipolygon area (outer minus holes); coverage over a
  multi-part zone.
- `store.test.ts` — zone scoping with a `ZoneShape` (in-part vs in-hole vs
  outside).

Per project rules, the pure `lib/` and `scripts/boundaries/` modules are
unit-tested; the overlay, relays, and Preact components remain without automated
tests.

## Out of scope

- Editing predefined region boundaries.
- Boundary data for provinces other than Nova Scotia.
- Persisting the last-selected region across sessions (nothing is persisted).
- Sub-municipal boundaries (neighbourhoods, dissemination areas).
