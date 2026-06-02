# Cross-site Parity Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `__DEV__`-gated harness that captures EV and ViewPoint aggregate figures for the same viewport/zone + filter, drives the two maps into alignment at a single hook call, and reports per-figure deltas — with the entire harness stripped from the packaged (`--prod`) build.

**Architecture:** A pure, unit-tested core (`src/panel/lib/parity.ts`: `buildFigures` + `compareAggregates`) does all the math. The side panel — which already holds a `TabStore` per open tab — installs two dev-only `window` hooks (`__seelevelSnapshot`, `__seelevelSync`). `__seelevelSync` sends new dev-only `drive_viewport` / `drive_zone` port messages to the target tab's relay; the relay drives the shared `google.maps` instance via `currentMap.fitBounds` (both sites use the same hook) and renders the synced zone via a new `setZone` on the geofence overlay. Every dev-only path is wrapped so `esbuild`'s `__DEV__ = false` define dead-code-eliminates it under `--prod`.

**Tech Stack:** Deno + esbuild + Preact; `google.maps`; Leaflet + Geoman (zone overlay); tests use `jsr:@std/assert@1` via `deno test`.

**Spec:** `docs/superpowers/specs/2026-05-30-cross-site-parity-harness-design.md`

---

## File Structure

- **Create** `src/panel/lib/parity.ts` — pure core: `ParityFigures`, `ParitySnapshot`, `Tolerance`, `FigureDelta`, `ParityReport`, `buildFigures()`, `compareAggregates()`, `DEFAULT_TOL`.
- **Create** `src/panel/lib/__tests__/parity.test.ts` — unit tests for the pure core.
- **Modify** `src/types.ts` — add `drive_viewport` / `drive_zone` to `PanelToContent`; add `drive` to `EVT`.
- **Modify** `build.ts` — add the `__DEV__` esbuild define to every bundle.
- **Modify** `src/content/shared/google-maps-hook.ts` — dev-gated `seelevel:drive` listener calling `currentMap.fitBounds`.
- **Modify** `src/content/geofence-overlay.ts` — add `setZone(polygon)`.
- **Modify** `src/content/relay.ts` + `src/content/ev/relay.ts` — dev-gated `drive_viewport` / `drive_zone` handlers.
- **Modify** `src/panel/App.tsx` — dev-gated install of `__seelevelSnapshot` / `__seelevelSync` + `buildSnapshot` / `polygonBbox` helpers.

The pure core (`parity.ts`) carries every behaviour that can be tested without Chrome/DOM. The wiring tasks (build define, relays, hook, overlay, App) have no unit tests by project convention (content scripts and Preact components are not unit-tested here) — they are verified by a clean build, the `--prod` strip grep, and the manual DevTools procedure in the spec.

---

### Task 1: Add the `__DEV__` build define

**Files:**
- Modify: `build.ts:75-84` (the `shared` options) and `build.ts:105-113` (the panel build's `define`)

- [ ] **Step 1: Add `__DEV__` to the shared esbuild options**

In `build.ts`, the `shared` object currently ends at the `loader` line. Add a `define` key so every bundle gets `__DEV__`:

```ts
const shared: esbuild.BuildOptions = {
  bundle: true,
  minify: isProd,
  sourcemap: isProd ? false : "inline",
  plugins: [
    npmCssPlugin,
    ...denoPlugins({ configPath: join(dir, "deno.json") }),
  ],
  loader: { ".css": "text" },
  // Dev-only harness gating: true for dev builds, false for --prod/--package.
  // esbuild substitutes the literal, so `if (__DEV__)` blocks are
  // dead-code-eliminated from the packaged build.
  define: { __DEV__: JSON.stringify(!isProd) },
};
```

- [ ] **Step 2: Keep both defines on the panel build**

The panel build spreads `...shared` then sets its own `define`, which would otherwise clobber the shared `__DEV__`. Change its `define` to include both (replace the existing `define: { __EXT_VERSION__: JSON.stringify(version) },` line):

```ts
    define: {
      __DEV__: JSON.stringify(!isProd),
      __EXT_VERSION__: JSON.stringify(version),
    },
```

- [ ] **Step 3: Verify a dev build still succeeds**

Run: `deno run -A build.ts`
Expected: prints `Build complete.` with no errors. (`__DEV__` is defined but not yet referenced — harmless.)

- [ ] **Step 4: Commit**

```bash
git add build.ts
git commit -m "Add __DEV__ esbuild define for the dev-only parity harness"
```

---

### Task 2: Pure core — `buildFigures`

**Files:**
- Create: `src/panel/lib/parity.ts`
- Test: `src/panel/lib/__tests__/parity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/panel/lib/__tests__/parity.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { buildFigures } from "../parity.ts";
import type { Bucket } from "../bucket.ts";
import type { ListingRow } from "../../../types.ts";

// Minimal ListingRow factory — only the fields the price/volume series read.
function row(p: Partial<ListingRow>): ListingRow {
  return {
    id: p.id ?? "x",
    listing_id: p.listing_id ?? "",
    class_id: 0,
    status_id: p.status_id ?? 1,
    list_price: p.list_price ?? null,
    sold_price: p.sold_price ?? null,
    close_dt: p.close_dt ?? null,
    list_dt: p.list_dt ?? null,
    sold_dt: p.sold_dt ?? null,
    tla: p.tla ?? null,
    pid: p.pid ?? null,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
  };
}

// One complete April-2026 bucket.
const APRIL: Bucket = {
  start: new Date(2026, 3, 1),
  end: new Date(2026, 4, 1),
  label: "2026-04-01 → 2026-05-01",
  isPartial: false,
};

Deno.test("buildFigures — counts, volume, and averages for the bucket", () => {
  const listings: ListingRow[] = [
    // listed in April, still active
    row({ id: "a", status_id: 1, list_dt: "2026-04-10", list_price: 300000 }),
    // listed AND sold in April
    row({
      id: "b",
      status_id: 2,
      list_dt: "2026-04-02",
      list_price: 420000,
      sold_dt: "2026-04-15",
      sold_price: 400000,
    }),
    // sold in April, no list_dt
    row({ id: "c", status_id: 2, sold_dt: "2026-04-20", sold_price: 500000 }),
  ];

  const f = buildFigures(listings, [APRIL], null);

  assertEquals(f.scopedCount, 3);
  assertEquals(f.listedCount, 2); // a, b have list_dt in April
  assertEquals(f.soldCount, 2); // b, c sold in April
  assertEquals(f.listAvg, 360000); // (300000 + 420000) / 2
  assertEquals(f.soldAvg, 450000); // (400000 + 500000) / 2
  assertEquals(f.soldVolume, 900000); // 400000 + 500000
  // Histogram has bins and the sold counts across bins total the sold sample.
  const soldTotal = f.histogram.reduce((n, b) => n + b.soldCount, 0);
  assertEquals(soldTotal, 2);
});

Deno.test("buildFigures — empty input yields zeroed figures", () => {
  const f = buildFigures([], [APRIL], null);
  assertEquals(f.scopedCount, 0);
  assertEquals(f.listedCount, 0);
  assertEquals(f.soldCount, 0);
  assertEquals(f.soldVolume, 0);
  assertEquals(f.listAvg, null);
  assertEquals(f.soldAvg, null);
  assertEquals(f.histogram, []);
});

Deno.test("buildFigures — picks the latest complete bucket", () => {
  const MAY_PARTIAL: Bucket = {
    start: new Date(2026, 4, 1),
    end: new Date(2026, 5, 1),
    label: "May",
    isPartial: true,
  };
  // A May-sold listing must NOT count — only the latest COMPLETE bucket (April).
  const listings = [
    row({ id: "b", status_id: 2, sold_dt: "2026-04-15", sold_price: 400000 }),
    row({ id: "m", status_id: 2, sold_dt: "2026-05-15", sold_price: 999000 }),
  ];
  const f = buildFigures(listings, [APRIL, MAY_PARTIAL], null);
  assertEquals(f.soldCount, 1);
  assertEquals(f.soldVolume, 400000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test -A src/panel/lib/__tests__/parity.test.ts`
Expected: FAIL — `Module not found` / `buildFigures is not exported` (parity.ts does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/panel/lib/parity.ts`:

```ts
import type { ListingRow } from "../../types.ts";
import type { Bucket } from "./bucket.ts";
import type { SeriesSide } from "./aggregate.ts";
import { aggregate } from "./aggregate.ts";
import { priceHistogram } from "./histogram.ts";

// Rolled-up figures for the latest complete bucket of one tab's scoped
// listings. Counts come from the Volume series (listings with a list/sold date
// in the window); the averages/medians and the per-listing sold volume come
// from the Price series (listings with a non-null price). soldVolume is the sum
// of known sold prices = soldAvg × (#priced solds), so it can be <= soldCount's
// worth of listings when some sold rows carry no price.
export interface ParityFigures {
  scopedCount: number;
  listedCount: number;
  soldCount: number;
  soldVolume: number;
  listAvg: number | null;
  listMedian: number | null;
  soldAvg: number | null;
  soldMedian: number | null;
  histogram: { label: string; listCount: number; soldCount: number }[];
}

function emptyFigures(scopedCount: number): ParityFigures {
  return {
    scopedCount,
    listedCount: 0,
    soldCount: 0,
    soldVolume: 0,
    listAvg: null,
    listMedian: null,
    soldAvg: null,
    soldMedian: null,
    histogram: [],
  };
}

// Same rule aggregate() uses for its headline figure: the most recent
// non-partial bucket, falling back to the last bucket if all are partial.
function latestComplete(buckets: Bucket[]): Bucket | null {
  const complete = buckets.filter((b) => !b.isPartial);
  if (complete.length > 0) return complete[complete.length - 1];
  return buckets[buckets.length - 1] ?? null;
}

// Pure: figures for the latest complete bucket. `side` filters the histogram
// only (matching the panel's "for sale"/"sold" treatment); the scalar stats
// always carry both sides so the diff shows everything.
export function buildFigures(
  listings: ListingRow[],
  buckets: Bucket[],
  side: SeriesSide[] | null,
): ParityFigures {
  const bucket = latestComplete(buckets);
  if (!bucket) return emptyFigures(listings.length);

  const vol = aggregate(listings, "volume", [bucket]).series;
  const price = aggregate(listings, "price", [bucket]).series;
  const listVol = vol.find((s) => s.side === "list")?.buckets[0] ?? null;
  const soldVol = vol.find((s) => s.side === "sold")?.buckets[0] ?? null;
  const listPrice = price.find((s) => s.side === "list")?.buckets[0] ?? null;
  const soldPrice = price.find((s) => s.side === "sold")?.buckets[0] ?? null;

  const soldAvg = soldPrice?.avg ?? null;
  const soldVolume = soldAvg !== null
    ? Math.round(soldAvg * (soldPrice?.count ?? 0))
    : 0;

  const hist = priceHistogram(listings, bucket, side, 20);
  const listIdx = hist.seriesLabels.indexOf("List");
  const soldIdx = hist.seriesLabels.indexOf("Sold");
  const histogram = hist.bins.map((b) => ({
    label: b.label,
    listCount: listIdx >= 0 ? b.counts[listIdx] : 0,
    soldCount: soldIdx >= 0 ? b.counts[soldIdx] : 0,
  }));

  return {
    scopedCount: listings.length,
    listedCount: listVol?.count ?? 0,
    soldCount: soldVol?.count ?? 0,
    soldVolume,
    listAvg: listPrice?.avg ?? null,
    listMedian: listPrice?.median ?? null,
    soldAvg,
    soldMedian: soldPrice?.median ?? null,
    histogram,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test -A src/panel/lib/__tests__/parity.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/panel/lib/parity.ts src/panel/lib/__tests__/parity.test.ts
git commit -m "Add pure buildFigures for the parity harness"
```

---

### Task 3: Pure core — `compareAggregates`

**Files:**
- Modify: `src/panel/lib/parity.ts`
- Test: `src/panel/lib/__tests__/parity.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/panel/lib/__tests__/parity.test.ts`:

```ts
import { compareAggregates } from "../parity.ts";
import type { ParityFigures, ParitySnapshot } from "../parity.ts";
import type { BBox } from "../../../types.ts";

const BBOX: BBox = { sw_lat: 44.6, sw_lng: -63.6, ne_lat: 44.7, ne_lng: -63.5 };

function figs(p: Partial<ParityFigures> = {}): ParityFigures {
  return {
    scopedCount: 10,
    listedCount: 4,
    soldCount: 4,
    soldVolume: 1_600_000,
    listAvg: 400000,
    listMedian: 390000,
    soldAvg: 400000,
    soldMedian: 395000,
    histogram: [{ label: "$300k–400k", listCount: 4, soldCount: 4 }],
    ...p,
  };
}

function snap(p: Partial<ParitySnapshot> = {}): ParitySnapshot {
  return {
    tabId: 1,
    host: "viewpoint.ca",
    scope: "viewport",
    searchStatus: "any",
    windowSize: "monthly",
    loading: false,
    bbox: BBOX,
    polygon: null,
    figures: figs(),
    ...p,
  };
}

Deno.test("compareAggregates — identical snapshots: aligned, all pass", () => {
  const r = compareAggregates(snap({ host: "viewpoint.ca" }), snap({ host: "ev" }));
  assertEquals(r.aligned, true);
  assertEquals(r.deltas.every((d) => d.pass), true);
});

Deno.test("compareAggregates — soldVolume beyond tolerance fails that row", () => {
  const a = snap();
  const b = snap({ figures: figs({ soldVolume: 2_400_000 }) }); // +50%
  const r = compareAggregates(a, b);
  const sv = r.deltas.find((d) => d.key === "soldVolume")!;
  assertEquals(sv.pass, false);
  assertEquals(sv.absDelta, 800000);
});

Deno.test("compareAggregates — small count diff passes via absFloor", () => {
  const a = snap({ figures: figs({ soldCount: 1 }) });
  const b = snap({ figures: figs({ soldCount: 2 }) }); // diff 1 <= absFloor 2
  const r = compareAggregates(a, b);
  const sc = r.deltas.find((d) => d.key === "soldCount")!;
  assertEquals(sc.pass, true);
});

Deno.test("compareAggregates — one-sided null fails with null delta", () => {
  const a = snap({ figures: figs({ soldAvg: 400000 }) });
  const b = snap({ figures: figs({ soldAvg: null }) });
  const r = compareAggregates(a, b);
  const d = r.deltas.find((x) => x.key === "soldAvg")!;
  assertEquals(d.pass, false);
  assertEquals(d.absDelta, null);
});

Deno.test("compareAggregates — histogram bin on one side only", () => {
  const a = snap();
  const b = snap({ figures: figs({ histogram: [] }) });
  const r = compareAggregates(a, b);
  const d = r.deltas.find((x) => x.key === "hist:$300k–400k:list")!;
  assertEquals(d.a, 4);
  assertEquals(d.b, null);
  assertEquals(d.pass, false);
});

Deno.test("compareAggregates — window mismatch breaks alignment", () => {
  const r = compareAggregates(snap(), snap({ windowSize: "weekly" }));
  assertEquals(r.aligned, false);
  assertEquals(r.alignment.windowMatch, false);
  assertEquals(r.alignment.scopeMatch, true);
});

Deno.test("compareAggregates — zone scope compares polygons for alignment", () => {
  const poly: [number, number][] = [[44.6, -63.6], [44.7, -63.6], [44.7, -63.5]];
  const a = snap({ scope: "zone", polygon: poly, bbox: null });
  const b = snap({ scope: "zone", polygon: poly, bbox: BBOX });
  const r = compareAggregates(a, b);
  assertEquals(r.alignment.bboxMatch, true); // polygons match → bounds match
  assertEquals(r.aligned, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test -A src/panel/lib/__tests__/parity.test.ts`
Expected: FAIL — `compareAggregates is not exported` and `ParitySnapshot` type missing.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/panel/lib/parity.ts`:

```ts
import type { BBox, ScopeKey, SearchStatus, WindowSize } from "../../types.ts";

// A captured snapshot of one tab, returned by window.__seelevelSnapshot().
export interface ParitySnapshot {
  tabId: number;
  host: string | null;
  scope: ScopeKey;
  searchStatus: SearchStatus;
  windowSize: WindowSize;
  loading: boolean;
  bbox: BBox | null;
  polygon: [number, number][] | null;
  figures: ParityFigures;
}

export interface Tolerance {
  relPct: number;
  absFloor: number;
}
// Loose default while we gather data from real runs. `pass` is advisory only.
export const DEFAULT_TOL: Tolerance = { relPct: 0.10, absFloor: 2 };

export interface FigureDelta {
  key: string;
  a: number | null;
  b: number | null;
  absDelta: number | null;
  relDelta: number | null;
  pass: boolean;
}

export interface ParityReport {
  aligned: boolean;
  alignment: {
    scopeMatch: boolean;
    statusMatch: boolean;
    windowMatch: boolean;
    bboxMatch: boolean; // bbox (or, in zone scope, polygon) match within epsilon
  };
  deltas: FigureDelta[];
}

const BOUNDS_EPS = 1e-4; // ~11 m; lat/lng degrees

function figDelta(
  key: string,
  a: number | null,
  b: number | null,
  tol: Tolerance,
): FigureDelta {
  if (a === null || b === null) {
    return { key, a, b, absDelta: null, relDelta: null, pass: a === b };
  }
  const absDelta = Math.abs(a - b);
  const base = Math.max(Math.abs(a), Math.abs(b));
  const relDelta = base === 0 ? 0 : absDelta / base;
  const pass = absDelta <= Math.max(tol.absFloor, tol.relPct * base);
  return { key, a, b, absDelta, relDelta, pass };
}

function approxBboxEqual(a: BBox | null, b: BBox | null): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.sw_lat - b.sw_lat) < BOUNDS_EPS &&
    Math.abs(a.sw_lng - b.sw_lng) < BOUNDS_EPS &&
    Math.abs(a.ne_lat - b.ne_lat) < BOUNDS_EPS &&
    Math.abs(a.ne_lng - b.ne_lng) < BOUNDS_EPS
  );
}

function approxPolyEqual(
  a: [number, number][] | null,
  b: [number, number][] | null,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) =>
    Math.abs(p[0] - b[i][0]) < BOUNDS_EPS &&
    Math.abs(p[1] - b[i][1]) < BOUNDS_EPS
  );
}

function binVal(
  figures: ParityFigures,
  label: string,
  key: "listCount" | "soldCount",
): number | null {
  const bin = figures.histogram.find((h) => h.label === label);
  return bin ? bin[key] : null;
}

// Pure: compare two snapshots figure-by-figure. `aligned` is reported first
// because a parity gap most often just means the viewports weren't lined up.
export function compareAggregates(
  a: ParitySnapshot,
  b: ParitySnapshot,
  tol: Tolerance = DEFAULT_TOL,
): ParityReport {
  const bothZone = a.scope === "zone" && b.scope === "zone";
  const boundsMatch = bothZone
    ? approxPolyEqual(a.polygon, b.polygon)
    : approxBboxEqual(a.bbox, b.bbox);

  const alignment = {
    scopeMatch: a.scope === b.scope,
    statusMatch: a.searchStatus === b.searchStatus,
    windowMatch: a.windowSize === b.windowSize,
    bboxMatch: boundsMatch,
  };
  const aligned = alignment.scopeMatch && alignment.statusMatch &&
    alignment.windowMatch && alignment.bboxMatch;

  const scalarKeys: (keyof ParityFigures)[] = [
    "scopedCount",
    "listedCount",
    "soldCount",
    "soldVolume",
    "listAvg",
    "listMedian",
    "soldAvg",
    "soldMedian",
  ];
  const deltas: FigureDelta[] = scalarKeys.map((k) =>
    figDelta(
      k,
      a.figures[k] as number | null,
      b.figures[k] as number | null,
      tol,
    )
  );

  // Histogram: union of bin labels (a's order first, then b-only), two deltas
  // per bin. A bin present on only one side yields a null on the other.
  const labels: string[] = [];
  for (const h of a.figures.histogram) labels.push(h.label);
  for (const h of b.figures.histogram) {
    if (!labels.includes(h.label)) labels.push(h.label);
  }
  for (const label of labels) {
    deltas.push(figDelta(
      `hist:${label}:list`,
      binVal(a.figures, label, "listCount"),
      binVal(b.figures, label, "listCount"),
      tol,
    ));
    deltas.push(figDelta(
      `hist:${label}:sold`,
      binVal(a.figures, label, "soldCount"),
      binVal(b.figures, label, "soldCount"),
      tol,
    ));
  }

  return { aligned, alignment, deltas };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test -A src/panel/lib/__tests__/parity.test.ts`
Expected: PASS — all tests (3 from Task 2 + 7 from Task 3) pass.

- [ ] **Step 5: Commit**

```bash
git add src/panel/lib/parity.ts src/panel/lib/__tests__/parity.test.ts
git commit -m "Add pure compareAggregates for the parity harness"
```

---

### Task 4: Wire types — dev-only port messages + EVT.drive

**Files:**
- Modify: `src/types.ts:72-74` (`PanelToContent`) and `src/types.ts:150-157` (`EVT`)

- [ ] **Step 1: Add the dev-only `PanelToContent` variants**

Replace the `PanelToContent` union (currently `clear_zone` + `zone_prompt`) with:

```ts
export type PanelToContent =
  | { type: "clear_zone" }
  | { type: "zone_prompt"; active: boolean }
  // Dev-only (parity harness): drive the page's map / zone. Only ever SENT by
  // the __DEV__-gated panel hooks and only HANDLED by __DEV__-gated relay code,
  // so --prod strips every producer and consumer even though the type remains.
  | { type: "drive_viewport"; bbox: BBox }
  | { type: "drive_zone"; polygon: [number, number][] };
```

- [ ] **Step 2: Add the `drive` event name**

In the `EVT` object, add the `drive` entry (ISOLATED → MAIN, the reverse of `bbox`):

```ts
export const EVT = {
  listings: "seelevel:listings",
  bbox: "seelevel:bbox",
  mapbusy: "seelevel:mapbusy",
  oversize: "seelevel:oversize",
  clearSession: "seelevel:clear-session",
  loadingState: "seelevel:loading-state",
  drive: "seelevel:drive",
} as const;
```

- [ ] **Step 3: Verify types still check**

Run: `deno check src/types.ts`
Expected: no errors. (`BBox` is already defined in this file, so the new variant resolves.)

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "Add dev-only drive_viewport/drive_zone messages and EVT.drive"
```

---

### Task 5: Dev-gated map driver in the shared google.maps hook

**Files:**
- Modify: `src/content/shared/google-maps-hook.ts`

- [ ] **Step 1: Import `BBox` and declare `__DEV__`**

At the top of the file, the existing import is `import { EVT } from "../../types.ts";`. Change it to also bring in `BBox`, and add the ambient `__DEV__` declaration (mirrors `Disclaimer.tsx`'s `__EXT_VERSION__` pattern):

```ts
import { EVT } from "../../types.ts";
import type { BBox } from "../../types.ts";

declare const __DEV__: boolean;
```

- [ ] **Step 2: Register the dev-only drive listener inside `installGoogleMapsHook`**

The listener must close over `currentMap`, so it goes inside `installGoogleMapsHook`. Immediately after the `fastPatchPoll();` call (around line 167, before the `isAlive` helper), add:

```ts
  // ── Dev-only: drive the map to a requested bbox (parity harness) ─────────
  // ISOLATED relay dispatches seelevel:drive; we fitBounds the live instance.
  // Stripped from --prod (__DEV__ === false → dead code).
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    document.addEventListener(EVT.drive, (e) => {
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
  }
```

- [ ] **Step 3: Verify a dev build succeeds**

Run: `deno run -A build.ts`
Expected: `Build complete.` with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/content/shared/google-maps-hook.ts
git commit -m "Add dev-gated seelevel:drive map driver to the google.maps hook"
```

---

### Task 6: `setZone` on the geofence overlay

**Files:**
- Modify: `src/content/geofence-overlay.ts`

- [ ] **Step 1: Add `setZone` next to `getCurrentPolygon`**

After `getCurrentPolygon()` (around line 445), add an exported `setZone` that renders a polygon programmatically and routes it through the existing `onPolygonCreated` (which styles it, enables Geoman editing, and fires `onZoneChange`):

```ts
// Programmatically render a zone polygon (parity harness drive_zone). Reuses
// onPolygonCreated so the synced zone behaves exactly like a hand-drawn one —
// styled, editable, and propagated to the panel via onZoneChange.
export function setZone(polygon: [number, number][]): void {
  if (!leafletMap || polygon.length < 3) return;
  if (drawing) endDraw(false);
  if (drawnLayer) {
    leafletMap.removeLayer(drawnLayer);
    drawnLayer = null;
  }
  const poly = L.polygon(
    polygon.map(([lat, lng]) => [lat, lng] as L.LatLngTuple),
  );
  poly.addTo(leafletMap);
  onPolygonCreated(poly);
}
```

- [ ] **Step 2: Verify a dev build succeeds**

Run: `deno run -A build.ts`
Expected: `Build complete.` with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/content/geofence-overlay.ts
git commit -m "Add setZone to geofence overlay for programmatic zone sync"
```

---

### Task 7: Dev-gated drive handlers in both relays

**Files:**
- Modify: `src/content/relay.ts:16-24` (imports) and `src/content/relay.ts:63-69` (message handler)
- Modify: `src/content/ev/relay.ts:11-19` (imports) and `src/content/ev/relay.ts:45-51` (message handler)

- [ ] **Step 1: ViewPoint relay — import `setZone` and declare `__DEV__`**

In `src/content/relay.ts`, add `setZone` to the geofence-overlay import list (it currently imports `clearZone, getCurrentPolygon, initGeofenceOverlay, setDrawPrompt, setOnZoneChange, setOverlayVisible, syncMapView`):

```ts
import {
  clearZone,
  getCurrentPolygon,
  initGeofenceOverlay,
  setDrawPrompt,
  setOnZoneChange,
  setOverlayVisible,
  setZone,
  syncMapView,
} from "./geofence-overlay.ts";
```

Then add the ambient declaration just below the import block (e.g. after the `EVT` import line):

```ts
declare const __DEV__: boolean;
```

- [ ] **Step 2: ViewPoint relay — handle the drive messages**

In `openPort()`, the inbound `msg` handler currently branches on `zone_prompt` and `clear_zone`. Extend it:

```ts
    if (msg.type === "msg") {
      if (msg.payload.type === "zone_prompt") {
        setDrawPrompt(msg.payload.active);
      } else if (msg.payload.type === "clear_zone") {
        clearZone();
      } else if (msg.payload.type === "drive_viewport") {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          document.dispatchEvent(
            new CustomEvent(EVT.drive, { detail: { bbox: msg.payload.bbox } }),
          );
        }
      } else if (msg.payload.type === "drive_zone") {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          setZone(msg.payload.polygon);
        }
      }
    }
```

- [ ] **Step 3: EV relay — same import, declaration, and handler**

In `src/content/ev/relay.ts`, add `setZone` to its geofence-overlay import (currently `clearZone, getCurrentPolygon, initGeofenceOverlay, setDrawPrompt, setOnZoneChange, setOverlayVisible, syncMapView`):

```ts
import {
  clearZone,
  getCurrentPolygon,
  initGeofenceOverlay,
  setDrawPrompt,
  setOnZoneChange,
  setOverlayVisible,
  setZone,
  syncMapView,
} from "../geofence-overlay.ts";
```

Add the ambient declaration below the imports:

```ts
declare const __DEV__: boolean;
```

And extend its inbound `msg` handler identically:

```ts
    if (msg.type === "msg") {
      if (msg.payload.type === "zone_prompt") {
        setDrawPrompt(msg.payload.active);
      } else if (msg.payload.type === "clear_zone") {
        clearZone();
      } else if (msg.payload.type === "drive_viewport") {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          document.dispatchEvent(
            new CustomEvent(EVT.drive, { detail: { bbox: msg.payload.bbox } }),
          );
        }
      } else if (msg.payload.type === "drive_zone") {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          setZone(msg.payload.polygon);
        }
      }
    }
```

- [ ] **Step 4: Verify a dev build succeeds**

Run: `deno run -A build.ts`
Expected: `Build complete.` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/content/relay.ts src/content/ev/relay.ts
git commit -m "Handle dev-gated drive_viewport/drive_zone in both relays"
```

---

### Task 8: Install the dev-only panel hooks

**Files:**
- Modify: `src/panel/App.tsx` (imports near top; new module-level helpers; new mount effect)

- [ ] **Step 1: Add imports and the `__DEV__` declaration**

In `src/panel/App.tsx`, add to the type import from `../types.ts` the `BBox` type, and import the parity core. After the existing imports (e.g. after the `AggregateSummary` import on line 34), add:

```ts
import { buildFigures } from "./lib/parity.ts";
import type { ParitySnapshot } from "./lib/parity.ts";
import type { SeriesSide } from "./lib/aggregate.ts";

declare const __DEV__: boolean;
```

Also extend the existing `import type { ... } from "../types.ts";` block to include `BBox`:

```ts
import type {
  BBox,
  MetricKey,
  PanelDown,
  PanelToContent,
  PanelUp,
  TabStore,
} from "../types.ts";
```

- [ ] **Step 2: Add the pure-ish snapshot helpers at module scope**

Below the imports, above `function App()` (after the `MetricSection` interface, ~line 49), add:

```ts
// Bounding box of a polygon — used to drive the target map far enough to cover
// a synced zone before applying it.
function polygonBbox(poly: [number, number][]): BBox {
  const lats = poly.map((p) => p[0]);
  const lngs = poly.map((p) => p[1]);
  return {
    sw_lat: Math.min(...lats),
    sw_lng: Math.min(...lngs),
    ne_lat: Math.max(...lats),
    ne_lng: Math.max(...lngs),
  };
}

// Build a ParitySnapshot for one tab's store — mirrors the panel's own
// scope/window/side selection so the snapshot matches what's on screen.
function buildSnapshot(store: TabStore): ParitySnapshot {
  const visible = scopedListings(store);
  const buckets = buildBuckets(
    new Date(),
    store.windowSize,
    store.alignmentMode,
    store.anchorDayOfWeek,
    store.anchorDayOfMonth,
  );
  const side: SeriesSide[] | null = store.searchStatus === "active"
    ? ["list"]
    : store.searchStatus === "sold"
    ? ["sold"]
    : null;
  return {
    tabId: store.tabId,
    host: store.host,
    scope: store.scope,
    searchStatus: store.searchStatus,
    windowSize: store.windowSize,
    loading: store.loading,
    bbox: store.viewportBbox,
    polygon: store.polygon,
    figures: buildFigures(visible, buckets, side),
  };
}
```

- [ ] **Step 3: Install the hooks in a mount-once effect**

Inside `App()`, after the `postToRelay` `useCallback` (ends ~line 231), add a new effect. It depends on `postToRelay` (stable, `[]` deps) and reads `tabStores.current` live:

```ts
  // Dev-only parity harness: expose capture + sync hooks on the panel window.
  // Stripped from --prod (__DEV__ === false → the whole effect is dead code).
  useEffect(() => {
    if (typeof __DEV__ === "undefined" || !__DEV__) return;
    const w = window as unknown as {
      __seelevelSnapshot?: () => ParitySnapshot[];
      __seelevelSync?: (
        opts?: { from?: number; to?: number; what?: "viewport" | "zone" | "both" },
      ) => unknown;
    };

    w.__seelevelSnapshot = () =>
      Array.from(tabStores.current.values()).map(buildSnapshot);

    w.__seelevelSync = (opts = {}) => {
      const stores = Array.from(tabStores.current.values());
      const find = (kw: string) =>
        stores.find((s) => (s.host ?? "").includes(kw));
      const fromStore = opts.from !== undefined
        ? tabStores.current.get(opts.from)
        : find("viewpoint");
      const toStore = opts.to !== undefined
        ? tabStores.current.get(opts.to)
        : find("engelvoelkers");
      if (!fromStore || !toStore) {
        return {
          error: "need one ViewPoint and one EV tab open (or pass {from,to})",
        };
      }
      const what = opts.what ?? "both";
      const result: Record<string, unknown> = {
        from: fromStore.tabId,
        to: toStore.tabId,
        what,
      };
      if ((what === "viewport" || what === "both") && fromStore.viewportBbox) {
        postToRelay(toStore.tabId, {
          type: "drive_viewport",
          bbox: fromStore.viewportBbox,
        });
        result.bbox = fromStore.viewportBbox;
      }
      if ((what === "zone" || what === "both") && fromStore.polygon) {
        // Drive the target far enough to cover the zone, then apply the zone.
        postToRelay(toStore.tabId, {
          type: "drive_viewport",
          bbox: polygonBbox(fromStore.polygon),
        });
        postToRelay(toStore.tabId, {
          type: "drive_zone",
          polygon: fromStore.polygon,
        });
        result.polygon = fromStore.polygon;
      }
      return result;
    };

    return () => {
      delete w.__seelevelSnapshot;
      delete w.__seelevelSync;
    };
  }, [postToRelay]);
```

- [ ] **Step 4: Verify a dev build succeeds**

Run: `deno run -A build.ts`
Expected: `Build complete.` with no errors.

- [ ] **Step 5: Confirm the hooks are present in the DEV bundle**

Run: `grep -c "__seelevelSnapshot" build/panel/panel.js`
Expected: a non-zero count (the dev build retains the hook).

- [ ] **Step 6: Commit**

```bash
git add src/panel/App.tsx
git commit -m "Install dev-only __seelevelSnapshot/__seelevelSync panel hooks"
```

---

### Task 9: Verify the harness is stripped from `--prod`

**Files:** none (verification + format/lint only)

- [ ] **Step 1: Run the full test suite**

Run: `deno test -A src/`
Expected: all tests pass (the prior 63 + the new parity tests).

- [ ] **Step 2: Format and lint**

Run: `deno fmt && deno lint`
Expected: no changes reported by `fmt` after it runs (re-run `deno fmt --check` to confirm), no lint errors.

- [ ] **Step 3: Production build**

Run: `deno run -A build.ts --prod`
Expected: `Build complete (production).`

- [ ] **Step 4: Grep the prod bundles — the harness must be gone**

Run:
```bash
grep -l "__seelevelSnapshot\|__seelevelSync\|seelevel:drive\|drive_viewport\|drive_zone" build/panel/panel.js build/content/relay.js build/content/ev/relay.js build/content/fetch-interceptor.js build/content/ev/main.js; echo "exit: $?"
```
Expected: no file paths printed and `exit: 1` (grep found nothing — every dev path was dead-code-eliminated).

> If any path prints, the gating failed: confirm the `__DEV__` define is `false` under `--prod` (Task 1) and that each producer/consumer is wrapped in `if (typeof __DEV__ !== "undefined" && __DEV__)` (Tasks 5, 7, 8).

- [ ] **Step 5: Restore the dev build for manual testing**

Run: `deno run -A build.ts`
Expected: `Build complete.`

- [ ] **Step 6: Commit (if fmt changed anything)**

```bash
git add -A
git commit -m "Run deno fmt across the parity harness" || echo "nothing to commit"
```

---

### Task 10: Manual live verification (DevTools procedure)

**Files:** none (manual; uses the procedure in the spec)

This task is not automatable — it exercises the live sites and is how we gather the data to settle the tolerance.

- [ ] **Step 1: Load the dev build** in `chrome://extensions` (Load unpacked → `build/`).

- [ ] **Step 2:** Open a `*.viewpoint.ca/map*` tab and a `*.engelvoelkersnovascotia.com/map*` tab; open the side panel. Pan each map roughly to central Halifax. Set the same status filter (for sale) and window (monthly) in the panel.

- [ ] **Step 3:** With Chrome DevTools MCP, `select_page` → the panel page, then:
  - `evaluate_script: __seelevelSync({ what: "viewport" })`
  - poll `evaluate_script: __seelevelSnapshot()` until the EV tab's `bbox` matches the driven bbox and its `loading` is `false`
  - `evaluate_script: __seelevelSnapshot()` → capture both snapshots

- [ ] **Step 4:** Run `compareAggregates(viewpointSnap, evSnap)` and read the report — `aligned` first, then the delta table.

- [ ] **Step 5:** Repeat for "sold" and for a drawn zone (`__seelevelSync({ what: "zone" })`) across 2–3 areas. Record where the figures actually land.

- [ ] **Step 6:** Using that data, settle a tolerance and update the spec's Testing section (graduating `pass` from advisory to a recorded threshold). Commit the spec update.

---

## Self-Review

**1. Spec coverage:**
- Capture hook on the panel returning one snapshot per tab → Task 8 (`__seelevelSnapshot` + `buildSnapshot`). ✓
- `ParitySnapshot` shape (tabId/host/scope/status/window/loading/bbox/polygon/figures) → Task 3 type + Task 8 builder. ✓
- `ParityFigures` from scoped listings, latest complete bucket, reusing aggregate + priceHistogram → Task 2. ✓
- Pure `buildFigures` + `compareAggregates`, delta table, advisory tolerance, `aligned` first → Tasks 2, 3. ✓
- Viewport drive via shared hook `currentMap.fitBounds` → Task 5; downward messages → Task 4; relay handlers → Task 7. ✓
- Zone drive via overlay `setZone` + drive-to-polygon-bbox → Tasks 6, 8. ✓
- `__seelevelSync({from,to,what})` with ViewPoint→EV default → Task 8. ✓
- `__DEV__` define on all bundles + `--prod` strip + grep proof → Tasks 1, 9. ✓
- DevTools procedure + tolerance-from-real-runs → Task 10. ✓
- Files list matches spec's Files section. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step gives an exact command and expected output. ✓

**3. Type consistency:** `buildFigures(listings, buckets, side)` defined in Task 2 and called identically in Task 8. `ParitySnapshot`/`ParityFigures`/`compareAggregates`/`DEFAULT_TOL` defined in Tasks 2–3 and imported in Task 8. `EVT.drive` added in Task 4, dispatched in Task 7, listened for in Task 5. `setZone` exported in Task 6, imported in Task 7. `PanelToContent` drive variants added in Task 4, sent in Task 8, handled in Task 7. `__seelevelSnapshot`/`__seelevelSync` names consistent across Tasks 8–10. ✓
