# Engel & Völkers Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second host-site adapter (`engelvoelkersnovascotia.com`) to
SeeLevel that fires one slim-projection `get-listing` per viewport-settle,
handles >2000-row oversize state, reuses the existing geofence overlay, and
ships behind exactly the same manifest permissions (`["sidePanel"]`).

**Architecture:** Two new content-script bundles (MAIN: `ev/main.ts`, ISOLATED:
`ev/relay.ts`) parallel to the existing ViewPoint pair. A shared
`google.maps.Map` constructor patch is extracted from the existing
fetch-interceptor. The relay reuses the existing Leaflet+Geoman overlay
verbatim. New `oversize_bbox` and `loading_state` payloads flow through the SW
broker into the panel's per-tab `TabStore`.

**Tech Stack:** Deno + esbuild, Chrome MV3 (`content_scripts` with
`world: "MAIN"` / `world: "ISOLATED"`), Preact, `jsr:@std/assert` for tests. No
new dependencies.

**Spec reference:**
`docs/superpowers/specs/2026-05-29-engelvoelkers-adapter-design.md`.

---

## Task 1: Precursor — `vpa` → `seelevel` rename

Mechanical rename, zero behavior change. Adds `EVT` constants in `types.ts` and
substitutes them everywhere CustomEvent names appear. All CSS classes `vpa-` →
`seelevel-`. The `window.__vpa_hooked` / `m.__vpa_hooked` flags become
`__seelevel_hooked`. Single commit.

**Files:**

- Modify: `src/types.ts` (add `EVT` constants block)
- Modify: `src/content/fetch-interceptor.ts` (CustomEvent strings,
  `__vpa_hooked`, `__vpa`)
- Modify: `src/content/relay.ts` (CustomEvent strings)
- Modify: `src/content/geofence-overlay.ts` (CSS class strings, `vpa-zone-pulse`
  keyframe, `vpa-leaflet-*` IDs)
- Modify: `src/panel/panel.css` (all `vpa-` selectors → `seelevel-`;
  `@keyframes vpa-zone-pulse` → `seelevel-zone-pulse`)
- Modify: `src/panel/App.tsx` (className attrs)
- Modify: `src/panel/components/EulaGate.tsx` (className attrs)
- Modify: `src/panel/components/ScopeSelector.tsx`
- Modify: `src/panel/components/StatsRow.tsx`
- Modify: `src/panel/components/TimeSeriesChart.tsx`
- Modify: `src/panel/components/ZoneCoverage.tsx`
- Modify: `src/panel/components/WindowPicker.tsx`
- Modify: `src/panel/components/Disclaimer.tsx`
- Modify: `src/panel/components/EmptyState.tsx`
- Modify: `src/panel/components/ExportButton.tsx`

- [ ] **Step 1: Add `EVT` constants to `src/types.ts`**

Append at the end of `src/types.ts`:

```ts
// Wire protocol event names — MAIN ↔ ISOLATED via document CustomEvent.
// Adapter-agnostic; ViewPoint and Engel & Völkers adapters both use them.
// Detail shapes are adapter-specific (see each adapter's main/relay pair).
export const EVT = {
  listings: "seelevel:listings",
  bbox: "seelevel:bbox",
  mapbusy: "seelevel:mapbusy",
  oversize: "seelevel:oversize",
  clearSession: "seelevel:clear-session",
  loadingState: "seelevel:loading-state",
} as const;
```

- [ ] **Step 2: Update `src/content/fetch-interceptor.ts` to use `EVT` + rename
      hooks**

Add import at the top of the file:

```ts
import { EVT } from "../types.ts";
```

Then perform these renames (use Edit with `replace_all: true` per pair):

- `"vpa:bbox"` → `EVT.bbox`
- `"vpa:mapbusy"` → `EVT.mapbusy`
- `"vpa:listings"` → `EVT.listings`
- `__vpa_hooked` → `__seelevel_hooked` (appears twice: `m.__seelevel_hooked`
  check and assignment)
- `__vpa` → `__seelevel` (appears twice: `(Original as AnyObj).__seelevel` check
  and `(Patched as AnyObj).__seelevel = true` assignment)

The Patched constructor marker (`__seelevel`) is a separate symbol from
`__seelevel_hooked` — keep both.

- [ ] **Step 3: Update `src/content/relay.ts` to use `EVT`**

Add import:

```ts
import { EVT } from "../types.ts";
```

Replacements:

- `"vpa:bbox"` → `EVT.bbox`
- `"vpa:mapbusy"` → `EVT.mapbusy`
- `"vpa:listings"` → `EVT.listings`

- [ ] **Step 4: Rename CSS class strings in `src/content/geofence-overlay.ts`**

`replace_all` in this file:

- `vpa-leaflet-css` → `seelevel-leaflet-css`
- `vpa-leaflet-overlay` → `seelevel-leaflet-overlay`
- `vpa-zone-pulse` → `seelevel-zone-pulse`
- `vpa-draw-wrap` → `seelevel-draw-wrap`
- `vpa-draw-btn` → `seelevel-draw-btn` (matches `vpa-draw-btn`,
  `vpa-draw-btn--active`, `vpa-draw-btn--drawing`, `vpa-draw-btn--prompt`)

After these, the file should contain zero `vpa-` occurrences. Verify with
`grep -n vpa src/content/geofence-overlay.ts` returning empty.

- [ ] **Step 5: Rename selectors in `src/panel/panel.css`**

A pure mechanical `vpa-` → `seelevel-` and `vpa:` → `seelevel:` across the whole
file. Use Edit with `replace_all: true` for `vpa-` → `seelevel-`. There should
be no `vpa:` literal in CSS (event names don't appear there); verify after.

- [ ] **Step 6: Rename `className`s in panel components**

For each of these files, do `replace_all: true` of `vpa-` → `seelevel-`:

- `src/panel/App.tsx`
- `src/panel/components/EulaGate.tsx`
- `src/panel/components/ScopeSelector.tsx`
- `src/panel/components/StatsRow.tsx`
- `src/panel/components/TimeSeriesChart.tsx`
- `src/panel/components/ZoneCoverage.tsx`
- `src/panel/components/WindowPicker.tsx`
- `src/panel/components/Disclaimer.tsx`
- `src/panel/components/EmptyState.tsx`
- `src/panel/components/ExportButton.tsx`

- [ ] **Step 7: Verify zero `vpa` leftovers**

Run: `grep -rn 'vpa' src/ manifest.json build.ts`

Expected: empty output. If anything remains, edit it.

- [ ] **Step 8: Run dev build**

Run: `deno run -A build.ts`

Expected: `Build complete.` with no errors.

- [ ] **Step 9: Run formatter and linter**

Run: `deno fmt && deno lint`

Expected: no errors. Formatter may rewrite whitespace; that's fine.

- [ ] **Step 10: Run full test suite**

Run: `deno test -A src/`

Expected: all existing tests pass (the rename touched only string literals;
tests don't reference any of them).

- [ ] **Step 11: Manual smoke test on ViewPoint**

Load the unpacked extension from `build/` in `chrome://extensions` (Developer
mode → Load unpacked, or Reload if already loaded). Visit
`https://viewpoint.ca/map` in the host browser at `$DOCKER_HOST_IP`. Verify:

- Side panel opens, shows the SeeLevel header.
- After a pan, listings count appears in the header chip; metric sections
  render.
- Draw a zone via the ⬡ Draw Zone button on the map. Zone tab renders coverage
  %.
- Switch scopes (Viewport / Session / Zone). Each shows its expected data.

If any of these fail, revert the offending file's rename and re-investigate.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Rename vpa → seelevel across the codebase

Drops the legacy "ViewPoint Analytics" prefix from CSS classes,
CustomEvent names, and the internal window/instance hook flags.
Introduces an EVT constants block in types.ts so every dispatch
and listener references a single source of truth — typos become
TypeScript errors instead of silent no-ops.

Pure mechanical rename, zero behavior change. Precursor to the
Engel & Völkers adapter, which lands as a second content-script
pair using the same canonical event names.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extract shared `google.maps.Map` constructor patch

Both adapters need the same hook. Factor the existing inline implementation in
`fetch-interceptor.ts` into a reusable module. Same behavior, just a different
file.

**Files:**

- Create: `src/content/shared/google-maps-hook.ts`
- Modify: `src/content/fetch-interceptor.ts` (replace the inline IIFE with an
  import call)

- [ ] **Step 1: Create the shared module**

Create `src/content/shared/google-maps-hook.ts` with the EXACT contents of the
existing `installGoogleMapsHook` IIFE block from `fetch-interceptor.ts` (lines
covering the IIFE between `// ─── Google Maps bounds sync ──` and the closing
`})()`). Wrap as an exported function instead of an IIFE:

```ts
// MAIN-world only. Patches google.maps.Map's constructor and hooks every
// instance so seelevel:bbox + seelevel:mapbusy fire on idle / drag / zoom.
// Idempotent — calling more than once is harmless (each instance's hookInstance
// checks __seelevel_hooked).
//
// Adapter-agnostic: used by both src/content/fetch-interceptor.ts (ViewPoint)
// and src/content/ev/main.ts (Engel & Völkers). Both sites embed google.maps,
// so the same hook works for both.

// deno-lint-ignore-file no-explicit-any
import { EVT } from "../../types.ts";

type AnyObj = Record<string, any>;

export function installGoogleMapsHook(): void {
  let currentMap: AnyObj | null = null;

  function emitBbox(m: AnyObj, settled: boolean): void {
    const b = m.getBounds?.();
    if (!b) return;
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const c = m.getCenter?.();
    const z = m.getZoom?.();
    document.dispatchEvent(
      new CustomEvent(EVT.bbox, {
        detail: {
          sw_lat: sw.lat(),
          sw_lng: sw.lng(),
          ne_lat: ne.lat(),
          ne_lng: ne.lng(),
          settled,
          ...(c && z !== undefined
            ? { center_lat: c.lat(), center_lng: c.lng(), zoom: z }
            : {}),
        },
      }),
    );
  }

  function hookInstance(m: AnyObj): void {
    if (!m || m.__seelevel_hooked) return;
    m.__seelevel_hooked = true;
    currentMap = m;

    let dragging = false;
    let raf = 0;

    m.addListener?.("dragstart", () => {
      dragging = true;
    });
    m.addListener?.("dragend", () => {
      dragging = false;
    });
    m.addListener?.("bounds_changed", () => {
      if (!dragging) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => emitBbox(m, false));
    });
    m.addListener?.("zoom_changed", () => {
      document.dispatchEvent(new CustomEvent(EVT.mapbusy));
    });
    m.addListener?.("idle", () => emitBbox(m, true));

    emitBbox(m, true);
  }

  function patchMapConstructor(): void {
    const maps: AnyObj = (window as any).google?.maps;
    const Original: AnyObj = maps?.Map;
    if (typeof Original !== "function" || (Original as AnyObj).__seelevel) {
      return;
    }
    function Patched(this: AnyObj, ...args: any[]) {
      const inst = new (Original as any)(...args);
      try {
        hookInstance(inst);
      } catch { /* ignore */ }
      return inst;
    }
    Patched.prototype = Original.prototype;
    Object.setPrototypeOf(Patched, Original);
    (Patched as AnyObj).__seelevel = true;
    try {
      maps.Map = Patched;
    } catch { /* read-only - discovery fallback */ }
  }

  if (!(window as any).google) {
    try {
      let _g: AnyObj | undefined;
      Object.defineProperty(window, "google", {
        configurable: true,
        get() {
          return _g;
        },
        set(v: AnyObj) {
          _g = v;
          try {
            Object.defineProperty(window, "google", {
              value: v,
              writable: true,
              configurable: true,
            });
          } catch { /* ignore */ }
          patchMapConstructor();
          queueMicrotask(patchMapConstructor);
        },
      });
    } catch { /* not configurable - the polls below handle it */ }
  }

  let fastTries = 0;
  function fastPatchPoll(): void {
    patchMapConstructor();
    const patched = !!((window as any).google?.maps?.Map as AnyObj)?.__seelevel;
    if (!patched && ++fastTries < 600) requestAnimationFrame(fastPatchPoll);
  }
  fastPatchPoll();

  function isAlive(m: AnyObj | null): boolean {
    if (!m) return false;
    try {
      const div = m.getDiv?.();
      return !!div && document.contains(div);
    } catch {
      return false;
    }
  }

  function discover(): AnyObj | null {
    const container = document.querySelector(".gm-style")?.parentElement;
    if (!container) return null;
    const MapCls = (window as any).google?.maps?.Map;
    const keys: (string | symbol)[] = [
      ...Object.getOwnPropertyNames(container),
      ...Object.getOwnPropertySymbols(container),
    ];
    for (const key of keys) {
      try {
        const v = (container as any)[key];
        if (!v || typeof v !== "object") continue;
        const isMap = (MapCls && v instanceof MapCls) ||
          (typeof v.getBounds === "function" &&
            typeof v.getDiv === "function" &&
            typeof v.addListener === "function" &&
            typeof v.getCenter === "function");
        if (isMap) return v;
      } catch { /* skip inaccessible property */ }
    }
    return null;
  }

  let elapsed = 0;
  function tick(): void {
    patchMapConstructor();
    if (isAlive(currentMap)) return;
    currentMap = null;
    const m = discover();
    if (m) hookInstance(m);
  }
  function schedule(): void {
    const interval = elapsed < 30000 ? 200 : 1000;
    setTimeout(() => {
      elapsed += interval;
      tick();
      schedule();
    }, interval);
  }
  tick();
  schedule();
}
```

- [ ] **Step 2: Replace inline IIFE in `fetch-interceptor.ts` with the import
      call**

At the top of `src/content/fetch-interceptor.ts`, after the `LISTING_PATHS`
const, replace the entire `// ─── Google Maps bounds sync ──` IIFE block
(everything from `(function installGoogleMapsHook() {` through its closing
`})()`) with:

```ts
// ─── Google Maps bounds sync ──────────────────────────────────────────────────
// See src/content/shared/google-maps-hook.ts. Same hook is also installed by
// the Engel & Völkers MAIN-world bundle; both sites embed google.maps.
import { installGoogleMapsHook } from "./shared/google-maps-hook.ts";
installGoogleMapsHook();
```

The `EVT` import at the top of `fetch-interceptor.ts` (added in Task 1) can stay
— the file's XHR observation still references `EVT.listings`.

- [ ] **Step 3: Run dev build**

Run: `deno run -A build.ts`

Expected: `Build complete.` with no errors. The `fetch-interceptor.js` bundle
now resolves the import from `shared/google-maps-hook.ts` and inlines it at
bundle time (esbuild's default behavior). Output bundle size should be unchanged
within a few bytes.

- [ ] **Step 4: Run tests**

Run: `deno test -A src/`

Expected: all pass.

- [ ] **Step 5: Manual smoke test on ViewPoint**

Reload the extension. Verify the side panel still reflects pans (`viewport_bbox`
updates) and the zone overlay still pulses when the Zone tab opens. If pans
don't update, the hook isn't installing — recheck the IIFE-to-function
conversion in Step 1.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Extract google.maps.Map constructor hook into a shared module

Same patch logic, now lives in src/content/shared/google-maps-hook.ts
so the upcoming EV adapter's MAIN bundle can import and call
installGoogleMapsHook() exactly as fetch-interceptor.ts now does.
Zero behavior change for ViewPoint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extend `TabStore` and `ContentToPanel` for oversize + loading

Add the type-level wire protocol changes that subsequent tasks build on.
Type-only; no behavior change yet.

**Files:**

- Modify: `src/types.ts` (add `oversize_bbox` and `loading_state` variants;
  extend `TabStore` and `defaultTabStore`)

- [ ] **Step 1: Add the two new `ContentToPanel` variants**

In `src/types.ts`, find the `ContentToPanel` union (currently 4 variants) and
add two more:

```ts
export type ContentToPanel =
  | {
    type: "listings";
    listings: ListingRow[];
    properties: PropertyRow[];
    bbox: BBox | null;
    kind: ListingKind;
    status: SearchStatus;
  }
  | { type: "zone"; polygon: [number, number][] | null }
  | { type: "viewport_bbox"; bbox: BBox }
  | { type: "clear_session" }
  | { type: "oversize_bbox"; bbox: BBox; count: number }
  | { type: "loading_state"; loading: boolean };
```

- [ ] **Step 2: Extend `TabStore` interface**

In `src/types.ts`, find the `TabStore` interface and add three fields after
`anchorDayOfMonth`:

```ts
export interface TabStore {
  // ... existing fields ...
  anchorDayOfMonth: number;

  // EV adapter oversize state: when the most recent slim sibling reports
  // count > 2000, oversizeBbox/Count are populated and viewportListings is
  // cleared. Reset by any successful "listings" payload or clear_session.
  oversizeBbox: BBox | null;
  oversizeCount: number | null;

  // Slim sibling in flight — drives the panel's spinner.
  loading: boolean;
}
```

- [ ] **Step 3: Update `defaultTabStore`**

In `src/types.ts`, in the `defaultTabStore` function, add the three new fields
to the returned object:

```ts
export function defaultTabStore(tabId: number): TabStore {
  return {
    tabId,
    session: [],
    viewportListings: null,
    viewportBbox: null,
    fetchedBboxes: [],
    polygon: null,
    scope: "viewport",
    searchStatus: "any",
    windowSize: "monthly",
    alignmentMode: "today",
    anchorDayOfWeek: 1,
    anchorDayOfMonth: 1,
    oversizeBbox: null,
    oversizeCount: null,
    loading: false,
  };
}
```

- [ ] **Step 4: Run typecheck via build**

Run: `deno run -A build.ts`

Expected: `Build complete.` All references to `TabStore` and `ContentToPanel`
continue to type-check. (Existing code doesn't read the new fields — they exist
but go unused until Task 6 wires them.)

- [ ] **Step 5: Run tests**

Run: `deno test -A src/`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add oversize_bbox + loading_state payloads and TabStore fields

Wire protocol extensions for the upcoming EV adapter:
- ContentToPanel gains oversize_bbox (bbox + count when server reports
  >2000 listings) and loading_state (binary in-flight signal).
- TabStore gains oversizeBbox, oversizeCount, loading; defaultTabStore
  initializes all three.

Type-only change. No reducer or render wiring yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `Spinner` component

Small Preact component used when a scope is empty and the slim sibling is
in-flight.

**Files:**

- Create: `src/panel/components/Spinner.tsx`
- Modify: `src/panel/panel.css` (add `.seelevel-spinner*` rules)

- [ ] **Step 1: Create the component**

Create `src/panel/components/Spinner.tsx`:

```tsx
import { h } from "preact";

export function Spinner() {
  return (
    <div class="seelevel-empty">
      <div class="seelevel-spinner" />
      <div class="seelevel-empty__text">Fetching listings…</div>
    </div>
  );
}
```

Reuses the existing `.seelevel-empty` block layout for vertical centering. The
spinner itself is a small CSS-only spinning border.

- [ ] **Step 2: Add CSS rules**

Append to `src/panel/panel.css`:

```css
/* Loading spinner — shown when a scope is empty and a sibling fetch is in
   flight. Centered inside the seelevel-empty block layout. */
.seelevel-spinner {
  width: 28px;
  height: 28px;
  border: 2.5px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: seelevel-spin 0.85s linear infinite;
  margin: 0 auto 10px;
}
@keyframes seelevel-spin {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 3: Run dev build**

Run: `deno run -A build.ts`

Expected: `Build complete.`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add Spinner component for in-flight fetches

Renders in place of EmptyState when the active scope has no
listings yet but a slim sibling fetch is in progress. CSS-only
border spinner, accent-teal, "Fetching listings…" caption.

Wired into App.tsx in a later commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `OversizeNotice` component

One component, two render modes. `mode="block"` replaces the metrics area in
viewport scope when oversize is active. `mode="badge"` renders inline next to
the header count chip in session/zone scope.

**Files:**

- Create: `src/panel/components/OversizeNotice.tsx`
- Modify: `src/panel/panel.css` (add `.seelevel-oversize*` rules)

- [ ] **Step 1: Create the component**

Create `src/panel/components/OversizeNotice.tsx`:

```tsx
import { h } from "preact";

export function OversizeNotice(
  { mode, count }: { mode: "block" | "badge"; count: number },
) {
  if (mode === "block") {
    return (
      <div class="seelevel-empty">
        <div class="seelevel-empty__icon">⊘</div>
        <div class="seelevel-empty__text">
          Too many listings in view (<strong>{count.toLocaleString()}</strong>)
          to compute statistics.<br />
          Zoom in or narrow your filter to see analytics.
        </div>
      </div>
    );
  }
  return (
    <span
      class="seelevel-oversize-badge"
      title={`${count.toLocaleString()} listings in view — too many to record`}
    >
      View too large — {count.toLocaleString()} skipped
    </span>
  );
}
```

- [ ] **Step 2: Add CSS for the badge**

Append to `src/panel/panel.css`:

```css
/* Oversize badge — shown in the header row when a slim sibling reports
   count > 2000 in session/zone scope. The block mode reuses .seelevel-empty. */
.seelevel-oversize-badge {
  display: inline-block;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 2px 7px;
  border-radius: 8px;
  background: oklch(30% 0.13 50 / 0.5);
  color: var(--color-sun);
  border: 1px solid oklch(40% 0.13 50 / 0.6);
}
```

- [ ] **Step 3: Run dev build**

Run: `deno run -A build.ts`

Expected: `Build complete.`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add OversizeNotice component (block + badge modes)

Block mode replaces metrics in viewport scope when the current
bbox returns >2000 listings ("Too many listings in view…");
badge mode is a compact inline indicator for session/zone scope
("View too large — N skipped"). Both branched from one component.

Wired into App.tsx in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire panel reducer + render branches

Extend `App.tsx`'s `onMessage` reducer to handle the two new payloads, and add
the render-precedence branches for OversizeNotice (block + badge) and Spinner.
Also suppress the header count chip in viewport-scope-oversize.

**Files:**

- Modify: `src/panel/App.tsx`

- [ ] **Step 1: Add imports**

In `src/panel/App.tsx`, near the other component imports, add:

```tsx
import { OversizeNotice } from "./components/OversizeNotice.tsx";
import { Spinner } from "./components/Spinner.tsx";
```

- [ ] **Step 2: Handle `oversize_bbox` and `loading_state` payloads in the
      reducer**

Find the `onMessage` function inside the port-mount `useEffect` (around line 92
of the current App.tsx). After the existing `if (payload.type === "zone") { … }`
block, before the `if (tabId === activeTabIdRef.current)` line, add:

```tsx
if (payload.type === "oversize_bbox") {
  // Oversize bbox: discard rows we never fetched, but preserve session +
  // fetchedBboxes (they're earlier successful fetches, still valid).
  // Clear viewportListings — its prior verbatim rows are stale for the new
  // wider bbox and would mis-count the header chip otherwise.
  s.oversizeBbox = payload.bbox;
  s.oversizeCount = payload.count;
  s.viewportListings = null;
  s.loading = false;
}

if (payload.type === "loading_state") {
  s.loading = payload.loading;
}
```

In the existing `if (payload.type === "listings")` block, after the existing
assignments, add a line to clear oversize state on any successful listings
arrival:

```tsx
if (payload.type === "listings") {
  const resolved = resolveCoordinates(payload.listings, payload.properties);
  s.session = mergeListings(s.session, resolved);
  s.viewportListings = payload.kind === "search" ? resolved : null;
  if (payload.kind === "search") s.searchStatus = payload.status;
  if (payload.bbox) s.fetchedBboxes = [...s.fetchedBboxes, payload.bbox];
  // A successful fetch supersedes any prior oversize state.
  s.oversizeBbox = null;
  s.oversizeCount = null;
  s.loading = false;
}
```

In the existing `if (payload.type === "clear_session")` block, also clear
oversize state:

```tsx
if (payload.type === "clear_session") {
  s.session = [];
  s.viewportListings = null;
  s.fetchedBboxes = [];
  s.searchStatus = "any";
  s.oversizeBbox = null;
  s.oversizeCount = null;
}
```

- [ ] **Step 3: Compute oversize-related render flags**

In the body of `App()`, after the existing `const zoneNoPolygon = …` line, add:

```tsx
const viewportOversize = !!store?.oversizeBbox && store.scope === "viewport";
const sessionOrZoneOversize = !!store?.oversizeBbox &&
  (store.scope === "session" || store.scope === "zone");
const showSpinner = !!store && listingCount === 0 && store.loading;
```

- [ ] **Step 4: Suppress the header count chip in viewport-scope-oversize**

Find the chip line in the header JSX:

```tsx
{listingCount > 0 && <span class="seelevel-label" ...>{listingCount} listings</span>}
```

Change the condition to also exclude the viewport-oversize case:

```tsx
{
  listingCount > 0 && !viewportOversize && (
    <span
      class="seelevel-label"
      style={{
        background: "oklch(30% 0.09 205 / 0.5)",
        padding: "1px 6px",
        borderRadius: "8px",
      }}
    >
      {listingCount} listings
    </span>
  );
}
```

(Use whatever className name resulted from the Task 1 rename — should be
`seelevel-label` now.)

- [ ] **Step 5: Render the badge in the header row for session/zone oversize**

Immediately after the count chip JSX (still inside the header `seelevel-row`),
add:

```tsx
{
  sessionOrZoneOversize && (
    <OversizeNotice mode="badge" count={store!.oversizeCount!} />
  );
}
```

- [ ] **Step 6: Update the body render precedence**

Find the main render branch
(`return ( <div … > … {!store ? <EmptyState /> : zoneNoPolygon ? …` etc.).

Replace the existing branch chain with:

```tsx
{
  !store
    ? <EmptyState />
    : viewportOversize
    ? <OversizeNotice mode="block" count={store.oversizeCount!} />
    : zoneNoPolygon
    ? (
      <div class="seelevel-empty">
        <div class="seelevel-empty__icon">⬡</div>
        <div class="seelevel-empty__text">
          No zone drawn yet.<br />
          Use the pulsing <strong>⬡ Draw Zone</strong>{" "}
          button on the map to draw an area - results are then filtered to
          listings inside it.
        </div>
      </div>
    )
    : showSpinner
    ? <Spinner />
    : listingCount === 0
    ? <EmptyState />
    : (
      <>
        {/* existing metrics + footer block — unchanged */}
      </>
    );
}
```

The `{/* existing metrics + footer block — unchanged */}` placeholder represents
the existing JSX from the `else` branch of today's code (WindowPicker,
`seelevel-metrics`, footer). Preserve it verbatim — only the outer branching
changes.

- [ ] **Step 7: Run dev build**

Run: `deno run -A build.ts`

Expected: `Build complete.`

- [ ] **Step 8: Run tests**

Run: `deno test -A src/`

Expected: all pass (none reference App.tsx).

- [ ] **Step 9: Manual smoke test on ViewPoint**

Reload the extension. Visit ViewPoint, pan around. Verify the panel renders as
before — no oversize-related artifacts should ever appear on ViewPoint (no
source ever emits the new payloads yet).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Wire oversize + loading state into the panel

Reducer handles oversize_bbox (sets state, clears viewportListings,
clears loading) and loading_state (binary). The listings reducer
arm clears oversize defensively on every successful fetch. Render
precedence adds OversizeNotice (block in viewport, badge in session/
zone) and Spinner (when scope is empty and a fetch is in flight).
Header count chip suppressed in viewport-scope-oversize so it
doesn't contradict the block notice's "N too many" copy.

No source emits the new payloads yet — ViewPoint behavior unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: EV `parse.ts` with TDD

Pure function. Test-driven.

**Files:**

- Create: `src/content/ev/parse.ts`
- Create: `src/content/ev/__tests__/parse.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/content/ev/__tests__/parse.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { parseEvListing } from "../parse.ts";

Deno.test("parseEvListing — active listing", () => {
  const row = parseEvListing({
    id: "abc-1",
    MlsStatus: "ACTIVE",
    StandardStatus: "Active",
    ListPrice: "689900",
    ClosedPrice: null,
    ListingContractDate: "2026-05-28",
    ModificationTimestamp: "2026-05-29T13:02:06.200Z",
    BuildingAreaTotal: "2400",
    Latitude: "44.5994",
    Longitude: "-63.6022",
  });
  assertEquals(row.id, "abc-1");
  assertEquals(row.status_id, 1);
  assertEquals(row.list_price, 689900);
  assertEquals(row.sold_price, null);
  assertEquals(row.list_dt, "2026-05-28");
  assertEquals(row.sold_dt, null);
  assertEquals(row.close_dt, null);
  assertEquals(row.tla, 2400);
  assertEquals(row.lat, 44.5994);
  assertEquals(row.lng, -63.6022);
});

Deno.test("parseEvListing — closed sold listing", () => {
  const row = parseEvListing({
    id: "abc-2",
    MlsStatus: "SOLD",
    StandardStatus: "Closed",
    ListPrice: "549900",
    ClosedPrice: "530000",
    ListingContractDate: "2025-02-25",
    ModificationTimestamp: "2025-07-11T14:46:57.800Z",
    BuildingAreaTotal: "2100",
    Latitude: "44.65",
    Longitude: "-63.6",
  });
  assertEquals(row.status_id, 2);
  assertEquals(row.list_price, 549900);
  assertEquals(row.sold_price, 530000);
  assertEquals(row.sold_dt, "2025-07-11T14:46:57.800Z");
  assertEquals(row.close_dt, "2025-07-11T14:46:57.800Z");
});

Deno.test("parseEvListing — pending sold listing", () => {
  // MlsStatus: SOLD but StandardStatus not Closed → under contract; status_id 6
  const row = parseEvListing({
    id: "abc-3",
    MlsStatus: "SOLD",
    StandardStatus: "Pending",
    ListPrice: "689900",
    ClosedPrice: null,
    ListingContractDate: "2026-05-28",
    ModificationTimestamp: "2026-05-28T17:43:01.100Z",
    BuildingAreaTotal: "2248",
    Latitude: "44.6",
    Longitude: "-63.6",
  });
  assertEquals(row.status_id, 6);
  assertEquals(row.sold_price, null);
  assertEquals(row.sold_dt, null); // not "Closed" → no sold_dt
});

Deno.test("parseEvListing — closed sold with ClosedPrice null (logged-out)", () => {
  const row = parseEvListing({
    id: "abc-4",
    MlsStatus: "SOLD",
    StandardStatus: "Closed",
    ListPrice: "300000",
    ClosedPrice: null, // auth-gated; null when logged out
    ListingContractDate: "2025-05-09",
    ModificationTimestamp: "2026-06-12T00:00:00.000Z",
    BuildingAreaTotal: "1500",
    Latitude: "44.6",
    Longitude: "-63.6",
  });
  assertEquals(row.status_id, 2);
  assertEquals(row.sold_price, null);
  assertEquals(row.sold_dt, "2026-06-12T00:00:00.000Z"); // still populated
});

Deno.test("parseEvListing — empty-string and null fields coerce to null", () => {
  const row = parseEvListing({
    id: "abc-5",
    MlsStatus: "ACTIVE",
    StandardStatus: "Active",
    ListPrice: "",
    ClosedPrice: "",
    ListingContractDate: null,
    ModificationTimestamp: null,
    BuildingAreaTotal: "",
    Latitude: "",
    Longitude: "",
  });
  assertEquals(row.list_price, null);
  assertEquals(row.sold_price, null);
  assertEquals(row.list_dt, null);
  assertEquals(row.sold_dt, null);
  assertEquals(row.tla, null);
  assertEquals(row.lat, null);
  assertEquals(row.lng, null);
});

Deno.test("parseEvListing — server-tacked ListingId flows to listing_id", () => {
  const row = parseEvListing({
    id: "abc-6",
    ListingId: "202612414",
    MlsStatus: "ACTIVE",
    StandardStatus: "Active",
    ListPrice: "500000",
    ClosedPrice: null,
    ListingContractDate: "2026-01-01",
    ModificationTimestamp: "2026-01-01T00:00:00.000Z",
    BuildingAreaTotal: "1800",
    Latitude: "44",
    Longitude: "-63",
  });
  assertEquals(row.listing_id, "202612414");
});

Deno.test("parseEvListing — pid is always null on EV", () => {
  const row = parseEvListing({
    id: "abc-7",
    MlsStatus: "ACTIVE",
    StandardStatus: "Active",
    ListPrice: "500000",
    ClosedPrice: null,
    ListingContractDate: "2026-01-01",
    ModificationTimestamp: "2026-01-01T00:00:00.000Z",
    BuildingAreaTotal: "1800",
    Latitude: "44",
    Longitude: "-63",
  });
  assertEquals(row.pid, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test -A src/content/ev/__tests__/parse.test.ts`

Expected: import error — `parse.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/content/ev/parse.ts`:

```ts
import type { ListingRow } from "../../types.ts";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

// Map an Engel & Völkers RESO row (slim 10-field projection + the 4 fields the
// server always appends — createdAt, FirstMedia, ListingId, OpenHouse) to the
// canonical SeeLevel ListingRow shape. Pure. Tested.
//
// status_id mapping mirrors ViewPoint's existing constants used by aggregate.ts:
//   1 = Active, 2 = Sold (closed), 6 = Pending (under contract)
//
// sold_dt / close_dt use ModificationTimestamp as a proxy ONLY when
// StandardStatus === "Closed". The EV feed nulls CloseDate even on closed
// rows; ModificationTimestamp is the best available "this row reached its
// terminal state at" signal.
//
// lat / lng arrive on the row directly — no pid → coordinate join needed.
export function parseEvListing(raw: Record<string, unknown>): ListingRow {
  const isClosed = raw.StandardStatus === "Closed";
  const status_id = (() => {
    if (raw.MlsStatus === "ACTIVE") return 1;
    if (raw.MlsStatus === "SOLD" && isClosed) return 2;
    if (raw.MlsStatus === "SOLD") return 6;
    return 0;
  })();
  const modTs = typeof raw.ModificationTimestamp === "string"
    ? raw.ModificationTimestamp
    : null;
  return {
    id: String(raw.id ?? ""),
    listing_id: String(raw.ListingId ?? ""),
    class_id: 0,
    status_id,
    list_price: num(raw.ListPrice),
    sold_price: num(raw.ClosedPrice),
    list_dt: str(raw.ListingContractDate),
    sold_dt: isClosed ? modTs : null,
    close_dt: isClosed ? modTs : null,
    tla: num(raw.BuildingAreaTotal),
    pid: null,
    lat: num(raw.Latitude),
    lng: num(raw.Longitude),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test -A src/content/ev/__tests__/parse.test.ts`

Expected: all 7 tests pass.

- [ ] **Step 5: Run full test suite**

Run: `deno test -A src/`

Expected: existing tests still pass; the 7 new ones pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add EV RESO row parser with unit tests

Pure function mapping Engel & Völkers RESO rows to the canonical
SeeLevel ListingRow shape. status_id derivation handles the
MlsStatus + StandardStatus split (Active=1, Closed=2, Pending=6).
ModificationTimestamp serves as a sold_dt/close_dt proxy when
StandardStatus is "Closed" (the EV feed nulls CloseDate even on
closed rows). 7 test cases cover active/closed/pending, the
logged-out null-ClosedPrice case, empty-string coercion, the
server-tacked ListingId, and the pid-always-null EV convention.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: EV `sibling-fetch.ts`

The slim sibling fetcher. Module-scoped state, single exported
`fireIfNeeded(observedBody)` function called by `ev/main.ts` for every observed
`get-ev-listing` POST.

**Files:**

- Create: `src/content/ev/sibling-fetch.ts`

- [ ] **Step 1: Create the module**

Create `src/content/ev/sibling-fetch.ts`:

```ts
// MAIN-world. Fires one slim get-listing per observed page-fired get-ev-listing.
// Dedup + at-most-one-in-flight + filter-change detection are all module-scoped.
//
// Dispatches three CustomEvents on document (detail shapes documented inline):
//   - seelevel:listings    { listings, bbox, kind, status }
//   - seelevel:oversize    { bbox, count }
//   - seelevel:clear-session  (no detail)
// Plus loading_state events bracketing each fetch:
//   - seelevel:loading-state { loading: true }   before fetch
//   - seelevel:loading-state { loading: false }  in finally

import { EVT } from "../../types.ts";
import type { BBox, ListingRow, SearchStatus } from "../../types.ts";
import { parseEvListing } from "./parse.ts";

const API_URL =
  "https://dev-api.engelvoelkersnovascotia.com/api/v1/property/get-listing";
const THRESHOLD = 2000;
const SLIM_FIELDS =
  "id,MlsStatus,StandardStatus,ListPrice,ClosedPrice,ListingContractDate,ModificationTimestamp,BuildingAreaTotal,Latitude,Longitude";

let lastFiredKey: string | null = null;
let lastFilterKey: string | null = null;
let inFlight = false;

interface EvFilters {
  boundingBox?: { top: number; right: number; bottom: number; left: number };
  MlsStatus?: string[];
  [key: string]: unknown;
}

function deriveStatus(filters: EvFilters): SearchStatus {
  const s = filters.MlsStatus;
  if (!Array.isArray(s) || s.length === 0) return "any";
  if (s.length === 1 && s[0] === "ACTIVE") return "active";
  if (s.length === 1 && s[0] === "SOLD") return "sold";
  return "any";
}

function bboxFromFilters(filters: EvFilters): BBox | null {
  const b = filters.boundingBox;
  if (!b) return null;
  return { sw_lat: b.bottom, sw_lng: b.left, ne_lat: b.top, ne_lng: b.right };
}

// Called by ev/main.ts for every observed get-ev-listing POST. The argument is
// the parsed request body (not a string). We never re-parse JSON here.
export function fireIfNeeded(
  observedBody: { filters?: EvFilters } | null,
): void {
  if (!observedBody || !observedBody.filters) return;
  const filters = observedBody.filters;
  const bbox = bboxFromFilters(filters);
  if (!bbox) return; // page hasn't settled on a viewport yet

  // Detect filter change (everything in filters except boundingBox) → clear session.
  const { boundingBox: _b, ...filtersSansBbox } = filters;
  const filterKey = JSON.stringify(filtersSansBbox);
  if (lastFilterKey !== null && lastFilterKey !== filterKey) {
    document.dispatchEvent(new CustomEvent(EVT.clearSession));
  }
  lastFilterKey = filterKey;

  // Dedup against the most recently fired (bbox, filters) pair.
  const firedKey = JSON.stringify({
    bbox: filters.boundingBox,
    filters: filtersSansBbox,
  });
  if (firedKey === lastFiredKey) return;

  // At-most-one-in-flight; next page-fired trigger retriggers.
  if (inFlight) return;

  lastFiredKey = firedKey;
  inFlight = true;
  document.dispatchEvent(
    new CustomEvent(EVT.loadingState, { detail: { loading: true } }),
  );

  void fireSlim(filters, bbox);
}

async function fireSlim(filters: EvFilters, bbox: BBox): Promise<void> {
  try {
    const token = localStorage.getItem("authToken");
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const body = {
      limit: 2001,
      skip: 0,
      sortBy: "ModificationTimestamp",
      sortOrder: "desc",
      fields: SLIM_FIELDS,
      filters, // verbatim copy — includes boundingBox + MlsStatus + anything else
    };

    const r = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      // 401 (token expired), 4xx, 5xx — silently swallow per spec.
      if (r.status === 400) {
        try {
          console.warn(
            "[seelevel] EV sibling 400:",
            (await r.text()).slice(0, 200),
          );
        } catch {}
      }
      return;
    }
    const json = await r.json() as {
      data?: {
        mlsPropertyResult?: {
          count?: number;
          rows?: Record<string, unknown>[];
        };
      };
    };
    const result = json?.data?.mlsPropertyResult;
    if (!result || typeof result.count !== "number") {
      try {
        console.warn("[seelevel] EV sibling: malformed response");
      } catch {}
      return;
    }

    if (result.count > THRESHOLD) {
      document.dispatchEvent(
        new CustomEvent(EVT.oversize, {
          detail: { bbox, count: result.count },
        }),
      );
      return;
    }

    const rows = Array.isArray(result.rows) ? result.rows : [];
    const listings: ListingRow[] = rows.map(parseEvListing);
    document.dispatchEvent(
      new CustomEvent(EVT.listings, {
        detail: {
          listings,
          bbox,
          kind: "search" as const,
          status: deriveStatus(filters),
        },
      }),
    );
  } catch {
    // Network error / abort / aborted JSON — silent. Next pan retriggers.
  } finally {
    inFlight = false;
    document.dispatchEvent(
      new CustomEvent(EVT.loadingState, { detail: { loading: false } }),
    );
  }
}
```

- [ ] **Step 2: Run typecheck via build**

Run: `deno run -A build.ts`

Expected: `Build complete.` (No new build entry yet; the file just type-checks
as an orphan import target.)

Actually — the module isn't an entry point yet, so esbuild won't catch it. To
verify it type-checks, run:

```bash
deno check src/content/ev/sibling-fetch.ts
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add EV slim sibling fetcher

MAIN-world module called by ev/main.ts for every observed
get-ev-listing POST. Copies the page's boundingBox + filters
verbatim, requests a slim 10-field projection at limit:2001,
dispatches seelevel:listings on success (count ≤ 2000),
seelevel:oversize on count > 2000, seelevel:clear-session on
filter change. Brackets each fetch with seelevel:loading-state
events. Dedup + at-most-one-in-flight + try/finally guard
against page disruption and stuck loading state.

Wired into ev/main.ts in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: EV MAIN-world entry (`ev/main.ts`)

Installs the shared Google Maps hook, patches XHR to observe `get-ev-listing`,
and routes observations into `sibling-fetch`. The XHR patch follows the same
"never disrupt the page" discipline as ViewPoint's `fetch-interceptor.ts` —
try/catch around every observation point, request arguments forwarded verbatim,
no expandos on the XHR object.

**Files:**

- Create: `src/content/ev/main.ts`

- [ ] **Step 1: Create the module**

Create `src/content/ev/main.ts`:

```ts
// MAIN-world entry for engelvoelkersnovascotia.com.
// Two responsibilities:
//   1. Install the shared google.maps.Map constructor hook (bounds → seelevel:bbox).
//   2. Observe outbound get-ev-listing POSTs and forward to ev/sibling-fetch.ts.

// deno-lint-ignore-file no-explicit-any

import { installGoogleMapsHook } from "../shared/google-maps-hook.ts";
import { fireIfNeeded } from "./sibling-fetch.ts";

installGoogleMapsHook();

// ─── XHR observation ──────────────────────────────────────────────────────────
// Mirrors the disciplined pattern in src/content/fetch-interceptor.ts:
//   - request arguments forwarded verbatim
//   - all observation wrapped in try/catch — never block the page
//   - URL stashed in a WeakMap, not as an expando
//   - body parsed defensively from string OR JSON-serialized request body

const EV_TRIGGER_PATH = "/api/v1/property/get-ev-listing";

const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;

const urlByXhr = new WeakMap<XMLHttpRequest, string>();
const bodyByXhr = new WeakMap<XMLHttpRequest, string>();

function maskAsNative(
  patched: (...a: any[]) => any,
  original: (...a: any[]) => any,
): void {
  try {
    Object.defineProperty(patched, "name", {
      value: original.name,
      configurable: true,
    });
    Object.defineProperty(patched, "length", {
      value: original.length,
      configurable: true,
    });
    Object.defineProperty(patched, "toString", {
      value: original.toString.bind(original),
      writable: true,
      configurable: true,
    });
  } catch { /* best-effort */ }
}

const patchedOpen = function (this: XMLHttpRequest) {
  try {
    urlByXhr.set(this, String(arguments[1]));
  } catch { /* never block */ }
  return (origOpen as any).apply(this, arguments);
};
maskAsNative(patchedOpen, origOpen);
XMLHttpRequest.prototype.open = patchedOpen as any;

const patchedSend = function (this: XMLHttpRequest, body?: any) {
  try {
    const url = urlByXhr.get(this) ?? "";
    if (url.includes(EV_TRIGGER_PATH) && typeof body === "string") {
      bodyByXhr.set(this, body);
      // Defer observation off the page's callback stack.
      this.addEventListener("loadend", () => {
        try {
          const stashed = bodyByXhr.get(this);
          if (!stashed) return;
          const parsed = JSON.parse(stashed);
          fireIfNeeded(parsed);
        } catch { /* never block */ }
      });
    }
  } catch { /* never block */ }
  return (origSend as any).apply(this, arguments);
};
maskAsNative(patchedSend, origSend);
XMLHttpRequest.prototype.send = patchedSend as any;

// Also observe fetch() in case the page ever switches API client.
const origFetch = window.fetch;
window.fetch = function (input, init) {
  const promise = origFetch.apply(this, arguments as any);
  try {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (
      url && url.includes(EV_TRIGGER_PATH) && init?.body &&
      typeof init.body === "string"
    ) {
      try {
        const parsed = JSON.parse(init.body);
        // Fire after the page's own fetch settles, so we don't race the page's
        // own UI updates (mirrors the XHR loadend timing).
        promise.then(() => fireIfNeeded(parsed)).catch(() => {});
      } catch { /* never block */ }
    }
  } catch { /* never block */ }
  return promise;
};
```

- [ ] **Step 2: Run typecheck**

Run: `deno check src/content/ev/main.ts`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add EV MAIN-world entry

Installs the shared google.maps.Map hook and patches XHR + fetch
on engelvoelkersnovascotia.com. Every outbound get-ev-listing POST
(the page's own viewport-settle signal) is observed loadend-side
and forwarded to ev/sibling-fetch.ts, which fires our slim sibling
get-listing with the copied bbox + filters. Disciplined pattern
mirrors src/content/fetch-interceptor.ts: every observation
try/catch-wrapped, request args forwarded verbatim, WeakMap for
URL/body stashing, no extension marker on XHR objects.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: EV ISOLATED relay (`ev/relay.ts`)

Opens the `"relay"` port to the SW broker. Listens for the four EV-side
CustomEvents and translates them into `ContentToPanel` envelopes. Initializes
the shared `geofence-overlay` exactly the way ViewPoint's relay does. Same
reconnect-with-backoff pattern.

**Files:**

- Create: `src/content/ev/relay.ts`

- [ ] **Step 1: Create the relay**

Create `src/content/ev/relay.ts`:

```ts
/// <reference types="chrome"/>
import { EVT } from "../../types.ts";
import type {
  BBox,
  ContentToPanel,
  ListingRow,
  RelayDown,
  RelayUp,
  SearchStatus,
} from "../../types.ts";
import {
  clearZone,
  getCurrentPolygon,
  initGeofenceOverlay,
  setDrawPrompt,
  setOnZoneChange,
  setOverlayVisible,
  syncMapView,
} from "../geofence-overlay.ts";

let lastBbox: BBox | null = null;
let lastOversize: { bbox: BBox; count: number } | null = null;
let lastLoading = false;

// Buffered between content-script load and panel_opened — same pattern as the
// ViewPoint relay. We keep a Map<id, ListingRow> so re-emission on panel_opened
// is one batch, not a replay of every individual fetch.
const sessionListings = new Map<string, ListingRow>();

let port: chrome.runtime.Port = openPort();
let panelOpen = false;
let reconnectTimeout: number | undefined;
let reconnectDelay = 1000;

function openPort(): chrome.runtime.Port {
  const name = sessionListings.size > 0 ? "relay-reconnect" : "relay";
  const p = chrome.runtime.connect({ name });
  p.onMessage.addListener((msg: RelayDown) => {
    reconnectDelay = 1000;
    if (msg.type === "panel_opened") {
      panelOpen = true;
      reEmit();
      return;
    }
    if (msg.type === "msg") {
      if (msg.payload.type === "zone_prompt") {
        setDrawPrompt(msg.payload.active);
      } else if (msg.payload.type === "clear_zone") {
        clearZone();
      }
    }
  });
  p.onDisconnect.addListener(() => {
    panelOpen = false;
    scheduleReconnect();
  });
  return p;
}

function scheduleReconnect(): void {
  if (reconnectTimeout !== undefined) return;
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = undefined;
    try {
      port = openPort();
    } catch {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      scheduleReconnect();
      return;
    }
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }, reconnectDelay);
}

function emit(payload: ContentToPanel): void {
  if (!panelOpen) return;
  try {
    port.postMessage({ type: "msg", payload } satisfies RelayUp);
  } catch { /* port disconnected — reconnect will fire */ }
}

function reEmit(): void {
  if (lastBbox) emit({ type: "viewport_bbox", bbox: lastBbox });
  emit({ type: "zone", polygon: getCurrentPolygon() });
  emit({ type: "loading_state", loading: lastLoading });
  if (lastOversize) {
    emit({
      type: "oversize_bbox",
      bbox: lastOversize.bbox,
      count: lastOversize.count,
    });
  } else if (sessionListings.size > 0) {
    // Replay the accumulated session as one batch — the panel reducer merges
    // by id, so dedup is automatic. No bbox/kind on a replay (it's session
    // state, not a fresh search result).
    emit({
      type: "listings",
      listings: Array.from(sessionListings.values()),
      properties: [],
      bbox: null,
      kind: "global",
      status: "any",
    });
  }
}

// ─── Wire events from ev/main.ts (MAIN world via CustomEvent) ──────────────

document.addEventListener(EVT.bbox, (e) => {
  const d = (e as CustomEvent<
    BBox & {
      center_lat?: number;
      center_lng?: number;
      zoom?: number;
      settled?: boolean;
    }
  >).detail;
  lastBbox = {
    sw_lat: d.sw_lat,
    sw_lng: d.sw_lng,
    ne_lat: d.ne_lat,
    ne_lng: d.ne_lng,
  };
  syncMapView(
    d.sw_lat,
    d.sw_lng,
    d.ne_lat,
    d.ne_lng,
    d.center_lat,
    d.center_lng,
    d.zoom,
  );
  setOverlayVisible(true);
  if (d.settled) emit({ type: "viewport_bbox", bbox: lastBbox });
});

document.addEventListener(EVT.mapbusy, () => setOverlayVisible(false));

document.addEventListener(EVT.listings, (e) => {
  const detail = (e as CustomEvent<{
    listings: ListingRow[];
    bbox: BBox;
    kind: "search" | "global";
    status: SearchStatus;
  }>).detail;
  if (!detail || !Array.isArray(detail.listings)) return;
  for (const l of detail.listings) {
    const prev = sessionListings.get(l.id);
    sessionListings.set(
      l.id,
      prev ? { ...l, lat: l.lat ?? prev.lat, lng: l.lng ?? prev.lng } : l,
    );
  }
  lastOversize = null;
  emit({
    type: "listings",
    listings: detail.listings,
    properties: [],
    bbox: detail.bbox,
    kind: detail.kind,
    status: detail.status,
  });
  emit({ type: "zone", polygon: getCurrentPolygon() });
});

document.addEventListener(EVT.oversize, (e) => {
  const detail = (e as CustomEvent<{ bbox: BBox; count: number }>).detail;
  if (!detail) return;
  lastOversize = { bbox: detail.bbox, count: detail.count };
  emit({ type: "oversize_bbox", bbox: detail.bbox, count: detail.count });
});

document.addEventListener(EVT.loadingState, (e) => {
  const detail = (e as CustomEvent<{ loading: boolean }>).detail;
  if (!detail) return;
  lastLoading = detail.loading;
  emit({ type: "loading_state", loading: detail.loading });
});

document.addEventListener(EVT.clearSession, () => {
  sessionListings.clear();
  lastOversize = null;
  emit({ type: "clear_session" });
});

// Zone overlay — same wiring as ViewPoint relay.
setOnZoneChange((polygon) => emit({ type: "zone", polygon }));
initGeofenceOverlay();
```

- [ ] **Step 2: Run typecheck**

Run: `deno check src/content/ev/relay.ts`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add EV ISOLATED relay

Opens the "relay" port to the SW broker, listens for the four
EV-side CustomEvents (seelevel:bbox, listings, oversize, loading,
clear-session), translates them into ContentToPanel envelopes,
and instantiates the shared geofence-overlay against EV's map.
Same reconnect-with-backoff + relay-reconnect port-name pattern
as the ViewPoint relay. Session listings buffered between page
load and panel_opened so a late-mounting panel sees state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Wire manifest + build for the EV adapter

Add the two `content_scripts` entries and the two new esbuild builds. After this
commit, the dev build produces `build/content/ev/main.js` and
`build/content/ev/relay.js`, and reloading the extension activates the EV
adapter.

**Files:**

- Modify: `manifest.json`
- Modify: `build.ts`

- [ ] **Step 1: Add the two EV content_scripts entries**

Edit `manifest.json` — extend the `content_scripts` array with two entries
(insert after the existing two, before the closing `]`):

```jsonc
"content_scripts": [
  {
    "matches": ["*://*.viewpoint.ca/map*"],
    "js": ["content/fetch-interceptor.js"],
    "run_at": "document_start",
    "world": "MAIN"
  },
  {
    "matches": ["*://*.viewpoint.ca/map*"],
    "js": ["content/relay.js"],
    "run_at": "document_start",
    "world": "ISOLATED"
  },
  {
    "matches": ["https://engelvoelkersnovascotia.com/*"],
    "js": ["content/ev/main.js"],
    "run_at": "document_start",
    "world": "MAIN"
  },
  {
    "matches": ["https://engelvoelkersnovascotia.com/*"],
    "js": ["content/ev/relay.js"],
    "run_at": "document_start",
    "world": "ISOLATED"
  }
]
```

Verify `permissions` is still exactly `["sidePanel"]`. Do NOT add
`host_permissions`.

- [ ] **Step 2: Bump the manifest version**

In `manifest.json`, change `"version": "0.1.1"` to `"version": "0.2.0"` (new
minor — second adapter is a meaningful feature addition).

- [ ] **Step 3: Update `build.ts` to include EV bundles**

In `build.ts`, find the `await Promise.all([…])` block with the four esbuild
builds. Add two more entries inside the array (after the existing four):

```ts
esbuild.build({
  ...shared,
  entryPoints: [join(dir, "src/content/ev/main.ts")],
  outfile: join(dir, "build/content/ev/main.js"),
  format: "iife",
}),
esbuild.build({
  ...shared,
  entryPoints: [join(dir, "src/content/ev/relay.ts")],
  outfile: join(dir, "build/content/ev/relay.js"),
  format: "iife",
}),
```

Also extend the post-build `Function("return this")()` strip loop (further down
in `build.ts`) to include the new EV outputs:

```ts
for (
  const rel of [
    "build/content/fetch-interceptor.js",
    "build/content/relay.js",
    "build/content/ev/main.js",
    "build/content/ev/relay.js",
    "build/background/sw.js",
    "build/panel/panel.js",
  ]
) {
  // …existing loop body unchanged…
}
```

- [ ] **Step 4: Run dev build**

Run: `deno run -A build.ts`

Expected: `Build complete.` Verify the new files exist:

```bash
ls -la build/content/ev/
```

Expected: `main.js` and `relay.js` present.

- [ ] **Step 5: Reload extension and smoke-test BOTH sites**

In `chrome://extensions`, reload SeeLevel. Then:

**ViewPoint smoke test:**

- Visit `https://viewpoint.ca/map`, open side panel.
- Pan, verify listings appear; draw a zone, verify coverage. (No regressions
  from the rename / shared-hook extraction.)

**Engel & Völkers smoke test:**

- Visit `https://engelvoelkersnovascotia.com/map`, open side panel.
- Without logging in: pan around — active listings should flow into the panel
  (slim sibling fires without auth, ACTIVE filter is the page's default).
  Metrics for active appear.
- Open Chrome DevTools Network tab on the EV page, filter for `get-listing`.
  Confirm exactly one extension-initiated request with body containing
  `"limit":2001` and the slim `fields` whitelist per viewport-settle.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Wire EV adapter into manifest + build

Adds two content_scripts entries (engelvoelkersnovascotia.com/*,
MAIN + ISOLATED), two esbuild bundles (ev/main.js, ev/relay.js),
and bumps the manifest to 0.2.0 (second host-site adapter is
the headline change).

permissions stays ["sidePanel"]; host_permissions still absent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Update permissions-minimization spec doc

Edits to `docs/superpowers/specs/2026-05-26-permissions-minimization-design.md`
per § 11 of the EV adapter spec. Five concrete edits.

**Files:**

- Modify: `docs/superpowers/specs/2026-05-26-permissions-minimization-design.md`

- [ ] **Step 1: Read the existing doc to identify edit anchors**

Open the doc. Note the locations of:

- The "zero extra API requests" property (likely in § 1 Overview or § 2
  Goals/Non-Goals).
- The Manifest Permissions / Manifest Delta section.
- The Zone Overlay section.

- [ ] **Step 2: Add a "Per-adapter compliance table" subsection**

Near the top of the doc (right after § 1 Overview, before § 2), insert a new
subsection:

```markdown
## 1.1 Per-Adapter Compliance Table

The "zero extra API requests" property declared in this document originally
covered the only adapter that existed at the time (ViewPoint). The Engel &
Völkers adapter (spec: `2026-05-29-engelvoelkers-adapter-design.md`) introduces
a single extension-initiated request per viewport-settle for that host only.
Per-adapter behavior:

| Adapter                                           | Intercepted requests                              | Extension-initiated requests                                                                                                                                                                | Notes                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ViewPoint (`viewpoint.ca/*`)                      | Page-fired XHRs only (passive observation)        | **None**                                                                                                                                                                                    | Zero extra API requests. Unchanged.                                                                                    |
| Engel & Völkers (`engelvoelkersnovascotia.com/*`) | Page-fired XHRs observed for bbox + filter signal | **Exactly one slim `get-listing` per viewport-settle**, fired from MAIN world, copying the user's `authToken` from `localStorage["authToken"]` (or fired without auth header if logged out) | Slim projection (10 fields, ~460 B/row), `limit:2001`, dedup'd + at-most-one-in-flight, ~0.5–3 MB per typical viewport |

### Rationale for the EV relaxation

EV's UI feed paginates `get-listing` at `limit:10`. Pure passive observation
would require the user to scroll dozens of pages per viewport to populate any
SeeLevel aggregate — the same UX failure mode the Permissions-Minimization spec
was originally written to avoid for ViewPoint. The slim sibling is fired from
page context (MAIN-world fetch, same `Origin: engelvoelkersnovascotia.com`, no
host_permissions required in the manifest). From the EV server's CORS standpoint
the request is indistinguishable from a page-native one; from the Chrome Web
Store review standpoint the manifest's `host_permissions` key remains absent and
`permissions` remains exactly `["sidePanel"]`.

### Headline summary

**ViewPoint:** SeeLevel is a pure passive observer; the network footprint with
SeeLevel installed is bit-identical to the footprint without it. **Engel &
Völkers:** SeeLevel adds exactly one request per viewport-settle — a slim
10-field `get-listing` projection issued from page context, capped at 2001 rows,
dedup'd against the previous trigger, throttled at-most-one-in-flight. No new
manifest permissions, no new origins beyond `content_scripts.matches`, no
persisted data, no auth tokens stored or transmitted off-device.
```

- [ ] **Step 3: Update the Manifest section**

In the Manifest-related section, append (or update an existing list) noting that
`content_scripts.matches` grows by one host:

```markdown
**Update for the EV adapter (v0.2.0):** `content_scripts.matches` gains
`https://engelvoelkersnovascotia.com/*` (one entry each for the MAIN and
ISOLATED bundles). No change to `permissions` — still exactly `["sidePanel"]`.
No `host_permissions`, no `activeTab`, no `storage`, no `tabs`, no `scripting`,
no `webRequest`, no `cookies`. The only manifest delta is `content_scripts`.
```

- [ ] **Step 4: Update the Zone Overlay section**

Find the section describing the geofence overlay (search for "geofence",
"Leaflet", or "overlay"). Append:

```markdown
**Update for the EV adapter:** Both adapters use SeeLevel's existing
Leaflet+Geoman overlay module (bundled into ISOLATED relay), rendered as a
transparent layer on top of each site's `google.maps.Map`. One implementation,
both adapters; only the relay's data-event listener set differs between them.
```

- [ ] **Step 5: Status update**

If the doc has a status field at the top (e.g., `**Status:** Approved`), append
a note that the doc was amended on 2026-05-29 for the EV adapter — or update the
date if appropriate. Use your judgment based on the existing format.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Update permissions-minimization spec for the EV adapter

Adds a per-adapter compliance table (ViewPoint = zero extra
requests; EV = one slim sibling per viewport-settle), the
rationale paragraph for the EV relaxation, an updated manifest
delta note, and a zone-overlay clarification that both
adapters share the same Leaflet+Geoman implementation.

Sourced from § 11 of the EV adapter spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Update EULA copy for the EV adapter

The current EULA gate text describes only ViewPoint behavior. Add an EV-aware
sentence so users see the disclosure regardless of which site is in the active
tab. Show both unconditionally (the gate doesn't currently know per-tab origin,
and adding that plumbing is more code than the simpler "both sites disclosed"
approach).

**Files:**

- Modify: `src/panel/components/EulaGate.tsx`

- [ ] **Step 1: Replace the data-disclosure paragraph**

In `src/panel/components/EulaGate.tsx`, find the second `<p>` block (the one
currently reading "Data: NSAR MLS® via ViewPoint.ca. This extension does not
store, transmit, or redistribute listing data."). Replace it with:

```tsx
<p
  style={{
    fontSize: "10px",
    color: "var(--color-muted)",
    lineHeight: 1.6,
  }}
>
  Data: NSAR MLS® via ViewPoint.ca and engelvoelkersnovascotia.com. On
  ViewPoint, SeeLevel observes data your browser already receives. On Engel &
  Völkers, SeeLevel issues one small filtered request per map move to provide
  complete viewport coverage, using your existing session. Nothing is stored,
  transmitted off-device, or redistributed.
</p>;
```

- [ ] **Step 2: Run dev build**

Run: `deno run -A build.ts`

Expected: `Build complete.`

- [ ] **Step 3: Smoke test the gate**

Reload the extension. Open the side panel on either site — confirm the gate
displays the new copy, and the "I understand — continue" button still works.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Update EULA disclosure for the EV adapter

The gate now discloses both sites' data sources and notes the
EV-specific extension-initiated request per map move. Shown
unconditionally — the gate doesn't (and doesn't need to) know
which tab is active.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: End-to-end manual verification

No code. Walk the spec's § 9 checklist with the rebuilt extension.

**Files:** none.

- [ ] **Step 1: Run the full build + test suite**

```bash
deno fmt && deno lint && deno test -A src/ && deno run -A build.ts
```

Expected: formatter clean, linter clean, all tests pass, build succeeds.

- [ ] **Step 2: Reload extension in `chrome://extensions`**

- [ ] **Step 3: Logged-out EV verification**

Visit `https://engelvoelkersnovascotia.com/map` (not logged in). Open side
panel.

- Acknowledge EULA — new copy shows both sites' disclosures.
- Pan around. Active inventory metrics populate after the first pan.
- Switch between Viewport / Session / Zone scopes; each behaves correctly.
- DevTools Network tab: confirm exactly one extra `get-listing` POST per
  viewport-settle, with `limit:2001` and the slim `fields` whitelist.

- [ ] **Step 4: Log in to EV, repeat with Sold filter**

After logging in, change the EV filter to Sold. Verify:

- Slim sibling now attaches `Authorization: Bearer …` (visible in DevTools
  request headers).
- Sold-side metrics (list→sold %, sold $/sqft, sold volume) populate.
- ClosedPrice-populated rows show up in row dumps.

- [ ] **Step 5: Trigger oversize state**

Zoom out on EV until the visible bbox would return > 2000 sold rows (e.g., zoom
to province-wide).

- Viewport scope: OversizeNotice block appears in place of metrics, showing the
  count.
- Header count chip is hidden.
- Switch to Session scope: existing accumulated metrics still render;
  OversizeNotice badge appears in the header row.
- Switch to Zone scope: same badge; zone coverage % does NOT advance for the
  oversize bbox.
- Zoom back in: oversize state clears on the next successful fetch, metrics
  return.

- [ ] **Step 6: Verify spinner**

With panel open on EV, pan to a fresh area. Confirm the spinner shows briefly in
the empty body before the fetch completes (may need to throttle network to "Slow
3G" in DevTools to see it).

- [ ] **Step 7: Filter change clears session**

Toggle EV filter from Active → Sold (or vice versa). Confirm session listings
are cleared (previous data disappears), then refills from the next slim sibling.

- [ ] **Step 8: Verify zone drawing works on EV**

On the EV map, click the ⬡ Draw Zone button (bottom-right area). Click to place
polygon vertices, double-click or use the button to complete. Verify:

- Polygon appears overlaid on the Google Maps canvas.
- Zone scope shows session ∩ polygon listings.
- Coverage % grows as you pan to fill the zone with successful (≤2000) bboxes.
- "✕ Clear" button removes the polygon; zone scope reverts.

- [ ] **Step 9: Multi-tab isolation**

Open EV in one tab AND ViewPoint in another tab. Switch the panel's active tab
between them. Each tab's session / oversize / loading state stays isolated.

- [ ] **Step 10: SW restart resilience**

In `chrome://extensions`, click the SW link (under SeeLevel) → "Stop service
worker". Then pan on the EV map. Confirm the panel reconnects and state catches
up after the next pan (may take 1-2 seconds for the relay's reconnect backoff).

- [ ] **Step 11: ViewPoint regression check**

Visit `https://viewpoint.ca/map`. Verify everything works as it did before the
EV adapter landed — pans, zone drawing, NEW TODAY, panel content.

- [ ] **Step 12: Confirm no leftovers**

Run: `grep -rn 'vpa' src/ manifest.json build.ts docs/superpowers/`

Expected: no matches (or only matches inside this plan doc / spec doc as
references to the old name in the rename explanation — those are documentation,
not code).

- [ ] **Step 13: Push branch / open PR**

If working on a branch:

```bash
git push -u origin <branch>
gh pr create --title "Add Engel & Völkers adapter" --body "$(cat <<'EOF'
## Summary
- Second host-site adapter for engelvoelkersnovascotia.com/map with metric parity to ViewPoint
- One slim-projection get-listing per viewport-settle, fired from page context (no host_permissions)
- Oversize state (block notice in viewport scope, badge in session/zone scope) for >2000-row viewports
- Loading spinner when scope is empty and a fetch is in flight
- Reuses the existing Leaflet+Geoman geofence overlay unchanged
- Precursor: vpa → seelevel rename across CSS classes, CustomEvent names, internal flags

## Test plan
- [ ] Logged-out EV: active inventory metrics populate after first pan
- [ ] Logged-in EV, Sold filter: sold-side metrics populate, request carries Bearer JWT
- [ ] Oversize trigger: notice + badge render correctly, zone coverage unaffected
- [ ] Spinner shows when scope empty and fetch in flight
- [ ] Filter change clears session
- [ ] Zone drawing works on EV's Google Maps via the shared overlay
- [ ] Multi-tab isolation works
- [ ] SW restart resilience works
- [ ] ViewPoint regression check passes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If working on `main` directly (per the user's preference in
`~/.claude/CLAUDE.md`: "Always work on the current main branch unless explicitly
told to use a worktree or feature branch"), just push to `main` after explicit
user authorization.

---

## Plan Self-Review Notes

**Spec coverage check:**

- § 1 Overview → Tasks 7–11
- § 2 Goals/Non-Goals → all tasks respect these
- § 3 Architecture / File Layout → Tasks 7–11
- § 3.1 Shared google-maps-hook → Task 2
- § 4 Slim Sibling Fetch → Task 8 (sibling-fetch.ts), Task 7 (parse mapping)
- § 5 Data Flow → Task 6 (reducer + render branches), Tasks 8–10 (event flow)
- § 6 Zone Drawing UI → Task 10 (reuses existing overlay)
- § 7 OversizeNotice & Spinner → Tasks 4–5
- § 8 Error Handling → Task 8 (silent swallow in slim sibling)
- § 9 Testing → Task 7 (TDD parse), Task 14 (manual checklist)
- § 10 Precursor Rename → Task 1
- § 11 Permissions Doc Update → Task 12
- § 11 EULA Copy → Task 13
- § 12 Compliance preserved → respected in Tasks 8, 11, 13
- § 13 Scope Out → no tasks (deliberately excluded)

All spec sections have implementing tasks.

**Type consistency check:**

- `parseEvListing(raw)` signature: Task 7 defines it; Task 8 imports + calls it
  as `rows.map(parseEvListing)`. ✓
- `fireIfNeeded(observedBody)` signature: Task 8 defines it; Task 9 imports +
  calls it as `fireIfNeeded(parsed)`. ✓
- `installGoogleMapsHook()` signature: Task 2 defines it; Task 9 imports + calls
  it. ✓
- `EVT` constants: Task 1 defines them; Tasks 2, 8, 9, 10 import. ✓
- `TabStore.oversizeBbox/oversizeCount/loading`: Task 3 defines; Task 6 reads. ✓
- ContentToPanel variants `oversize_bbox` and `loading_state`: Task 3 defines;
  Tasks 6 (reducer) and 10 (emitter) use. ✓

No naming drift detected.

**Placeholder scan:** No "TBD", "TODO", "implement later", "add appropriate
error handling", or unreferenced functions. Every step shows the exact code or
exact command.
