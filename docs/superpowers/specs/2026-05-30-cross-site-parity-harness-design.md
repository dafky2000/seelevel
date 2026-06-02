# Cross-site parity harness (EV ↔ ViewPoint)

Date: 2026-05-30 Status: design approved, pending implementation plan

## Problem

SeeLevel renders the same analytics over two sites — ViewPoint.ca and Engel &
Völkers Nova Scotia — both of which surface Nova Scotia MLS data. The two feeds
should produce comparable "for sale" and "sold" figures for the same geographic
area and filter, because they draw on the same underlying MLS. We want a way to
verify that on demand: drive both sites to the same viewport/zone + filter, then
compare the rolled-up numbers.

The shared `aggregate()` path already guarantees the _logic_ is identical for
both sites. The remaining risk is at the edges: the per-site parse layer, the
scope layer, and — most of all — whether the live sites actually return
equivalent data for the same area. That last part is inherently live, so this is
**not** a deterministic CI test of the sites. Instead we make the _comparison
logic_ pure and unit-tested, and capture the live numbers through a dev-only
hook driven by a documented Chrome DevTools procedure.

## Goals

- Compare EV and ViewPoint aggregates for the same viewport/zone + filter and
  report where they diverge.
- Express parity as a **delta table** (both values, absolute Δ, relative Δ) per
  figure — primary output, shown regardless of pass/fail. Tolerance is an
  optional advisory overlay, not yet a committed threshold (we settle it after
  observing real runs).
- Drive both maps to the same viewport (and zone) at the press of a button, so
  alignment is exact rather than eyeballed.
- Ship **nothing** of this in the packaged build: every capability is
  `__DEV__`-gated and dead-code-eliminated by `--prod`.

## Non-goals

- No automatic continuous syncing — sync is an explicit, triggered action.
- No exact set-equality check by MLS number, and no aggregate-tolerance gating
  baked in yet (we observe first, then decide on a threshold).
- No committed-fixture parity test — the value is on-demand live verification.
- No new manifest permissions, no persistence, no new ViewPoint request paths.

## Parity target

Aggregate parity within an (eventual) tolerance. We compare rolled-up figures,
not individual listings. Both sites expose the MLS number as `listing_id`, but
we deliberately do not require set equality — coverage between an IDX feed and a
brokerage site legitimately differs.

## Architecture

### Capture point — one hook on the panel window

The single side-panel instance already holds a `TabStore` per open ViewPoint/EV
tab in its `Map<tabId, TabStore>`. So capture needs to reach only **one page**
(the panel), and it returns one snapshot per known tab:

```ts
// Installed on the panel window ONLY when __DEV__ (stripped by --prod).
window.__seelevelSnapshot(): ParitySnapshot[]
```

```ts
interface ParitySnapshot {
  tabId: number;
  host: string | null; // "viewpoint.ca" | "...engelvoelkersnovascotia.com"
  scope: ScopeKey; // viewport | session | zone
  searchStatus: SearchStatus; // any | active | sold
  windowSize: WindowSize;
  loading: boolean; // a slim sibling / page fetch is in flight
  bbox: BBox | null; // to confirm the two viewports line up
  polygon: [number, number][] | null;
  figures: ParityFigures;
}
```

### Figures — derived from the scoped listings of the latest complete bucket

Figures are computed from `scopedListings(store)` (so they respect
viewport/zone/session scope) for the **latest complete bucket** of the current
window — matching the panel's own headline figures. They reuse the existing
`aggregate()` and `priceHistogram()` so the snapshot reflects exactly what the
panel shows.

```ts
interface ParityFigures {
  scopedCount: number; // listings in scope, any status (whole scope)
  listedCount: number; // list-side count, latest complete bucket
  soldCount: number; // sold-side count, latest complete bucket
  soldVolume: number; // Σ sold_price, latest complete bucket
  listAvg: number | null;
  listMedian: number | null;
  soldAvg: number | null;
  soldMedian: number | null;
  histogram: { label: string; listCount: number; soldCount: number }[];
}
```

The bucket selection follows `aggregate()`'s own rule: the most recent
non-partial bucket, falling back to the last bucket if every bucket is still
partial.

### The pure comparator

`src/panel/lib/parity.ts` — no Chrome/DOM dependencies, fully unit-tested:

```ts
buildFigures(store: TabStore): ParityFigures
compareAggregates(a: ParitySnapshot, b: ParitySnapshot, tol?: Tolerance): ParityReport
```

```ts
interface Tolerance {
  relPct: number;
  absFloor: number;
}
// Loose default while we gather data; `pass` is advisory only.
const DEFAULT_TOL: Tolerance = { relPct: 0.10, absFloor: 2 };
// A figure "passes" if |Δ| ≤ max(absFloor, relPct · max(|a|, |b|)).
```

```ts
interface FigureDelta {
  key: string; // "soldVolume", "soldAvg", "hist:$300k–$325k", …
  a: number | null;
  b: number | null;
  absDelta: number | null; // |a − b|, null if either side null
  relDelta: number | null; // absDelta / max(|a|,|b|), null if base 0/null
  pass: boolean; // advisory, against tol
}

interface ParityReport {
  aligned: boolean; // bbox/scope/searchStatus/windowSize all match
  alignment: { // why aligned is false, when it is
    scopeMatch: boolean;
    statusMatch: boolean;
    windowMatch: boolean;
    bboxMatch: boolean; // bboxes equal within an epsilon
  };
  deltas: FigureDelta[]; // every figure + every histogram bin
}
```

Histogram bins are compared by **label** (the `$25k`-step / capped-tail labels
are deterministic for a given data range). A bin present on only one side
appears as a delta with the missing side `null` and `pass:false`.

`aligned` is reported first because a parity gap most often means the two
viewports were not actually lined up; the report says so before any figure delta
is interpreted.

## Driving the maps (dev-gated)

Both sites run `google.maps` through `src/content/shared/google-maps-hook.ts`,
which already holds the live instance in `currentMap`. Driving the viewport is
therefore one uniform code path — no per-adapter map-driving code.

### Viewport sync — full path

1. `window.__seelevelSync({ from, to, what })` on the panel reads the source
   tab's `bbox` (and `polygon`) from its store. `from`/`to` are tab ids; default
   direction is ViewPoint → EV (the fuller feed drives the brokerage site).
   `what` ∈ `"viewport" | "zone" | "both"`.
2. Panel sends a dev-only downward message `{ type: "drive_viewport", bbox }` →
   SW → target relay, over the existing `PanelToContent` port path that already
   carries `clear_zone` / `zone_prompt`.
3. Target relay dispatches a MAIN-world `seelevel:drive` CustomEvent (ISOLATED →
   MAIN over the shared DOM — the reverse of the existing `seelevel:bbox` flow;
   `detail` is a plain object and structured-clones fine).
4. The shared google-maps-hook listens for `seelevel:drive` and calls
   `currentMap.fitBounds({north,south,east,west})`. The map's own `idle` →
   `emitBbox` → the page's natural fetch chain then runs exactly as if the user
   had panned there (ViewPoint: its own search XHR; EV: the page's
   get-ev-listing, which triggers the one documented slim sibling per resolve).

### Zone sync

ISOLATED-only. Target relay receives `{ type: "drive_zone", polygon }` and calls
a new `setZone(polygon)` on the geofence overlay, which renders the
Leaflet/Geoman polygon and fires the existing `onZoneChange` → the target
store's `polygon` updates. When `what` includes `"zone"`, `__seelevelSync` first
drives the target viewport to the polygon's bounding box so the page fetches the
area the zone covers, then sends `drive_zone`.

### The "button"

The hook call is the button. The DevTools procedure calls `__seelevelSync`,
waits for the target to settle (`wait_for` / poll `__seelevelSnapshot()` until
the target tab's `bbox` matches the driven bbox and `loading` is false), then
captures both snapshots and runs `compareAggregates`.

## Compliance — the load-bearing gating

Every drive and capture path is wrapped in `if (__DEV__)`:

- the panel installers for `__seelevelSnapshot` / `__seelevelSync`,
- the panel sender for `drive_viewport` / `drive_zone`,
- both relays' `drive_*` message handlers,
- the MAIN-world `seelevel:drive` listener in the google-maps-hook.

`build.ts` defines `__DEV__` as `true` for the dev build and `false` for
`--prod`. With `__DEV__ = false`, esbuild dead-code-eliminates all of the above,
so the packaged Web Store build:

- never gains the ability to drive the page (stays purely passive),
- keeps manifest permissions exactly `["sidePanel"]`,
- adds no persistence and no new request paths.

The only network effects in dev are the page's own fetches that a real pan would
also cause — on EV, the same one documented sibling `get-listing` per resolve.

## Files

- `src/panel/lib/parity.ts` — pure `buildFigures` + `compareAggregates`.
- `src/panel/lib/__tests__/parity.test.ts` — delta math; abs-floor/rel-pct
  boundary; histogram label diff incl. bin-on-one-side-only; `aligned` mismatch
  flag; latest-complete-bucket selection.
- `src/panel/App.tsx` — `if (__DEV__)` install `window.__seelevelSnapshot` and
  `window.__seelevelSync` (reading the tab-store map; sending `drive_*`).
- `src/content/relay.ts` + `src/content/ev/relay.ts` — `if (__DEV__)` handlers
  for `drive_viewport` (→ `seelevel:drive` CustomEvent) and `drive_zone` (→
  overlay `setZone`).
- `src/content/shared/google-maps-hook.ts` — `if (__DEV__)` listener for
  `seelevel:drive` that calls `currentMap.fitBounds`.
- `src/content/geofence-overlay.ts` — add `setZone(polygon)` matching the
  module's existing Leaflet/Geoman patterns.
- `src/types.ts` — add dev-only `PanelToContent` variants `drive_viewport` /
  `drive_zone`, and a `seelevel:drive` entry in `EVT`.
- `build.ts` — add the `__DEV__` define to all four bundles; add a
  `declare const __DEV__: boolean` ambient declaration.

## DevTools procedure

1. Open a ViewPoint `/map` tab and an EV `/map` tab; open the side panel.
2. Pan/zoom each map roughly to the target area so each page begins fetching.
3. Pick scope + status filter + window in the panel (or draw a zone on one
   site).
4. `select_page` → the panel page.
5. `evaluate_script: __seelevelSync({ from: <viewpoint tabId>, to: <ev tabId>, what: "both" })`.
6. `wait_for` / poll `__seelevelSnapshot()` until the EV tab's `bbox` matches
   the driven bbox and its `loading` is false.
7. `evaluate_script: __seelevelSnapshot()` → both snapshots.
8. Run `compareAggregates(viewpointSnap, evSnap)` and print the report —
   `aligned` first, then the delta table.

## Testing

- Unit tests for the pure core (`parity.test.ts`) — see Files.
- A live run across 2–3 real Nova Scotia areas (e.g. central Halifax for-sale,
  then sold) to observe where the numbers actually land. That data is what we
  use to settle the tolerance — at which point `pass` graduates from advisory to
  a recorded threshold in this doc.
- Full suite + a `--prod` build to confirm the harness is fully stripped (grep
  the prod bundles for `__seelevelSnapshot` / `seelevel:drive` → no matches).
