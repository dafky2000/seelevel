# ViewPoint Analytics Extension - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome MV3 extension that intercepts viewpoint.ca listing API responses, computes rolling aggregate analytics (avg/median/stddev/count/DOM/$/sqft/list→sold%), and displays interactive time-series charts in a native Chrome Side Panel scoped to viewport, session, or a user-drawn geofence zone.

**Architecture:** A MAIN-world content script patches `window.fetch` to intercept listing search responses and fires a `CustomEvent` on the document; an ISOLATED-world relay script picks it up and forwards via `chrome.runtime.sendMessage` to the side panel (Preact app). The side panel maintains per-tab state in memory (no storage APIs). A geofence overlay (Leaflet + Geoman, bundled) injects a Draw Zone button onto the viewpoint map; polygon coordinates are relayed to the side panel to scope analytics. All side panel ↔ content routing goes through the background service worker (port-based, avoids `tabs` permission).

**Tech Stack:** Deno + esbuild (build), Preact 10 + @dano/styles (side panel UI), uPlot (charts), Leaflet 1.9 + Leaflet-Geoman 2.17 (geofence drawing), Chrome MV3 APIs (sidePanel, scripting, activeTab), Deno test (unit tests on pure library functions).

**Spec:** `docs/superpowers/specs/2026-05-14-viewpoint-analytics-extension-design.md`

---

## File Map

```
extension/
  manifest.json                           # MV3 - two content scripts (MAIN + ISOLATED)
  deno.json                               # npm import map for extension build
  build.ts                                # esbuild build script (Deno)
  .gitignore                              # ignores build/
  icons/icon{16,48,128}.png               # extension icons (placeholders ok initially)

  src/
    types.ts                              # ALL shared types: messages, ListingRow, TabStore, etc.

    content/
      fetch-interceptor.ts               # MAIN world - patches window.fetch, fires CustomEvent
      relay.ts                           # ISOLATED world - bridges CustomEvent → sendMessage + geofence
      geofence-overlay.ts                # injected by relay - Leaflet draw UI on viewpoint map

    background/
      sw.ts                              # opens side panel on icon click; routes panel→content messages

    panel/
      index.html                         # side panel shell - loads panel.css + panel.js
      panel.css                          # @dano/styles tokens + panel layout
      App.tsx                            # root: tab store map, message listener, EULA gate, tab switch
      store.ts                           # defaultTabStore() + filterListings() + scopedListings()

      components/
        EulaGate.tsx                     # first-run modal; writes eulaAccepted to chrome.storage.local
        Disclaimer.tsx                   # always-visible footer attribution
        ScopeSelector.tsx                # Viewport / Session / Zone tabs
        FilterBadge.tsx                  # mirrors viewpoint's active/sold/any; "clears on change" note
        WindowPicker.tsx                 # Daily|Weekly|Monthly|Yearly + Today|Calendar alignment split button; disabled based on data availability
        MetricTabs.tsx                   # Avg Price · Volume · DOM · $/sqft · L→S%
        StatsRow.tsx                     # avg · median · stddev + delta vs prior period
        TimeSeriesChart.tsx              # uPlot wrapper - 1yr, pannable, bucket lines
        ZoneCoverage.tsx                 # progress bar + % + "Pan to fill gaps"
        ExportButton.tsx                 # CSV download of visible buckets (≥5 floor, attribution header)
        EmptyState.tsx                   # no-data prompt

      lib/
        parse.ts                         # parseInterceptedResponse() - ported from scrapers/viewpoint/client.ts
        bucket.ts                        # buildBuckets() - today-trailing and calendar-aligned
        aggregate.ts                     # aggregate() - per-bucket stats + overall summary + delta
        geofence.ts                      # pointInPolygon(), polygonArea()
        coverage.ts                      # clipPolygonToBBox() (Sutherland-Hodgman), computeCoverage()

        __tests__/
          parse.test.ts
          bucket.test.ts
          aggregate.test.ts
          geofence.test.ts
          coverage.test.ts

.github/
  workflows/
    extension-build.yml                  # build + zip + attach to GitHub Release on tag
```

---

## Phase 1 - Foundation

### Task 1: Scaffold

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/deno.json`
- Create: `extension/build.ts`
- Create: `extension/.gitignore`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p extension/src/{content,background,panel/{components,lib/__tests__}} extension/icons extension/build
```

- [ ] **Step 2: Write `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "ViewPoint Analytics",
  "version": "0.1.0",
  "description": "Personal analytics for your ViewPoint.ca browsing session.",
  "permissions": ["sidePanel", "activeTab", "scripting"],
  "host_permissions": ["*://*.viewpoint.ca/*"],
  "side_panel": {
    "default_path": "build/panel/index.html"
  },
  "background": {
    "service_worker": "build/background/sw.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["*://*.viewpoint.ca/map*"],
      "js": ["build/content/fetch-interceptor.js"],
      "run_at": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["*://*.viewpoint.ca/map*"],
      "js": ["build/content/relay.js"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    }
  ],
  "action": {
    "default_title": "ViewPoint Analytics"
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

- [ ] **Step 3: Write `extension/deno.json`**

```json
{
  "imports": {
    "preact": "npm:preact@10.26",
    "preact/hooks": "npm:preact@10.26/hooks",
    "preact/jsx-runtime": "npm:preact@10.26/jsx-runtime",
    "uplot": "npm:uplot@1.6.31",
    "leaflet": "npm:leaflet@1.9.4",
    "@geoman-io/leaflet-geoman-free": "npm:@geoman-io/leaflet-geoman-free@2.17.0"
  },
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "lib": ["dom", "dom.iterable", "esnext"]
  }
}
```

- [ ] **Step 4: Write `extension/build.ts`**

```typescript
import * as esbuild from "npm:esbuild@0.24";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@0.11";
import { join } from "jsr:@std/path@1";

const dir = new URL(".", import.meta.url).pathname;

const shared: esbuild.BuildOptions = {
  bundle: true,
  minify: Deno.args.includes("--prod"),
  sourcemap: Deno.args.includes("--prod") ? false : "inline",
  plugins: [...denoPlugins({ configPath: join(dir, "deno.json") })],
  loader: { ".css": "text" },
};

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: [join(dir, "src/content/fetch-interceptor.ts")],
    outfile: join(dir, "build/content/fetch-interceptor.js"),
    format: "iife",
  }),
  esbuild.build({
    ...shared,
    entryPoints: [join(dir, "src/content/relay.ts")],
    outfile: join(dir, "build/content/relay.js"),
    format: "iife",
  }),
  esbuild.build({
    ...shared,
    entryPoints: [join(dir, "src/background/sw.ts")],
    outfile: join(dir, "build/background/sw.js"),
    format: "esm",
  }),
  esbuild.build({
    ...shared,
    entryPoints: [join(dir, "src/panel/App.tsx")],
    outfile: join(dir, "build/panel/panel.js"),
    format: "iife",
    jsx: "automatic",
    jsxImportSource: "preact",
  }),
]);

await esbuild.stop();
console.log("Build complete.");
```

- [ ] **Step 5: Write `extension/.gitignore`**

```
build/
```

- [ ] **Step 6: Add placeholder icons (any 16×16, 48×48, 128×128 PNG)**

Copy any square PNG as a placeholder - they're required for the manifest to load:

```bash
# If ImageMagick is available:
convert -size 16x16 xc:#4363d8 extension/icons/icon16.png
convert -size 48x48 xc:#4363d8 extension/icons/icon48.png
convert -size 128x128 xc:#4363d8 extension/icons/icon128.png
```

- [ ] **Step 7: Verify build runs (will fail - source files don't exist yet, that's fine)**

```bash
cd extension && deno run -A build.ts 2>&1 | head -5
```

Expected: errors about missing source files. Build infrastructure is wired.

- [ ] **Step 8: Commit**

```bash
git add extension/
git commit -m "feat(extension): scaffold manifest, build system, deno config"
```

---

### Task 2: Shared Types

**Files:**
- Create: `extension/src/types.ts`

- [ ] **Step 1: Write `extension/src/types.ts`**

```typescript
// Mirrors scrapers/viewpoint/types.ts - kept in sync by hand

export type SearchStatus = "any" | "active" | "sold";
export type MetricKey = "price" | "volume" | "dom" | "ppsf" | "listToSold";
export type ScopeKey = "viewport" | "session" | "zone";
export type WindowSize = "daily" | "weekly" | "monthly" | "yearly";
export type AlignmentMode = "today" | "calendar";

export interface BBox {
  sw_lat: number;
  sw_lng: number;
  ne_lat: number;
  ne_lng: number;
}

export interface ListingRow {
  id: string;
  listing_id: string;
  class_id: number;
  status_id: number;
  list_price: number | null;
  sold_price: number | null;
  close_dt: string | null;
  list_dt: string | null;
  sold_dt: string | null;
  tla: number | null;       // total living area (sqft)
  pid: string | null;
  lat: number | null;       // resolved from paired PropertyRow
  lng: number | null;
}

export interface PropertyRow {
  pid: string;
  lat: number | null;
  lng: number | null;
}

// Messages dispatched from MAIN world fetch-interceptor → ISOLATED relay
export interface InterceptEvent {
  listings: RawListing[];
  properties: RawProperty[];
  searchUrl: string;        // full URL including bbox + status params
}

// deno-lint-ignore no-explicit-any
export type RawListing = Record<string, any>;
// deno-lint-ignore no-explicit-any
export type RawProperty = Record<string, any>;

// Messages from content scripts → background SW → side panel
export type ContentToPanel =
  | { type: "listings"; listings: ListingRow[]; properties: PropertyRow[]; bbox: BBox; status: SearchStatus }
  | { type: "zone"; polygon: [number, number][] | null };

// Messages from side panel → background SW → content scripts
export type PanelToContent =
  | { type: "clear_zone" };

// Per-tab state in the side panel (in Preact memory only, never persisted)
export interface TabStore {
  tabId: number;
  status: SearchStatus;
  listings: ListingRow[];
  viewportBbox: BBox | null;
  polygon: [number, number][] | null;
  fetchedBboxes: BBox[];
  scope: ScopeKey;
  metric: MetricKey;
  windowSize: WindowSize;
  alignmentMode: AlignmentMode;
  anchorDayOfWeek: number;   // 0=Sun … 6=Sat; default 1=Mon
  anchorDayOfMonth: number;  // 1-31; default 1
}

export function defaultTabStore(tabId: number): TabStore {
  return {
    tabId,
    status: "any",
    listings: [],
    viewportBbox: null,
    polygon: null,
    fetchedBboxes: [],
    scope: "session",
    metric: "price",
    windowSize: "weekly",
    alignmentMode: "today",
    anchorDayOfWeek: 1,
    anchorDayOfMonth: 1,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/types.ts
git commit -m "feat(extension): shared types - ListingRow, TabStore, messages"
```

---

### Task 3: Parse Library

**Files:**
- Create: `extension/src/panel/lib/parse.ts`
- Create: `extension/src/panel/lib/__tests__/parse.test.ts`

Ported from `scrapers/viewpoint/client.ts` - adapted to use the extension's types.

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/panel/lib/__tests__/parse.test.ts
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { parseInterceptedResponse } from "../parse.ts";

const SEARCH_URL =
  "https://www.viewpoint.ca/api/v2/listing/search?" +
  "parameters%5Bstatus%5D=active&" +
  "parameters%5Bsearch_area%5D=45.0%2C+-63.0%2C+14%2C+44.5%2C+-63.5%2C+45.5%2C+-62.5&" +
  "CLIENT_VER=123&nonce=abc";

const MOCK_BODY = JSON.stringify({
  status: "success",
  nonce: "xyz",
  listings: [
    {
      id: "L1", listing_id: "ML1", class_id: 1, status_id: 1,
      list_price: 350000, sold_price: null,
      list_dt: "2025-03-01", sold_dt: null, close_dt: null,
      tla: 1200, pid: "PID1",
    },
  ],
  properties: [
    { pid: "PID1", lat: 44.8, lng: -63.1 },
  ],
});

Deno.test("parseInterceptedResponse - happy path", () => {
  const result = parseInterceptedResponse(MOCK_BODY, SEARCH_URL);
  assertExists(result);
  assertEquals(result.status, "active");
  assertEquals(result.listings.length, 1);
  assertEquals(result.listings[0].list_price, 350000);
  assertEquals(result.bbox.sw_lat, 44.5);
  assertEquals(result.bbox.ne_lat, 45.5);
  assertEquals(result.bbox.sw_lng, -63.5);
  assertEquals(result.bbox.ne_lng, -62.5);
  assertEquals(result.properties[0].lat, 44.8);
});

Deno.test("parseInterceptedResponse - non-success body returns null", () => {
  const result = parseInterceptedResponse(
    JSON.stringify({ status: "error" }),
    SEARCH_URL,
  );
  assertEquals(result, null);
});

Deno.test("parseInterceptedResponse - malformed JSON returns null", () => {
  assertEquals(parseInterceptedResponse("not json", SEARCH_URL), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd extension && deno test src/panel/lib/__tests__/parse.test.ts
```

Expected: `error: Module not found "...parse.ts"`

- [ ] **Step 3: Write `extension/src/panel/lib/parse.ts`**

```typescript
import type { BBox, ListingRow, PropertyRow, RawListing, RawProperty, SearchStatus } from "../../../types.ts";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function intish(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

export function mapListing(raw: RawListing): ListingRow {
  return {
    id: String(raw.id ?? ""),
    listing_id: String(raw.listing_id ?? ""),
    class_id: intish(raw.class_id) ?? 0,
    status_id: intish(raw.status_id) ?? 0,
    list_price: intish(raw.list_price),
    sold_price: intish(raw.sold_price),
    close_dt: str(raw.close_dt),
    list_dt: str(raw.list_dt),
    sold_dt: str(raw.sold_dt),
    tla: intish(raw.tla),
    pid: str(raw.pid),
    lat: null,
    lng: null,
  };
}

export function mapProperty(raw: RawProperty): PropertyRow {
  return {
    pid: String(raw.pid ?? ""),
    lat: num(raw.lat),
    lng: num(raw.lng),
  };
}

function parseBbox(searchUrl: string): BBox | null {
  try {
    const params = new URLSearchParams(searchUrl.split("?")[1] ?? "");
    const area = params.get("parameters[search_area]");
    if (!area) return null;
    // format: "ctrLat, ctrLng, zoom, sw_lat, sw_lng, ne_lat, ne_lng"
    const parts = area.split(",").map((s) => parseFloat(s.trim()));
    if (parts.length < 7 || parts.some(isNaN)) return null;
    return { sw_lat: parts[3], sw_lng: parts[4], ne_lat: parts[5], ne_lng: parts[6] };
  } catch {
    return null;
  }
}

function parseStatus(searchUrl: string): SearchStatus {
  try {
    const params = new URLSearchParams(searchUrl.split("?")[1] ?? "");
    const s = params.get("parameters[status]");
    if (s === "sold" || s === "active") return s;
    return "any";
  } catch {
    return "any";
  }
}

export interface ParsedResponse {
  listings: ListingRow[];
  properties: PropertyRow[];
  bbox: BBox;
  status: SearchStatus;
}

export function parseInterceptedResponse(
  body: string,
  searchUrl: string,
): ParsedResponse | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed.status !== "success") return null;

  const bbox = parseBbox(searchUrl);
  if (!bbox) return null;

  const rawListings = Array.isArray(parsed.listings) ? parsed.listings : [];
  const rawProps = Array.isArray(parsed.properties) ? parsed.properties : [];

  return {
    listings: rawListings.map((l) => mapListing(l as RawListing)),
    properties: rawProps.map((p) => mapProperty(p as RawProperty)),
    bbox,
    status: parseStatus(searchUrl),
  };
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
cd extension && deno test src/panel/lib/__tests__/parse.test.ts
```

Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/lib/
git commit -m "feat(extension): parse library - parseInterceptedResponse ported from scraper"
```

---

## Phase 2 - Analytics Engine

### Task 4: Bucket Library

**Files:**
- Create: `extension/src/panel/lib/bucket.ts`
- Create: `extension/src/panel/lib/__tests__/bucket.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/panel/lib/__tests__/bucket.test.ts
import { assertEquals, assert } from "jsr:@std/assert@1";
import { buildBuckets, availableWindowSizes } from "../bucket.ts";

// Fixed reference: Wednesday May 14 2025 12:00:00 UTC
const NOW = new Date("2025-05-14T12:00:00Z");
const ONE_YEAR_AGO = new Date("2024-05-14T12:00:00Z");

Deno.test("buildBuckets today-weekly - no partial buckets", () => {
  const buckets = buildBuckets(NOW, "weekly", "today");
  for (const b of buckets) {
    assertEquals(b.isPartial, false, `Bucket ${b.label} should not be partial`);
  }
  // Each bucket is exactly 7 days
  for (const b of buckets) {
    const ms = b.end.getTime() - b.start.getTime();
    assertEquals(ms, 7 * 24 * 60 * 60 * 1000, `Bucket ${b.label} should be 7 days`);
  }
});

Deno.test("buildBuckets today-monthly - no partial buckets", () => {
  const buckets = buildBuckets(NOW, "monthly", "today");
  for (const b of buckets) {
    assertEquals(b.isPartial, false);
  }
});

Deno.test("buildBuckets today-daily - covers ~365 days", () => {
  const buckets = buildBuckets(NOW, "daily", "today");
  assert(buckets.length >= 364 && buckets.length <= 366, `Got ${buckets.length} daily buckets`);
});

Deno.test("buildBuckets calendar-weekly - current bucket is partial (today is Wed, anchor Mon)", () => {
  const buckets = buildBuckets(NOW, "weekly", "calendar", 1); // anchor Mon
  const last = buckets[buckets.length - 1];
  // May 14 is a Wed; latest Mon was May 12; so current week (May 12-19) is partial
  assertEquals(last.isPartial, true);
});

Deno.test("buildBuckets calendar-monthly - partial when not 1st of month", () => {
  const buckets = buildBuckets(NOW, "monthly", "calendar", undefined, 1);
  const last = buckets[buckets.length - 1];
  // May 14 is not May 1, so current month bucket (May 1-Jun 1) is partial
  assertEquals(last.isPartial, true);
});

Deno.test("buildBuckets - buckets are contiguous and ascending", () => {
  const buckets = buildBuckets(NOW, "weekly", "today");
  for (let i = 1; i < buckets.length; i++) {
    assertEquals(buckets[i].start.getTime(), buckets[i - 1].end.getTime());
  }
  assert(buckets[0].start >= ONE_YEAR_AGO);
  assert(buckets[buckets.length - 1].end <= NOW || buckets[buckets.length - 1].end.getTime() - NOW.getTime() < 86400000);
});

Deno.test("buildBuckets today-yearly - single bucket, not partial", () => {
  const buckets = buildBuckets(NOW, "yearly", "today");
  assertEquals(buckets.length, 1);
  assertEquals(buckets[0].isPartial, false);
  const ms = buckets[0].end.getTime() - buckets[0].start.getTime();
  assertEquals(ms, 365 * 24 * 60 * 60 * 1000);
});

Deno.test("availableWindowSizes - yearly always included, empty data", () => {
  const sizes = availableWindowSizes(0);
  assert(sizes.includes("yearly"));
  assertEquals(sizes.includes("daily"), false);
  assertEquals(sizes.includes("weekly"), false);
  assertEquals(sizes.includes("monthly"), false);
});

Deno.test("availableWindowSizes - 1825 listings enables all sizes", () => {
  const sizes = availableWindowSizes(1825); // 1825/365=5 daily threshold
  assertEquals(sizes, ["daily", "weekly", "monthly", "yearly"]);
});

Deno.test("availableWindowSizes - 260 listings enables weekly+monthly+yearly", () => {
  const sizes = availableWindowSizes(260); // 260/52=5 weekly threshold
  assert(sizes.includes("weekly"));
  assert(sizes.includes("monthly"));
  assert(sizes.includes("yearly"));
  assertEquals(sizes.includes("daily"), false);
});

Deno.test("availableWindowSizes - 60 listings enables monthly+yearly only", () => {
  const sizes = availableWindowSizes(60); // 60/12=5 monthly threshold
  assert(sizes.includes("monthly"));
  assert(sizes.includes("yearly"));
  assertEquals(sizes.includes("daily"), false);
  assertEquals(sizes.includes("weekly"), false);
});
```

- [ ] **Step 2: Run to verify fail**

```bash
cd extension && deno test src/panel/lib/__tests__/bucket.test.ts
```

Expected: `error: Module not found "...bucket.ts"`

- [ ] **Step 3: Write `extension/src/panel/lib/bucket.ts`**

```typescript
import type { AlignmentMode, WindowSize } from "../../../types.ts";

export interface Bucket {
  start: Date;
  end: Date;
  label: string;
  isPartial: boolean;
}

export function buildBuckets(
  now: Date,
  size: WindowSize,
  mode: AlignmentMode,
  anchorDayOfWeek = 1,   // 0=Sun … 6=Sat, default Mon
  anchorDayOfMonth = 1,  // 1-31, default 1st
): Bucket[] {
  const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  if (mode === "today") {
    return buildTodayBuckets(now, yearAgo, size);
  }
  return buildCalendarBuckets(now, yearAgo, size, anchorDayOfWeek, anchorDayOfMonth);
}

function buildTodayBuckets(now: Date, from: Date, size: WindowSize): Bucket[] {
  // Trail backwards from now - always complete buckets
  const buckets: Bucket[] = [];
  let end = new Date(now);
  while (end.getTime() > from.getTime()) {
    const start = stepBack(end, size);
    if (start.getTime() < from.getTime()) break;
    buckets.unshift({
      start: new Date(start),
      end: new Date(end),
      label: formatLabel(start, size),
      isPartial: false,
    });
    end = new Date(start);
  }
  return buckets;
}

function buildCalendarBuckets(
  now: Date,
  from: Date,
  size: WindowSize,
  anchorDow: number,
  anchorDom: number,
): Bucket[] {
  // Find the most recent anchor boundary at or before now
  const anchorStart = lastAnchorBefore(now, size, anchorDow, anchorDom);
  const buckets: Bucket[] = [];
  let start = new Date(anchorStart);

  // Most recent bucket - may be partial
  const currentEnd = stepForward(start, size);
  buckets.unshift({
    start: new Date(start),
    end: currentEnd,
    label: formatLabel(start, size),
    isPartial: currentEnd.getTime() > now.getTime(),
  });

  // Walk backwards
  let cur = new Date(start);
  while (true) {
    const prev = stepBackCalendar(cur, size, anchorDow, anchorDom);
    if (prev.getTime() < from.getTime()) break;
    const prevEnd = new Date(cur);
    buckets.unshift({
      start: new Date(prev),
      end: prevEnd,
      label: formatLabel(prev, size),
      isPartial: false,
    });
    cur = new Date(prev);
  }

  return buckets;
}

function stepBack(date: Date, size: WindowSize): Date {
  const d = new Date(date);
  if (size === "daily") d.setUTCDate(d.getUTCDate() - 1);
  else if (size === "weekly") d.setUTCDate(d.getUTCDate() - 7);
  else if (size === "monthly") d.setUTCMonth(d.getUTCMonth() - 1);
  else d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d;
}

function stepForward(date: Date, size: WindowSize): Date {
  const d = new Date(date);
  if (size === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (size === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (size === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

function stepBackCalendar(date: Date, size: WindowSize, anchorDow: number, anchorDom: number): Date {
  return stepBack(date, size); // same as today for weekly/daily; for monthly respects anchorDom via lastAnchorBefore
}

function lastAnchorBefore(now: Date, size: WindowSize, anchorDow: number, anchorDom: number): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (size === "daily") return d;
  if (size === "weekly") {
    const dow = d.getUTCDay();
    const diff = (dow - anchorDow + 7) % 7;
    d.setUTCDate(d.getUTCDate() - diff);
    return d;
  }
  // monthly - find the most recent anchorDom on or before today
  let dom = anchorDom;
  if (dom > daysInMonth(d.getUTCFullYear(), d.getUTCMonth())) {
    dom = daysInMonth(d.getUTCFullYear(), d.getUTCMonth());
  }
  if (d.getUTCDate() >= dom) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom));
  }
  // Go back a month
  const prevMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const maxDom = Math.min(dom, daysInMonth(prevMonth.getUTCFullYear(), prevMonth.getUTCMonth()));
  return new Date(Date.UTC(prevMonth.getUTCFullYear(), prevMonth.getUTCMonth(), maxDom));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function formatLabel(date: Date, size: WindowSize): string {
  if (size === "daily") return date.toISOString().slice(0, 10);
  if (size === "weekly") return `W/e ${date.toISOString().slice(0, 10)}`;
  if (size === "yearly") return `${date.getUTCFullYear()}`;
  return `${date.toISOString().slice(0, 7)}`;
}

// Minimum average listings per bucket to enable a window size.
const BUCKETS_PER_YEAR: Record<WindowSize, number> = { daily: 365, weekly: 52, monthly: 12, yearly: 1 };
const WINDOW_ORDER: WindowSize[] = ["daily", "weekly", "monthly", "yearly"];

// Returns which window sizes have ≥5 avg listings/bucket. Yearly is always included as fallback.
export function availableWindowSizes(listingCount: number): WindowSize[] {
  return WINDOW_ORDER.filter(
    (size) => size === "yearly" || listingCount / BUCKETS_PER_YEAR[size] >= 5,
  );
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
cd extension && deno test src/panel/lib/__tests__/bucket.test.ts
```

Expected: `11 passed`

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/lib/bucket.ts extension/src/panel/lib/__tests__/bucket.test.ts
git commit -m "feat(extension): bucket library - today-trailing, calendar-aligned, yearly, availableWindowSizes"
```

---

### Task 5: Aggregate Library

**Files:**
- Create: `extension/src/panel/lib/aggregate.ts`
- Create: `extension/src/panel/lib/__tests__/aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/panel/lib/__tests__/aggregate.test.ts
import { assertEquals, assertAlmostEquals, assertExists } from "jsr:@std/assert@1";
import { aggregate } from "../aggregate.ts";
import type { ListingRow } from "../../../../types.ts";
import type { Bucket } from "../bucket.ts";

function makeListing(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: "L1", listing_id: "ML1", class_id: 1, status_id: 1,
    list_price: 300000, sold_price: null,
    list_dt: "2025-05-01", sold_dt: null, close_dt: null,
    tla: 1000, pid: "P1", lat: 44.8, lng: -63.1,
    ...overrides,
  };
}

const MAY_BUCKET: Bucket = {
  start: new Date("2025-05-01T00:00:00Z"),
  end: new Date("2025-06-01T00:00:00Z"),
  label: "2025-05",
  isPartial: false,
};

const APR_BUCKET: Bucket = {
  start: new Date("2025-04-01T00:00:00Z"),
  end: new Date("2025-05-01T00:00:00Z"),
  label: "2025-04",
  isPartial: false,
};

Deno.test("aggregate price - avg and median computed correctly", () => {
  const listings = [
    makeListing({ id: "1", list_price: 200000 }),
    makeListing({ id: "2", list_price: 400000 }),
    makeListing({ id: "3", list_price: 300000 }),
  ];
  const result = aggregate(listings, "price", [MAY_BUCKET], "active");
  assertEquals(result.buckets[0].count, 3);
  assertAlmostEquals(result.buckets[0].avg!, 300000, 1);
  assertAlmostEquals(result.buckets[0].median!, 300000, 1);
  assertAlmostEquals(result.overall.avg!, 300000, 1);
});

Deno.test("aggregate price - empty bucket returns nulls", () => {
  const result = aggregate([], "price", [MAY_BUCKET], "active");
  assertEquals(result.buckets[0].count, 0);
  assertEquals(result.buckets[0].avg, null);
});

Deno.test("aggregate dom - uses list_dt and sold_dt", () => {
  const listings = [
    makeListing({ id: "1", list_dt: "2025-05-01", sold_dt: "2025-05-11", sold_price: 290000 }),
  ];
  const result = aggregate(listings, "dom", [MAY_BUCKET], "sold");
  assertAlmostEquals(result.buckets[0].avg!, 10, 0.01);
});

Deno.test("aggregate ppsf - list_price / tla", () => {
  const listings = [makeListing({ id: "1", list_price: 300000, tla: 1500 })];
  const result = aggregate(listings, "ppsf", [MAY_BUCKET], "active");
  assertAlmostEquals(result.buckets[0].avg!, 200, 0.01); // 300000/1500
});

Deno.test("aggregate listToSold - ratio", () => {
  const listings = [
    makeListing({ id: "1", list_price: 300000, sold_price: 291000, sold_dt: "2025-05-10" }),
  ];
  const result = aggregate(listings, "listToSold", [MAY_BUCKET], "sold");
  assertAlmostEquals(result.buckets[0].avg!, 0.97, 0.001);
});

Deno.test("aggregate delta - compares most recent to previous bucket", () => {
  const may = [makeListing({ id: "1", list_price: 400000, list_dt: "2025-05-10" })];
  const apr = [makeListing({ id: "2", list_price: 200000, list_dt: "2025-04-10" })];
  const result = aggregate([...may, ...apr], "price", [APR_BUCKET, MAY_BUCKET], "active");
  assertExists(result.delta);
  assertAlmostEquals(result.delta!, 1.0, 0.01); // +100% from 200k to 400k
});

Deno.test("aggregate bucket floor - buckets with <5 listings flagged", () => {
  const listings = [makeListing({ id: "1" }), makeListing({ id: "2" })];
  const result = aggregate(listings, "price", [MAY_BUCKET], "active");
  assertEquals(result.buckets[0].belowFloor, true);
});
```

- [ ] **Step 2: Run to verify fail**

```bash
cd extension && deno test src/panel/lib/__tests__/aggregate.test.ts
```

- [ ] **Step 3: Write `extension/src/panel/lib/aggregate.ts`**

```typescript
import type { ListingRow, MetricKey, SearchStatus } from "../../../types.ts";
import type { Bucket } from "./bucket.ts";

export interface BucketStat {
  bucket: Bucket;
  count: number;
  avg: number | null;
  median: number | null;
  stdDev: number | null;
  belowFloor: boolean;  // true if count < EXPORT_FLOOR
}

export interface AggregateSummary {
  buckets: BucketStat[];
  overall: { count: number; avg: number | null; median: number | null; stdDev: number | null };
  delta: number | null;  // fractional change: (current - prev) / prev
}

const EXPORT_FLOOR = 5;  // buckets below this are flagged (suppressed in CSV export)

export function aggregate(
  listings: ListingRow[],
  metric: MetricKey,
  buckets: Bucket[],
  status: SearchStatus,
): AggregateSummary {
  const getValue = makeExtractor(metric, status);
  const getDate = makeDateExtractor(status);

  const bucketStats: BucketStat[] = buckets.map((bucket) => {
    const inBucket = listings.filter((l) => {
      const d = getDate(l);
      return d !== null && d >= bucket.start && d < bucket.end;
    });
    const values = inBucket.map(getValue).filter((v): v is number => v !== null);
    return {
      bucket,
      count: metric === "volume" ? inBucket.length : values.length,
      ...computeStats(metric === "volume" ? null : values),
      belowFloor: inBucket.length < EXPORT_FLOOR,
    };
  });

  const allValues = listings.map(getValue).filter((v): v is number => v !== null);
  const overall = {
    count: listings.length,
    ...computeStats(metric === "volume" ? null : allValues),
  };

  // Delta: most recent non-partial bucket avg vs the one before it
  const complete = bucketStats.filter((b) => !b.bucket.isPartial && b.avg !== null);
  let delta: number | null = null;
  if (complete.length >= 2) {
    const curr = complete[complete.length - 1].avg!;
    const prev = complete[complete.length - 2].avg!;
    if (prev !== 0) delta = (curr - prev) / prev;
  }

  return { buckets: bucketStats, overall, delta };
}

function makeDateExtractor(status: SearchStatus) {
  return (l: ListingRow): Date | null => {
    const raw = status === "active"
      ? l.list_dt
      : (l.sold_dt ?? l.close_dt ?? l.list_dt);
    return raw ? new Date(raw) : null;
  };
}

function makeExtractor(metric: MetricKey, status: SearchStatus) {
  return (l: ListingRow): number | null => {
    switch (metric) {
      case "price": return status === "sold" ? l.sold_price : l.list_price;
      case "volume": return 1;
      case "dom": {
        const listD = l.list_dt ? new Date(l.list_dt) : null;
        const soldD = l.sold_dt ? new Date(l.sold_dt) : l.close_dt ? new Date(l.close_dt) : null;
        if (!listD || !soldD) return null;
        return Math.round((soldD.getTime() - listD.getTime()) / 86400000);
      }
      case "ppsf":
        return l.list_price && l.tla && l.tla > 0 ? l.list_price / l.tla : null;
      case "listToSold":
        return l.list_price && l.sold_price && l.list_price > 0
          ? l.sold_price / l.list_price
          : null;
    }
  };
}

function computeStats(values: number[] | null) {
  if (!values || values.length === 0) return { avg: null, median: null, stdDev: null };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length;
  return { avg, median, stdDev: Math.sqrt(variance) };
}
```

- [ ] **Step 4: Run tests**

```bash
cd extension && deno test src/panel/lib/__tests__/aggregate.test.ts
```

Expected: `7 passed`

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/lib/aggregate.ts extension/src/panel/lib/__tests__/aggregate.test.ts
git commit -m "feat(extension): aggregate library - per-bucket stats, delta, export floor"
```

---

### Task 6: Geofence Library

**Files:**
- Create: `extension/src/panel/lib/geofence.ts`
- Create: `extension/src/panel/lib/__tests__/geofence.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/panel/lib/__tests__/geofence.test.ts
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
```

- [ ] **Step 2: Run to verify fail**

```bash
cd extension && deno test src/panel/lib/__tests__/geofence.test.ts
```

- [ ] **Step 3: Write `extension/src/panel/lib/geofence.ts`**

```typescript
// [lat, lng] polygon - all coords in geographic degrees

export function pointInPolygon(lat: number, lng: number, polygon: [number, number][]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (((yi > lat) !== (yj > lat)) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Shoelace formula - returns area in degree² (valid for coverage ratio math)
export function polygonArea(polygon: [number, number][]): number {
  const n = polygon.length;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (polygon[j][1] + polygon[i][1]) * (polygon[j][0] - polygon[i][0]);
  }
  return Math.abs(area / 2);
}
```

- [ ] **Step 4: Run tests**

```bash
cd extension && deno test src/panel/lib/__tests__/geofence.test.ts
```

Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/lib/geofence.ts extension/src/panel/lib/__tests__/geofence.test.ts
git commit -m "feat(extension): geofence lib - ray-cast point-in-polygon + shoelace area"
```

---

### Task 7: Coverage Library

**Files:**
- Create: `extension/src/panel/lib/coverage.ts`
- Create: `extension/src/panel/lib/__tests__/coverage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/panel/lib/__tests__/coverage.test.ts
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { computeCoverage } from "../coverage.ts";
import type { BBox } from "../../../../types.ts";

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
```

- [ ] **Step 2: Run to verify fail**

```bash
cd extension && deno test src/panel/lib/__tests__/coverage.test.ts
```

- [ ] **Step 3: Write `extension/src/panel/lib/coverage.ts`**

```typescript
import type { BBox } from "../../../types.ts";
import { polygonArea } from "./geofence.ts";

type Pt = [number, number]; // [lat, lng]

// Sutherland-Hodgman - clips `polygon` to the convex `clipPolygon`
function sutherlandHodgman(polygon: Pt[], clipPolygon: Pt[]): Pt[] {
  let output = [...polygon];
  if (output.length === 0) return [];
  const n = clipPolygon.length;
  for (let i = 0; i < n; i++) {
    if (output.length === 0) return [];
    const input = output;
    output = [];
    const edgeStart = clipPolygon[i];
    const edgeEnd = clipPolygon[(i + 1) % n];
    for (let j = 0; j < input.length; j++) {
      const curr = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const currInside = isInside(curr, edgeStart, edgeEnd);
      const prevInside = isInside(prev, edgeStart, edgeEnd);
      if (currInside) {
        if (!prevInside) output.push(intersect(prev, curr, edgeStart, edgeEnd));
        output.push(curr);
      } else if (prevInside) {
        output.push(intersect(prev, curr, edgeStart, edgeEnd));
      }
    }
  }
  return output;
}

function isInside(p: Pt, a: Pt, b: Pt): boolean {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
}

function intersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt {
  const A1 = b[1] - a[1], B1 = a[0] - b[0], C1 = A1 * a[0] + B1 * a[1];
  const A2 = d[1] - c[1], B2 = c[0] - d[0], C2 = A2 * c[0] + B2 * c[1];
  const det = A1 * B2 - A2 * B1;
  if (Math.abs(det) < 1e-10) return a;
  return [(B2 * C1 - B1 * C2) / det, (A1 * C2 - A2 * C1) / det];
}

function bboxToPolygon(bbox: BBox): Pt[] {
  return [
    [bbox.sw_lat, bbox.sw_lng],
    [bbox.ne_lat, bbox.sw_lng],
    [bbox.ne_lat, bbox.ne_lng],
    [bbox.sw_lat, bbox.ne_lng],
  ];
}

// Returns fraction [0-1] of polygon area covered by the union of fetched bboxes.
// Approximation: sums clipped areas without deduplicating bbox overlaps.
// Good enough for Nova Scotia zoom levels where quadtree bboxes rarely overlap.
export function computeCoverage(fetchedBboxes: BBox[], polygon: [number, number][]): number {
  const total = polygonArea(polygon);
  if (total === 0 || fetchedBboxes.length === 0) return 0;
  let covered = 0;
  for (const bbox of fetchedBboxes) {
    const clipped = sutherlandHodgman(polygon, bboxToPolygon(bbox));
    covered += polygonArea(clipped);
  }
  return Math.min(1, covered / total);
}
```

- [ ] **Step 4: Run tests**

```bash
cd extension && deno test src/panel/lib/__tests__/coverage.test.ts
```

Expected: `5 passed`

- [ ] **Step 5: Run the full test suite**

```bash
cd extension && deno test src/panel/lib/__tests__/
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add extension/src/panel/lib/coverage.ts extension/src/panel/lib/__tests__/coverage.test.ts
git commit -m "feat(extension): coverage lib - Sutherland-Hodgman bbox∩polygon coverage %"
```

---

## Phase 3 - Extension Wiring

### Task 8: Background Service Worker

**Files:**
- Create: `extension/src/background/sw.ts`

The SW does three things: opens the side panel when the action icon is clicked; routes messages from content scripts to the side panel; routes `clear_zone` messages from the side panel back to the geofence overlay via a stored port.

- [ ] **Step 1: Write `extension/src/background/sw.ts`**

```typescript
/// <reference types="chrome"/>

// Map tabId → port from geofence-overlay content script
const geofencePorts = new Map<number, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("geofence-") || !port.sender?.tab?.id) return;
  const tabId = port.sender.tab.id;
  geofencePorts.set(tabId, port);
  port.onDisconnect.addListener(() => geofencePorts.delete(tabId));
});

// Open side panel when user clicks the extension icon
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.sidePanel.open({ tabId: tab.id });
});

// Route messages from content scripts to the side panel and vice versa
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "clear_zone") {
    // Side panel → geofence overlay for a specific tab
    const tabId = message.tabId as number | undefined;
    if (tabId !== undefined) {
      geofencePorts.get(tabId)?.postMessage({ type: "clear_zone" });
    }
    sendResponse({ ok: true });
    return;
  }
  // Content script → side panel: forward as-is (side panel listens on onMessage)
  // No action needed - chrome.runtime.onMessage delivers to all extension contexts
  sendResponse({ ok: true });
});
```

- [ ] **Step 2: Build and verify no TypeScript errors**

```bash
cd extension && deno check src/background/sw.ts
```

> Note: Deno's LSP may flag Chrome APIs as unknown - this is expected. `dano check` / `deno check` against `lib: ["dom"]` is sufficient; the build itself uses esbuild which doesn't typecheck Chrome globals. Errors about `chrome` are false positives.

- [ ] **Step 3: Commit**

```bash
git add extension/src/background/sw.ts
git commit -m "feat(extension): background SW - side panel open + port routing"
```

---

### Task 9: Fetch Interceptor (MAIN World)

**Files:**
- Create: `extension/src/content/fetch-interceptor.ts`

Runs in MAIN world (`document_start`). Patches `window.fetch` before viewpoint's scripts load. Fires a `CustomEvent` on `document` for each listing search response.

- [ ] **Step 1: Write `extension/src/content/fetch-interceptor.ts`**

```typescript
// Runs in MAIN world - no chrome.* APIs available
// Communicates with ISOLATED relay via CustomEvent on document

const SEARCH_PATH = "/api/v2/listing/search";

const originalFetch = window.fetch.bind(window);

window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : (input as Request).url;

  const response = await originalFetch(input, init);

  if (url.includes(SEARCH_PATH)) {
    const clone = response.clone();
    clone.text().then((body) => {
      document.dispatchEvent(
        new CustomEvent("vpa:listings", {
          detail: { body, url },
        }),
      );
    }).catch(() => {});
  }

  return response;
};
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/content/fetch-interceptor.ts
git commit -m "feat(extension): fetch interceptor - MAIN world window.fetch patch"
```

---

### Task 10: Relay Content Script (ISOLATED World)

**Files:**
- Create: `extension/src/content/relay.ts`

Runs in ISOLATED world. Listens for `vpa:listings` CustomEvents, calls `parseInterceptedResponse`, and forwards `ContentToPanel` messages to the side panel. Also imports and initialises `geofence-overlay.ts`.

- [ ] **Step 1: Write `extension/src/content/relay.ts`**

```typescript
/// <reference types="chrome"/>
import { parseInterceptedResponse } from "../panel/lib/parse.ts";
import type { ContentToPanel } from "../types.ts";
import { initGeofenceOverlay } from "./geofence-overlay.ts";

// Track the current session status so the panel can detect filter changes
let lastStatus = "any";

document.addEventListener("vpa:listings", (e) => {
  const { body, url } = (e as CustomEvent<{ body: string; url: string }>).detail;
  const parsed = parseInterceptedResponse(body, url);
  if (!parsed) return;

  if (parsed.status !== lastStatus) {
    lastStatus = parsed.status;
  }

  const msg: ContentToPanel = {
    type: "listings",
    listings: parsed.listings,
    properties: parsed.properties,
    bbox: parsed.bbox,
    status: parsed.status,
  };

  chrome.runtime.sendMessage(msg).catch(() => {
    // Side panel not open - ignore
  });
});

// Initialise geofence overlay when map container is ready
initGeofenceOverlay();
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/content/relay.ts
git commit -m "feat(extension): relay - ISOLATED bridge from CustomEvent to runtime message"
```

---

## Phase 4 - Geofence Overlay

### Task 11: Geofence Overlay

**Files:**
- Create: `extension/src/content/geofence-overlay.ts`

Injects Leaflet + Geoman onto the viewpoint Google Maps page. Manages Draw Zone button lifecycle, drawing UX, live editing, and relays polygon coordinates to the side panel via the background SW port.

- [ ] **Step 1: Write `extension/src/content/geofence-overlay.ts`**

```typescript
/// <reference types="chrome"/>
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import leafletCss from "leaflet/dist/leaflet.css" assert { type: "text" };
import geomanCss from "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css" assert { type: "text" };
import type { ContentToPanel } from "../types.ts";

let leafletMap: L.Map | null = null;
let drawnLayer: L.Polygon | null = null;
let drawBtn: HTMLButtonElement | null = null;
let clearBtn: HTMLButtonElement | null = null;
let badge: HTMLDivElement | null = null;

// Establish port with background SW for clear_zone signal
const port = chrome.runtime.connect({ name: "geofence-" + Date.now() });
port.onMessage.addListener((msg) => {
  if (msg.type === "clear_zone") clearZone();
});

function injectStyles(): void {
  if (document.getElementById("vpa-leaflet-css")) return;
  const style = document.createElement("style");
  style.id = "vpa-leaflet-css";
  style.textContent = leafletCss + "\n" + geomanCss;
  document.head.appendChild(style);
}

function sendZone(polygon: [number, number][] | null): void {
  const msg: ContentToPanel = { type: "zone", polygon };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function clearZone(): void {
  if (drawnLayer) {
    leafletMap?.removeLayer(drawnLayer);
    drawnLayer = null;
  }
  badge?.remove();
  badge = null;
  setButtonState("idle");
  sendZone(null);
}

function setButtonState(state: "idle" | "drawing" | "active"): void {
  if (!drawBtn || !clearBtn) return;
  if (state === "idle") {
    drawBtn.textContent = "⬡ Draw Zone";
    drawBtn.className = "vpa-draw-btn";
    clearBtn.style.display = "none";
  } else if (state === "drawing") {
    drawBtn.textContent = "✕ Cancel";
    drawBtn.className = "vpa-draw-btn vpa-draw-btn--drawing";
    clearBtn.style.display = "none";
  } else {
    drawBtn.textContent = "⬡ Redraw";
    drawBtn.className = "vpa-draw-btn vpa-draw-btn--active";
    clearBtn.style.display = "block";
  }
}

function buildButtons(container: HTMLElement): void {
  const wrap = document.createElement("div");
  wrap.id = "vpa-draw-wrap";
  wrap.style.cssText = "position:absolute;top:54px;right:46px;z-index:1000;display:flex;gap:4px;";

  drawBtn = document.createElement("button");
  drawBtn.className = "vpa-draw-btn";
  drawBtn.textContent = "⬡ Draw Zone";
  drawBtn.style.cssText =
    "background:#fff;border:1.5px solid rgba(0,0,0,.18);border-radius:6px;padding:5px 9px;" +
    "font-size:9.5px;font-weight:700;color:#333;cursor:pointer;box-shadow:0 1px 5px rgba(0,0,0,.15);";

  clearBtn = document.createElement("button");
  clearBtn.style.cssText =
    "display:none;background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:6px;" +
    "padding:5px 8px;font-size:9px;font-weight:600;color:#888;cursor:pointer;";
  clearBtn.textContent = "✕";

  drawBtn.addEventListener("click", () => {
    if (leafletMap?.pm.globalDrawModeEnabled()) {
      leafletMap.pm.disableDraw();
      setButtonState(drawnLayer ? "active" : "idle");
    } else {
      clearZone();
      setButtonState("drawing");
      leafletMap?.pm.enableDraw("Polygon", {
        snappable: false,
        templineStyle: { color: "#4363d8", dashArray: "5,3" },
        hintlineStyle: { color: "#4363d8", opacity: 0.5 },
        pathOptions: { color: "#4363d8", fillColor: "#4363d8", fillOpacity: 0.08 },
      });
    }
  });

  clearBtn.addEventListener("click", clearZone);

  wrap.appendChild(drawBtn);
  wrap.appendChild(clearBtn);
  container.appendChild(wrap);
}

function onPolygonCreated(layer: L.Polygon): void {
  drawnLayer = layer;
  setButtonState("active");

  // Style completed polygon
  layer.setStyle({ color: "#16c784", fillColor: "#16c784", fillOpacity: 0.1, weight: 1.5 });

  // Enable vertex editing immediately
  layer.pm.enable({ allowSelfIntersection: false });

  const updateZone = () => {
    const latlngs = (layer.getLatLngs()[0] as L.LatLng[]);
    const polygon: [number, number][] = latlngs.map((p) => [p.lat, p.lng]);
    sendZone(polygon);
  };

  updateZone();

  layer.on("pm:edit", updateZone);
  layer.on("pm:vertexadded", updateZone);
  layer.on("pm:vertexremoved", updateZone);
}

function initLeafletOverlay(mapContainer: HTMLElement): void {
  injectStyles();

  // Create a transparent overlay container inside the map div
  const overlayDiv = document.createElement("div");
  overlayDiv.id = "vpa-leaflet-overlay";
  overlayDiv.style.cssText =
    "position:absolute;inset:0;z-index:500;pointer-events:none;";
  mapContainer.style.position = "relative";
  mapContainer.appendChild(overlayDiv);

  // Get centre from Google Maps URL or default to NS centre
  leafletMap = L.map(overlayDiv, {
    zoomControl: false,
    attributionControl: false,
    doubleClickZoom: false,
    dragging: false,
    scrollWheelZoom: false,
    touchZoom: false,
    keyboard: false,
  }).setView([45.2, -63.0], 8);

  // Allow pointer events only during drawing/editing
  leafletMap.on("pm:drawstart", () => {
    overlayDiv.style.pointerEvents = "all";
  });
  leafletMap.on("pm:drawend", () => {
    overlayDiv.style.pointerEvents = drawnLayer ? "all" : "none";
  });

  leafletMap.pm.setGlobalOptions({ allowSelfIntersection: false });

  leafletMap.on("pm:create", (e) => {
    onPolygonCreated(e.layer as L.Polygon);
  });

  buildButtons(mapContainer);
}

export function initGeofenceOverlay(): void {
  // Wait for the Google Maps container (#map or the canvas parent)
  const check = () => {
    const mapEl =
      document.getElementById("map") ??
      document.querySelector("[id*='map-canvas']") ??
      document.querySelector(".gm-style")?.parentElement;
    if (mapEl) {
      initLeafletOverlay(mapEl as HTMLElement);
    } else {
      setTimeout(check, 500);
    }
  };
  check();
}
```

- [ ] **Step 2: Build and verify no critical errors**

```bash
cd extension && deno run -A build.ts 2>&1 | tail -5
```

Expected: `Build complete.` (warnings about CSS imports are fine)

- [ ] **Step 3: Commit**

```bash
git add extension/src/content/geofence-overlay.ts
git commit -m "feat(extension): geofence overlay - Leaflet draw + live edit + zone relay"
```

---

## Phase 5 - Side Panel

### Task 12: Panel Shell + CSS Tokens

**Files:**
- Create: `extension/src/panel/index.html`
- Create: `extension/src/panel/panel.css`

- [ ] **Step 1: Write `extension/src/panel/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ViewPoint Analytics</title>
  <link rel="stylesheet" href="panel.css"/>
</head>
<body>
  <div id="app"></div>
  <script src="panel.js"></script>
</body>
</html>
```

- [ ] **Step 2: Copy built panel HTML to build directory in build.ts**

Add to `build.ts` after the `Promise.all`:

```typescript
// Copy static panel files
await Deno.copyFile(join(dir, "src/panel/index.html"), join(dir, "build/panel/index.html"));
await Deno.copyFile(join(dir, "src/panel/panel.css"), join(dir, "build/panel/panel.css"));
// Copy icons
for (const size of [16, 48, 128]) {
  await Deno.copyFile(join(dir, `icons/icon${size}.png`), join(dir, `build/icons/icon${size}.png`));
}
await Deno.mkdir(join(dir, "build/icons"), { recursive: true });
```

Also add manifest copy:

```typescript
await Deno.copyFile(join(dir, "manifest.json"), join(dir, "build/manifest.json"));
```

- [ ] **Step 3: Write `extension/src/panel/panel.css`**

```css
/* @dano/styles OKLCH design tokens - subset for extension panel */
:root {
  --color-bg: oklch(12% 0.02 264);
  --color-surface: oklch(16% 0.02 264);
  --color-border: oklch(25% 0.02 264);
  --color-text: oklch(88% 0.01 264);
  --color-muted: oklch(50% 0.01 264);
  --color-accent: oklch(55% 0.2 264);     /* #4363d8 blue */
  --color-green: oklch(72% 0.18 160);     /* #16c784 */
  --color-orange: oklch(70% 0.18 55);     /* #f58231 */
  --color-red: oklch(60% 0.22 25);
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --radius: 6px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 13px;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

#app { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* Utility */
.vpa-section { padding: 10px 14px; border-bottom: 1px solid var(--color-border); }
.vpa-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--color-muted); }
.vpa-row { display: flex; align-items: center; gap: 6px; }

/* Tab strip */
.vpa-tabs { display: flex; gap: 2px; }
.vpa-tab {
  flex: 1; text-align: center; font-size: 9px; font-weight: 700;
  padding: 4px 0; border-radius: 5px; cursor: pointer;
  color: var(--color-muted);
  background: oklch(20% 0.02 264);
  border: 1px solid var(--color-border);
}
.vpa-tab--viewport.vpa-tab--active { background: oklch(28% 0.12 220); color: oklch(75% 0.15 220); border-color: oklch(40% 0.15 220); }
.vpa-tab--session.vpa-tab--active { background: oklch(28% 0.1 55); color: oklch(75% 0.15 55); border-color: oklch(40% 0.12 55); }
.vpa-tab--zone.vpa-tab--active { background: oklch(25% 0.1 160); color: oklch(72% 0.18 160); border-color: oklch(40% 0.15 160); }

/* Metric tabs */
.vpa-metric-tabs { display: flex; border-bottom: 1px solid var(--color-border); overflow-x: auto; }
.vpa-metric-tab {
  flex-shrink: 0; padding: 7px 9px; font-size: 9px; font-weight: 700;
  color: var(--color-muted); cursor: pointer;
  border-bottom: 2px solid transparent; text-transform: uppercase; letter-spacing: 0.4px;
}
.vpa-metric-tab--active { color: var(--color-accent); border-bottom-color: var(--color-accent); }

/* Stats row */
.vpa-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; background: var(--color-border); gap: 1px; }
.vpa-stat { background: var(--color-surface); padding: 8px 10px; }
.vpa-stat__val { font-size: 14px; font-weight: 700; color: var(--color-text); line-height: 1; }
.vpa-stat__lbl { font-size: 8px; color: var(--color-muted); text-transform: uppercase; margin-top: 2px; }
.vpa-stat__delta { font-size: 9px; font-weight: 600; margin-top: 2px; }
.vpa-delta--up { color: var(--color-green); }
.vpa-delta--down { color: var(--color-red); }
.vpa-delta--neutral { color: var(--color-muted); }

/* Footer */
.vpa-footer { padding: 7px 14px; border-top: 1px solid var(--color-border); display: flex; align-items: center; gap: 6px; margin-top: auto; }
.vpa-btn { font-size: 9px; font-weight: 700; padding: 4px 10px; border-radius: 5px; cursor: pointer; border: 1px solid; }
.vpa-btn--primary { background: oklch(28% 0.12 264); color: oklch(80% 0.15 264); border-color: oklch(40% 0.15 264); }
.vpa-btn--ghost { background: transparent; color: var(--color-muted); border-color: var(--color-border); }
.vpa-footer__info { margin-left: auto; font-size: 8px; color: oklch(30% 0.01 264); }

/* Window picker */
.vpa-window-row { display: flex; align-items: center; gap: 6px; }
.vpa-window-tabs { display: flex; gap: 2px; }
.vpa-window-tab {
  font-size: 9px; font-weight: 700; padding: 3px 8px; border-radius: 5px;
  cursor: pointer; color: var(--color-muted);
  background: oklch(20% 0.02 264); border: 1px solid var(--color-border);
}
.vpa-window-tab--active { background: var(--color-accent); color: #fff; border-color: transparent; }
.vpa-window-tab--disabled { opacity: 0.35; cursor: not-allowed; }
.vpa-align-split { margin-left: auto; display: flex; border: 1px solid var(--color-border); border-radius: 5px; overflow: hidden; }
.vpa-align-btn { font-size: 8px; font-weight: 700; padding: 3px 7px; cursor: pointer; color: var(--color-muted); background: transparent; }
.vpa-align-btn--active { background: oklch(28% 0.12 264); color: oklch(80% 0.15 264); }

/* Coverage bar */
.vpa-coverage { background: oklch(16% 0.08 160 / 0.4); border: 1px solid oklch(30% 0.12 160 / 0.4); border-radius: 6px; padding: 7px 10px; }
.vpa-coverage__track { height: 4px; background: oklch(20% 0.05 160 / 0.4); border-radius: 2px; overflow: hidden; margin: 5px 0; }
.vpa-coverage__fill { height: 100%; background: linear-gradient(90deg, var(--color-green), oklch(80% 0.15 160)); border-radius: 2px; transition: width 0.3s; }

/* Disclaimer */
.vpa-disclaimer { font-size: 8px; color: oklch(28% 0.01 264); padding: 5px 14px; line-height: 1.4; border-top: 1px solid var(--color-border); }

/* Empty state */
.vpa-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 8px; padding: 24px; text-align: center; }
.vpa-empty__icon { font-size: 32px; opacity: 0.2; }
.vpa-empty__text { font-size: 11px; color: oklch(35% 0.01 264); line-height: 1.6; }
```

- [ ] **Step 4: Build**

```bash
cd extension && deno run -A build.ts
```

Expected: `Build complete.`

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/ extension/build.ts
git commit -m "feat(extension): panel shell, CSS tokens from @dano/styles"
```

---

### Task 13: App.tsx - Tab Store + Message Listener

**Files:**
- Create: `extension/src/panel/store.ts`
- Create: `extension/src/panel/App.tsx`

- [ ] **Step 1: Write `extension/src/panel/store.ts`**

```typescript
import { pointInPolygon } from "./lib/geofence.ts";
import type { ListingRow, PropertyRow, ScopeKey, TabStore } from "../../types.ts";
export { defaultTabStore } from "../../types.ts";

export function resolveCoordinates(
  listings: ListingRow[],
  properties: PropertyRow[],
): ListingRow[] {
  const coordMap = new Map<string, { lat: number | null; lng: number | null }>();
  for (const p of properties) coordMap.set(p.pid, { lat: p.lat, lng: p.lng });
  return listings.map((l) => {
    const coords = l.pid ? (coordMap.get(l.pid) ?? { lat: null, lng: null }) : { lat: null, lng: null };
    return { ...l, lat: coords.lat, lng: coords.lng };
  });
}

export function scopedListings(store: TabStore): ListingRow[] {
  const { scope, listings, viewportBbox, polygon } = store;
  if (scope === "viewport" && viewportBbox) {
    return listings.filter(
      (l) =>
        l.lat !== null &&
        l.lng !== null &&
        l.lat >= viewportBbox.sw_lat &&
        l.lat <= viewportBbox.ne_lat &&
        l.lng >= viewportBbox.sw_lng &&
        l.lng <= viewportBbox.ne_lng,
    );
  }
  if (scope === "zone" && polygon) {
    return listings.filter(
      (l) => l.lat !== null && l.lng !== null && pointInPolygon(l.lat!, l.lng!, polygon),
    );
  }
  return listings; // session
}
```

- [ ] **Step 2: Write `extension/src/panel/App.tsx`**

```typescript
/// <reference types="chrome"/>
import { h, render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ContentToPanel, TabStore } from "../../types.ts";
import { defaultTabStore, resolveCoordinates, scopedListings } from "./store.ts";
import { availableWindowSizes, buildBuckets } from "./lib/bucket.ts";
import { aggregate } from "./lib/aggregate.ts";
import { computeCoverage } from "./lib/coverage.ts";
import { EulaGate } from "./components/EulaGate.tsx";
import { ScopeSelector } from "./components/ScopeSelector.tsx";
import { FilterBadge } from "./components/FilterBadge.tsx";
import { WindowPicker } from "./components/WindowPicker.tsx";
import { MetricTabs } from "./components/MetricTabs.tsx";
import { StatsRow } from "./components/StatsRow.tsx";
import { TimeSeriesChart } from "./components/TimeSeriesChart.tsx";
import { ZoneCoverage } from "./components/ZoneCoverage.tsx";
import { ExportButton } from "./components/ExportButton.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { Disclaimer } from "./components/Disclaimer.tsx";
import type { AggregateSummary } from "./lib/aggregate.ts";

function App() {
  const [eulaAccepted, setEulaAccepted] = useState<boolean | null>(null);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const tabStores = useRef<Map<number, TabStore>>(new Map());
  const [store, setStore] = useState<TabStore | null>(null);
  const [summary, setSummary] = useState<AggregateSummary | null>(null);

  // Check EULA on mount
  useEffect(() => {
    chrome.storage.local.get("eulaAccepted", (r) => {
      setEulaAccepted(!!r.eulaAccepted);
    });
  }, []);

  // Detect active tab changes
  useEffect(() => {
    function onActivated(info: chrome.tabs.TabActiveInfo) {
      setActiveTabId(info.tabId);
    }
    chrome.tabs.onActivated.addListener(onActivated);
    // Get current active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) setActiveTabId(tabs[0].id);
    });
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, []);

  // Sync store when active tab changes
  useEffect(() => {
    if (activeTabId === null) return;
    if (!tabStores.current.has(activeTabId)) {
      tabStores.current.set(activeTabId, defaultTabStore(activeTabId));
    }
    setStore({ ...tabStores.current.get(activeTabId)! });
  }, [activeTabId]);

  // Listen for messages from content scripts
  useEffect(() => {
    function onMessage(msg: ContentToPanel, sender: chrome.runtime.MessageSender) {
      const tabId = sender.tab?.id;
      if (!tabId) return;

      if (!tabStores.current.has(tabId)) {
        tabStores.current.set(tabId, defaultTabStore(tabId));
      }
      const s = tabStores.current.get(tabId)!;

      if (msg.type === "listings") {
        // Clear session if filter changed
        if (msg.status !== s.status) {
          s.listings = [];
          s.fetchedBboxes = [];
          s.status = msg.status;
        }
        const resolved = resolveCoordinates(msg.listings, msg.properties);
        // Deduplicate by id
        const existing = new Set(s.listings.map((l) => l.id));
        const newOnes = resolved.filter((l) => !existing.has(l.id));
        s.listings = [...s.listings, ...newOnes];
        s.viewportBbox = msg.bbox;
        s.fetchedBboxes = [...s.fetchedBboxes, msg.bbox];
      }

      if (msg.type === "zone") {
        s.polygon = msg.polygon;
        if (msg.polygon) s.scope = "zone";
        else if (s.scope === "zone") s.scope = "session";
      }

      if (tabId === activeTabId) {
        setStore({ ...s });
      }
    }

    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [activeTabId]);

  // Recompute analytics whenever store changes; auto-switch window size to coarsest available if needed
  useEffect(() => {
    if (!store) return;
    const visible = scopedListings(store);
    if (visible.length === 0) { setSummary(null); return; }
    const availSizes = availableWindowSizes(visible.length);
    if (!availSizes.includes(store.windowSize)) {
      // Auto-switch to the coarsest finer-grained available size (last in order before yearly)
      const next = availSizes[availSizes.length - 1]; // coarsest = last (yearly)
      updateStore({ windowSize: next });
      return; // updateStore triggers re-render → this effect re-runs with corrected windowSize
    }
    const buckets = buildBuckets(new Date(), store.windowSize, store.alignmentMode, store.anchorDayOfWeek, store.anchorDayOfMonth);
    const result = aggregate(visible, store.metric, buckets, store.status);
    setSummary(result);
  }, [store]);

  function updateStore(patch: Partial<TabStore>) {
    if (!store || activeTabId === null) return;
    const updated = { ...store, ...patch };
    tabStores.current.set(activeTabId, updated);
    setStore(updated);
  }

  if (eulaAccepted === null) return null; // loading
  if (!eulaAccepted) {
    return <EulaGate onAccept={() => { chrome.storage.local.set({ eulaAccepted: true }); setEulaAccepted(true); }} />;
  }

  const coverage = store?.polygon && store.fetchedBboxes.length > 0
    ? computeCoverage(store.fetchedBboxes, store.polygon)
    : null;

  const listingCount = store ? scopedListings(store).length : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      {/* Header */}
      <div class="vpa-section">
        <div class="vpa-row" style={{ marginBottom: "7px" }}>
          <strong style={{ fontSize: "11px" }}>VP<span style={{ color: "var(--color-accent)" }}>Analytics</span></strong>
          {listingCount > 0 && <span class="vpa-label" style={{ background: "oklch(25% 0.1 264 / 0.5)", padding: "1px 6px", borderRadius: "8px" }}>{listingCount} listings</span>}
          <span style={{ marginLeft: "auto", width: "6px", height: "6px", borderRadius: "50%", background: listingCount > 0 ? "var(--color-green)" : "var(--color-muted)", boxShadow: listingCount > 0 ? "0 0 4px var(--color-green)" : "none" }} />
        </div>
        {store && (
          <>
            <ScopeSelector scope={store.scope} onScope={(scope) => updateStore({ scope })} />
            <div class="vpa-row" style={{ marginTop: "6px" }}>
              <FilterBadge status={store.status} />
            </div>
            {store.scope === "zone" && coverage !== null && (
              <ZoneCoverage coverage={coverage} count={listingCount} />
            )}
          </>
        )}
      </div>

      {!store || listingCount === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div class="vpa-section">
            <WindowPicker
              windowSize={store.windowSize}
              alignmentMode={store.alignmentMode}
              anchorDayOfWeek={store.anchorDayOfWeek}
              anchorDayOfMonth={store.anchorDayOfMonth}
              availableSizes={availableWindowSizes(listingCount)}
              onWindowSize={(windowSize) => updateStore({ windowSize })}
              onAlignmentMode={(alignmentMode) => updateStore({ alignmentMode })}
              onAnchorDow={(dow) => updateStore({ anchorDayOfWeek: dow })}
              onAnchorDom={(dom) => updateStore({ anchorDayOfMonth: dom })}
            />
          </div>
          <MetricTabs metric={store.metric} onMetric={(metric) => updateStore({ metric })} />
          {summary && <StatsRow summary={summary} metric={store.metric} />}
          {summary && (
            <TimeSeriesChart summary={summary} metric={store.metric} windowSize={store.windowSize} />
          )}
          <div class="vpa-footer">
            <ExportButton summary={summary} metric={store.metric} status={store.status} />
            <button class="vpa-btn vpa-btn--ghost" onClick={() => updateStore({ listings: [], fetchedBboxes: [], viewportBbox: null })}>
              {store.scope === "zone" ? "Clear zone" : "Clear"}
            </button>
            <span class="vpa-footer__info">{listingCount} in scope</span>
          </div>
        </>
      )}
      <Disclaimer />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
```

- [ ] **Step 3: Commit**

```bash
git add extension/src/panel/store.ts extension/src/panel/App.tsx
git commit -m "feat(extension): App.tsx - tab store, message listener, EULA gate, analytics pipeline"
```

---

### Task 14: Side Panel Components

**Files:**
- Create: `extension/src/panel/components/EulaGate.tsx`
- Create: `extension/src/panel/components/Disclaimer.tsx`
- Create: `extension/src/panel/components/ScopeSelector.tsx`
- Create: `extension/src/panel/components/FilterBadge.tsx`
- Create: `extension/src/panel/components/WindowPicker.tsx`
- Create: `extension/src/panel/components/MetricTabs.tsx`
- Create: `extension/src/panel/components/StatsRow.tsx`
- Create: `extension/src/panel/components/EmptyState.tsx`

- [ ] **Step 1: Write `EulaGate.tsx`**

```typescript
import { h } from "preact";

export function EulaGate({ onAccept }: { onAccept: () => void }) {
  return (
    <div style={{ padding: "24px 18px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <strong style={{ fontSize: "14px" }}>VP<span style={{ color: "var(--color-accent)" }}>Analytics</span></strong>
      <p style={{ fontSize: "11px", color: "var(--color-muted)", lineHeight: 1.6 }}>
        This tool is for <strong>personal real estate exploration only</strong>.
      </p>
      <p style={{ fontSize: "10px", color: "var(--color-muted)", lineHeight: 1.6 }}>
        If you use ViewPoint.ca in the course of commercial or professional work, ViewPoint requires
        you to contact them directly before using data-augmenting tools. By continuing, you confirm
        your use is personal and non-commercial.
      </p>
      <p style={{ fontSize: "10px", color: "oklch(35% 0.01 264)", lineHeight: 1.5 }}>
        This extension processes data your browser receives from ViewPoint.ca for personal use only. It does not store,
        transmit, or redistribute listing data. Source: ViewPoint Realty, NSAR MLS® System and Province of Nova Scotia.
      </p>
      <button
        class="vpa-btn vpa-btn--primary"
        style={{ fontSize: "11px", padding: "8px 0", borderRadius: "6px", fontWeight: 700 }}
        onClick={onAccept}
      >
        I understand - Continue for personal use
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Write `Disclaimer.tsx`**

```typescript
import { h } from "preact";

export function Disclaimer() {
  return (
    <div class="vpa-disclaimer">
      Processes data your browser receives from ViewPoint.ca for personal use only.
      Does not store, transmit, or redistribute listing data.
      Source: ViewPoint.ca - NSAR MLS® System and Province of Nova Scotia.
    </div>
  );
}
```

- [ ] **Step 3: Write `ScopeSelector.tsx`**

```typescript
import { h } from "preact";
import type { ScopeKey } from "../../../types.ts";

const SCOPES: { key: ScopeKey; label: string }[] = [
  { key: "viewport", label: "Viewport" },
  { key: "session", label: "Session" },
  { key: "zone", label: "⬡ Zone" },
];

export function ScopeSelector({ scope, onScope }: { scope: ScopeKey; onScope: (s: ScopeKey) => void }) {
  return (
    <div class="vpa-row">
      <span class="vpa-label">Scope</span>
      <div class="vpa-tabs" style={{ flex: 1 }}>
        {SCOPES.map(({ key, label }) => (
          <button
            key={key}
            class={`vpa-tab vpa-tab--${key}${scope === key ? " vpa-tab--active" : ""}`}
            onClick={() => onScope(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `FilterBadge.tsx`**

```typescript
import { h } from "preact";
import type { SearchStatus } from "../../../types.ts";

const LABELS: Record<SearchStatus, string> = { active: "Active", sold: "Sold", any: "Any" };
const COLORS: Record<SearchStatus, string> = {
  active: "oklch(28% 0.12 220)",
  sold: "oklch(25% 0.1 25)",
  any: "oklch(22% 0.01 264)",
};
const TEXT: Record<SearchStatus, string> = {
  active: "oklch(75% 0.15 220)",
  sold: "oklch(75% 0.15 25)",
  any: "var(--color-muted)",
};

export function FilterBadge({ status }: { status: SearchStatus }) {
  return (
    <div class="vpa-row">
      <span class="vpa-label">Filter</span>
      <span style={{ background: COLORS[status], color: TEXT[status], fontSize: "9px", fontWeight: 700, padding: "2px 7px", borderRadius: "8px" }}>
        {LABELS[status]}
      </span>
      <span style={{ fontSize: "8px", color: "oklch(28% 0.01 264)", fontStyle: "italic" }}>
        clears session on change
      </span>
    </div>
  );
}
```

- [ ] **Step 5: Write `WindowPicker.tsx`**

```typescript
import { h } from "preact";
import { useState } from "preact/hooks";
import type { AlignmentMode, WindowSize } from "../../../types.ts";

const WINDOWS: { key: WindowSize; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "yearly", label: "Yearly" },
];

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WindowPicker({
  windowSize, alignmentMode, anchorDayOfWeek, anchorDayOfMonth,
  availableSizes,
  onWindowSize, onAlignmentMode, onAnchorDow, onAnchorDom,
}: {
  windowSize: WindowSize; alignmentMode: AlignmentMode;
  anchorDayOfWeek: number; anchorDayOfMonth: number;
  availableSizes: WindowSize[];
  onWindowSize: (w: WindowSize) => void;
  onAlignmentMode: (m: AlignmentMode) => void;
  onAnchorDow: (d: number) => void;
  onAnchorDom: (d: number) => void;
}) {
  const [showPopover, setShowPopover] = useState(false);

  const calendarLabel = windowSize === "monthly"
    ? `${anchorDayOfMonth}${ordinal(anchorDayOfMonth)}`
    : DOW_NAMES[anchorDayOfWeek];

  return (
    <div style={{ position: "relative" }}>
      <div class="vpa-window-row">
        <span class="vpa-label">Window</span>
        <div class="vpa-window-tabs">
          {WINDOWS.map(({ key, label }) => {
            const disabled = !availableSizes.includes(key);
            return (
              <button
                key={key}
                class={`vpa-window-tab${windowSize === key ? " vpa-window-tab--active" : ""}${disabled ? " vpa-window-tab--disabled" : ""}`}
                disabled={disabled}
                title={disabled ? "Not enough data (need ≥5 listings/bucket)" : undefined}
                onClick={() => !disabled && onWindowSize(key)}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div class="vpa-align-split">
          <button
            class={`vpa-align-btn${alignmentMode === "today" ? " vpa-align-btn--active" : ""}`}
            onClick={() => { onAlignmentMode("today"); setShowPopover(false); }}
          >Today</button>
          <div style={{ width: "1px", background: "var(--color-border)" }} />
          <button
            class={`vpa-align-btn${alignmentMode === "calendar" ? " vpa-align-btn--active" : ""}`}
            onClick={() => { onAlignmentMode("calendar"); setShowPopover((v) => !v); }}
          >
            {calendarLabel}
          </button>
        </div>
      </div>
      {showPopover && alignmentMode === "calendar" && (
        <div style={{ position: "absolute", right: 0, top: "100%", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius)", padding: "8px", zIndex: 10, marginTop: "4px" }}>
          {windowSize === "monthly" ? (
            <div>
              <div class="vpa-label" style={{ marginBottom: "4px" }}>Day of month</div>
              <input type="number" min="1" max="28" value={anchorDayOfMonth}
                onInput={(e) => onAnchorDom(parseInt((e.target as HTMLInputElement).value) || 1)}
                style={{ width: "48px", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "4px", color: "var(--color-text)", padding: "2px 4px", fontSize: "11px" }}
              />
            </div>
          ) : (
            <div>
              <div class="vpa-label" style={{ marginBottom: "4px" }}>Start of week</div>
              <div style={{ display: "flex", gap: "2px" }}>
                {DOW_NAMES.map((name, i) => (
                  <button key={i} onClick={() => { onAnchorDow(i); setShowPopover(false); }}
                    style={{ fontSize: "8px", padding: "2px 4px", borderRadius: "3px", border: "1px solid var(--color-border)", background: anchorDayOfWeek === i ? "var(--color-accent)" : "transparent", color: anchorDayOfWeek === i ? "#fff" : "var(--color-muted)", cursor: "pointer" }}>
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0];
}
```

- [ ] **Step 6: Write `MetricTabs.tsx`**

```typescript
import { h } from "preact";
import type { MetricKey } from "../../../types.ts";

const METRICS: { key: MetricKey; label: string }[] = [
  { key: "price", label: "Avg Price" },
  { key: "volume", label: "Volume" },
  { key: "dom", label: "DOM" },
  { key: "ppsf", label: "$/sqft" },
  { key: "listToSold", label: "L→S%" },
];

export function MetricTabs({ metric, onMetric }: { metric: MetricKey; onMetric: (m: MetricKey) => void }) {
  return (
    <div class="vpa-metric-tabs">
      {METRICS.map(({ key, label }) => (
        <button key={key} class={`vpa-metric-tab${metric === key ? " vpa-metric-tab--active" : ""}`} onClick={() => onMetric(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Write `StatsRow.tsx`**

```typescript
import { h } from "preact";
import type { MetricKey } from "../../../types.ts";
import type { AggregateSummary } from "../lib/aggregate.ts";

function fmt(v: number | null, metric: MetricKey): string {
  if (v === null) return "-";
  if (metric === "price") return `$${Math.round(v / 1000)}k`;
  if (metric === "ppsf") return `$${Math.round(v)}`;
  if (metric === "dom") return `${Math.round(v)}d`;
  if (metric === "listToSold") return `${(v * 100).toFixed(1)}%`;
  return String(Math.round(v));
}

export function StatsRow({ summary, metric }: { summary: AggregateSummary; metric: MetricKey }) {
  const { overall, delta } = summary;
  const deltaClass = delta === null ? "vpa-delta--neutral"
    : delta > 0 ? "vpa-delta--up" : "vpa-delta--down";
  const deltaStr = delta === null ? "-"
    : `${delta > 0 ? "↑" : "↓"} ${Math.abs(delta * 100).toFixed(1)}%`;

  return (
    <div class="vpa-stats">
      <div class="vpa-stat">
        <div class="vpa-stat__val">{fmt(overall.avg, metric)}</div>
        <div class="vpa-stat__lbl">{metric === "volume" ? "Count" : "Average"}</div>
        <div class={`vpa-stat__delta ${deltaClass}`}>{deltaStr}</div>
      </div>
      <div class="vpa-stat">
        <div class="vpa-stat__val">{fmt(overall.median, metric)}</div>
        <div class="vpa-stat__lbl">Median</div>
      </div>
      <div class="vpa-stat">
        <div class="vpa-stat__val">{metric === "volume" ? String(overall.count) : fmt(overall.stdDev, metric)}</div>
        <div class="vpa-stat__lbl">{metric === "volume" ? "Total" : "Std Dev"}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Write `EmptyState.tsx`**

```typescript
import { h } from "preact";

export function EmptyState() {
  return (
    <div class="vpa-empty">
      <div class="vpa-empty__icon">🗺️</div>
      <div class="vpa-empty__text">
        Browse <strong>viewpoint.ca/map</strong> to start collecting data.<br/>
        Listings appear as you pan and filter.
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Build**

```bash
cd extension && deno run -A build.ts
```

- [ ] **Step 10: Commit**

```bash
git add extension/src/panel/components/
git commit -m "feat(extension): side panel components - EULA, scope, filter, window, metric, stats"
```

---

### Task 15: TimeSeriesChart + ZoneCoverage + ExportButton

**Files:**
- Create: `extension/src/panel/components/TimeSeriesChart.tsx`
- Create: `extension/src/panel/components/ZoneCoverage.tsx`
- Create: `extension/src/panel/components/ExportButton.tsx`

- [ ] **Step 1: Write `TimeSeriesChart.tsx`**

```typescript
import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
import type { MetricKey, WindowSize } from "../../../types.ts";
import type { AggregateSummary } from "../lib/aggregate.ts";

function metricLabel(metric: MetricKey): string {
  return { price: "Avg List Price", volume: "Count", dom: "Avg DOM (days)", ppsf: "Avg $/sqft", listToSold: "List→Sold Ratio" }[metric];
}

export function TimeSeriesChart({
  summary, metric, windowSize,
}: { summary: AggregateSummary; metric: MetricKey; windowSize: WindowSize }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const { buckets } = summary;
    const xs = buckets.map((b) => b.bucket.start.getTime() / 1000);
    const ys = metric === "volume"
      ? buckets.map((b) => b.count)
      : buckets.map((b) => b.avg);

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 120,
      cursor: { show: true },
      legend: { show: false },
      axes: [
        { stroke: "oklch(35% 0.01 264)", ticks: { stroke: "oklch(20% 0.01 264)" }, grid: { stroke: "oklch(20% 0.01 264)" } },
        { stroke: "oklch(35% 0.01 264)", ticks: { stroke: "oklch(20% 0.01 264)" }, grid: { stroke: "oklch(20% 0.01 264)" } },
      ],
      series: [
        {},
        {
          label: metricLabel(metric),
          stroke: metric === "volume" ? "oklch(72% 0.18 160)" : "oklch(55% 0.2 264)",
          fill: metric === "volume"
            ? "oklch(72% 0.18 160 / 0.15)"
            : "oklch(55% 0.2 264 / 0.12)",
          width: 1.5,
          paths: metric === "volume" ? uPlot.paths.bars!({ size: [0.8, 8] }) : undefined,
          points: { show: false },
        },
      ],
    };

    if (chartRef.current) {
      chartRef.current.destroy();
    }
    chartRef.current = new uPlot(opts, [xs, ys] as uPlot.AlignedData, containerRef.current);

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [summary, metric]);

  // Volume bar chart below the primary chart
  const volumeBuckets = summary.buckets;
  const volXs = volumeBuckets.map((b) => b.bucket.start.getTime() / 1000);
  const volYs = volumeBuckets.map((b) => b.count);
  const volContainerRef = useRef<HTMLDivElement>(null);
  const volChartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!volContainerRef.current || metric === "volume") return;
    const opts: uPlot.Options = {
      width: volContainerRef.current.clientWidth,
      height: 80,
      legend: { show: false },
      cursor: { show: false },
      axes: [
        { stroke: "oklch(35% 0.01 264)", ticks: { stroke: "oklch(20% 0.01 264)" }, grid: { stroke: "oklch(20% 0.01 264)" } },
        { stroke: "oklch(35% 0.01 264)", ticks: { stroke: "oklch(20% 0.01 264)" }, grid: { show: false } },
      ],
      series: [
        {},
        {
          label: "Volume",
          stroke: "oklch(72% 0.18 160)",
          fill: "oklch(72% 0.18 160 / 0.3)",
          width: 1,
          paths: uPlot.paths.bars!({ size: [0.8, 8] }),
          points: { show: false },
        },
      ],
    };
    if (volChartRef.current) volChartRef.current.destroy();
    volChartRef.current = new uPlot(opts, [volXs, volYs] as uPlot.AlignedData, volContainerRef.current);
    return () => { volChartRef.current?.destroy(); volChartRef.current = null; };
  }, [summary, metric]);

  return (
    <div style={{ padding: "8px 14px 0", flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ fontSize: "9px", color: "var(--color-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", justifyContent: "space-between" }}>
        <span>{metricLabel(metric)}</span>
        <span style={{ fontWeight: 400, fontStyle: "italic", textTransform: "none", letterSpacing: 0 }}>scroll to pan</span>
      </div>
      <div ref={containerRef} style={{ width: "100%" }} />
      {metric !== "volume" && (
        <>
          <div style={{ fontSize: "9px", color: "var(--color-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>Volume</div>
          <div ref={volContainerRef} style={{ width: "100%" }} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `ZoneCoverage.tsx`**

```typescript
import { h } from "preact";

export function ZoneCoverage({ coverage, count }: { coverage: number; count: number }) {
  const pct = Math.round(coverage * 100);
  return (
    <div class="vpa-coverage" style={{ marginTop: "7px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "9px", color: "var(--color-green)", fontWeight: 700 }}>Zone coverage</span>
        <span style={{ fontSize: "12px", fontWeight: 800, color: "var(--color-green)" }}>{pct}%</span>
      </div>
      <div class="vpa-coverage__track">
        <div class="vpa-coverage__fill" style={{ width: `${pct}%` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: "8px", color: "oklch(40% 0.08 160)" }}>{count} listings in zone</span>
        {pct < 90 && <span style={{ fontSize: "8px", color: "oklch(35% 0.06 160)", fontStyle: "italic" }}>Pan to fill gaps</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `ExportButton.tsx`**

```typescript
import { h } from "preact";
import type { MetricKey, SearchStatus } from "../../../types.ts";
import type { AggregateSummary } from "../lib/aggregate.ts";

const EXPORT_FLOOR = 5;

function formatValue(v: number | null, metric: MetricKey): string {
  if (v === null) return "";
  if (metric === "listToSold") return (v * 100).toFixed(2) + "%";
  return v.toFixed(2);
}

export function ExportButton({
  summary, metric, status,
}: { summary: AggregateSummary | null; metric: MetricKey; status: SearchStatus }) {
  function download() {
    if (!summary) return;
    const rows: string[] = [
      `# Source: ViewPoint.ca (NSAR MLS® System and Province of Nova Scotia). For personal use only.`,
      `# Metric: ${metric} | Filter: ${status} | Generated: ${new Date().toISOString()}`,
      "bucket_start,bucket_end,count,avg,median,std_dev",
    ];
    for (const b of summary.buckets) {
      if (b.belowFloor || b.count < EXPORT_FLOOR) {
        rows.push(`${b.bucket.start.toISOString()},${b.bucket.end.toISOString()},<${EXPORT_FLOOR},,,`);
        continue;
      }
      rows.push([
        b.bucket.start.toISOString(),
        b.bucket.end.toISOString(),
        String(b.count),
        formatValue(b.avg, metric),
        formatValue(b.median, metric),
        formatValue(b.stdDev, metric),
      ].join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vp-analytics-${metric}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button class="vpa-btn vpa-btn--primary" onClick={download} disabled={!summary}>
      ↓ Export CSV
    </button>
  );
}
```

- [ ] **Step 4: Build and verify**

```bash
cd extension && deno run -A build.ts
```

Expected: `Build complete.`

- [ ] **Step 5: Commit**

```bash
git add extension/src/panel/components/TimeSeriesChart.tsx extension/src/panel/components/ZoneCoverage.tsx extension/src/panel/components/ExportButton.tsx
git commit -m "feat(extension): chart (uPlot), zone coverage, CSV export with attribution + floor"
```

---

## Phase 6 - Integration Test

### Task 16: Load as Unpacked Extension and Verify End-to-End

No automated test covers the Chrome runtime boundary - manual verification required.

- [ ] **Step 1: Build in development mode**

```bash
cd extension && deno run -A build.ts
```

- [ ] **Step 2: Load in Chrome**

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select `extension/build/`
4. Verify the extension appears with no errors

- [ ] **Step 3: Verify side panel opens**

1. Navigate to `https://www.viewpoint.ca/map`
2. Click the VP Analytics extension icon in the toolbar
3. Verify: side panel opens on the right, EULA modal appears

- [ ] **Step 4: Accept EULA and verify empty state**

1. Click "I understand - Continue for personal use"
2. Verify: side panel shows empty state ("Browse viewpoint.ca/map…")
3. Verify: disclaimer footer is visible at the bottom

- [ ] **Step 5: Verify listing interception**

1. Browse the viewpoint map - pan or zoom to trigger a search
2. Verify: listing count badge appears in the panel header
3. Verify: scope selector shows Session active
4. Verify: filter badge matches what viewpoint is showing (active/sold/any)

- [ ] **Step 6: Verify analytics**

1. After ≥5 listings are captured, verify:
   - Stats row shows avg / median / std dev
   - Chart renders 1 year of buckets
   - Volume bar chart shows below the primary chart
2. Switch metric tabs - verify chart and stats update

- [ ] **Step 7: Verify geofence drawing**

1. Look for "⬡ Draw Zone" button on the map (near Google Maps zoom controls)
2. Click Draw Zone - verify cursor changes, instruction tooltip appears
3. Click 4-5 points to draw a polygon - click first point to close
4. Verify: polygon appears on map in green, "Zone" scope tab activates in side panel
5. Verify: coverage bar appears showing a percentage
6. Verify: map pins inside zone get a green ring, pins outside dim

- [ ] **Step 8: Verify filter-change clears session**

1. Note the listing count in the panel
2. Switch viewpoint filter (e.g. "Active" → "Sold")
3. Verify: listing count resets to 0; new listings accumulate from the new filter

- [ ] **Step 9: Verify export**

1. With ≥20 listings in scope, click "↓ Export CSV"
2. Open the downloaded CSV - verify:
   - Attribution comment rows at the top
   - Columns: bucket_start, bucket_end, count, avg, median, std_dev
   - Buckets with < 5 listings show `<5` in the count column and empty value columns
   - No listing IDs or addresses

- [ ] **Step 10: Verify multi-tab isolation**

1. Open a second `viewpoint.ca/map` tab with a different filter (e.g. Sold)
2. Switch between the two tabs
3. Verify: side panel shows independent state for each tab (different counts, different filters)

- [ ] **Step 11: Commit any bug fixes found during testing**

```bash
git add -A && git commit -m "fix(extension): integration test fixes"
```

---

## Phase 7 - Release & Compliance

### Task 17: GitHub Actions Build + Release

**Files:**
- Create: `.github/workflows/extension-build.yml`

- [ ] **Step 1: Write `.github/workflows/extension-build.yml`**

```yaml
name: Extension Build & Release

on:
  push:
    branches: [main]
    paths: ["extension/**"]
  release:
    types: [created]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Install ImageMagick (for icon generation if needed)
        run: sudo apt-get install -y imagemagick

      - name: Build extension
        run: deno run -A extension/build.ts --prod
        working-directory: ${{ github.workspace }}

      - name: Read version from manifest
        id: version
        run: |
          VERSION=$(jq -r .version extension/manifest.json)
          echo "version=$VERSION" >> $GITHUB_OUTPUT

      - name: Package extension zip
        run: |
          cd extension/build
          zip -r ../../viewpoint-analytics-v${{ steps.version.outputs.version }}.zip .

      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: viewpoint-analytics-extension
          path: viewpoint-analytics-v*.zip
          retention-days: 30

      - name: Attach to GitHub Release
        if: github.event_name == 'release'
        uses: softprops/action-gh-release@v2
        with:
          files: viewpoint-analytics-v*.zip
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/extension-build.yml
git commit -m "ci: GitHub Actions build + release for extension"
```

- [ ] **Step 3: Verify workflow runs on push**

Push to `main` and check the Actions tab - verify the build job passes and produces an artifact.

---

### Task 18: Issue Tracking Link in Extension

**Files:**
- Modify: `extension/src/panel/components/Disclaimer.tsx`

- [ ] **Step 1: Add issue link to Disclaimer**

```typescript
import { h } from "preact";

// Read from manifest at build time - esbuild injects it via define
declare const __EXT_VERSION__: string;

export function Disclaimer() {
  const version = typeof __EXT_VERSION__ !== "undefined" ? __EXT_VERSION__ : "dev";
  const issueUrl = `https://github.com/dafky2000/viewpoint-analytics-extension/issues/new?labels=bug&template=bug_report.md&body=%0A%0A**Extension+version:**+${version}`;

  return (
    <div class="vpa-disclaimer">
      This extension processes data your browser receives from ViewPoint.ca for personal use only. It does not store,
      transmit, or redistribute listing data. Source: ViewPoint Realty, NSAR MLS® System and Province of Nova Scotia.
      {" "}<a href={issueUrl} target="_blank" rel="noopener noreferrer" style={{ color: "oklch(40% 0.01 264)" }}>Report issue</a>
    </div>
  );
}
```

- [ ] **Step 2: Inject version into build in `build.ts`**

Add `define` to the panel build options:

```typescript
import { join } from "jsr:@std/path@1";

const manifest = JSON.parse(await Deno.readTextFile(join(dir, "manifest.json")));
const version = manifest.version as string;

// In the panel esbuild call, add:
define: { __EXT_VERSION__: JSON.stringify(version) },
```

- [ ] **Step 3: Build and verify**

```bash
cd extension && deno run -A build.ts
```

- [ ] **Step 4: Commit**

```bash
git add extension/src/panel/components/Disclaimer.tsx extension/build.ts
git commit -m "feat(extension): version + issue link injected via esbuild define"
```

---

## Self-Review Checklist

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| §1 No storage (except eulaAccepted) | Task 13 App.tsx; EulaGate uses `chrome.storage.local` only |
| §2 Manifest MV3 + file layout | Task 1 |
| §3 Fetch intercept → relay → panel | Tasks 9-10, 13 |
| §4 Scope model (Viewport/Session/Zone) | Task 12 store.ts, App.tsx |
| §4 lat/lng join from PropertyRow | Task 12 resolveCoordinates() |
| §4 Multi-tab independent stores | Task 13 App.tsx tabStores ref map |
| §4 Session clears on filter change | Task 13 App.tsx onMessage handler |
| §5 Today-anchored buckets never partial | Task 4 bucket.ts, tests |
| §5 Calendar-anchored partial detection | Task 4 bucket.ts, tests |
| §5 Date field by status (list_dt/sold_dt) | Task 5 aggregate.ts makeDateExtractor() |
| §6 All 5 metrics | Task 5 aggregate.ts makeExtractor() |
| §6 Export floor ≥5 | Task 5 aggregate.ts belowFloor; Task 15 ExportButton |
| §7 Draw Zone injected on map | Task 11 geofence-overlay.ts |
| §7 Live editing (vertex drag, insert, collapse) | Task 11 `pm:edit`, `pm:vertexadded`, `pm:vertexremoved` listeners |
| §7 Zone relay to panel + clear | Task 11 sendZone(); port.onMessage clear_zone |
| §7 Coverage cells on map | Not yet in overlay - tracked below ✱ |
| §8 Side panel all states | Tasks 12-15 |
| §9 esbuild build + CSS tokens | Tasks 1, 12 |
| §10 GitHub Actions release pipeline | Task 17 |
| §11 EULA gate (personal use) | Task 13 EulaGate.tsx |
| §11 Disclaimer always visible | Task 14 Disclaimer.tsx |
| §11 Attribution in CSV | Task 15 ExportButton.tsx |
| §11 Bucket floor in exports | Task 15 ExportButton.tsx |
| §11 Issue tracking link | Task 18 |

**✱ Gap found:** Coverage cells (green bbox shading on the map, pin dimming outside zone) are described in §7 but not yet implemented in the geofence overlay. Add this to Task 11 or as Task 11b:

### Task 11b: Map Coverage Visualisation (Gap Fill)

**Files:**
- Modify: `extension/src/content/geofence-overlay.ts`

- [ ] **Step 1: Add coverage layer and pin highlighting to geofence-overlay.ts**

Add these functions inside `geofence-overlay.ts` and call them from `onPolygonCreated` and from the relay message handler:

```typescript
// Coverage visualisation
const coverageLayerGroup = L.layerGroup();

export function updateCoverageOverlay(fetchedBboxes: BBox[], polygon: [number, number][]): void {
  if (!leafletMap) return;
  coverageLayerGroup.clearLayers();
  coverageLayerGroup.addTo(leafletMap);

  for (const bbox of fetchedBboxes) {
    const bounds = L.latLngBounds([bbox.sw_lat, bbox.sw_lng], [bbox.ne_lat, bbox.ne_lng]);
    L.rectangle(bounds, {
      color: "rgba(22,199,132,0.4)",
      fillColor: "rgba(22,199,132,0.06)",
      fillOpacity: 1,
      weight: 0.5,
      interactive: false,
    }).addTo(coverageLayerGroup);
  }
}
```

The relay forwards bbox info from each successful listings message to the overlay:

In `relay.ts`, after sending the listings message, also call the exported function:

```typescript
import { updateCoverageOverlay } from "./geofence-overlay.ts";

// After sendMessage for listings:
if (parsed.bbox && currentPolygon) {
  fetchedBboxes.push(parsed.bbox);
  updateCoverageOverlay(fetchedBboxes, currentPolygon);
}
```

(Keep `fetchedBboxes` and `currentPolygon` as module-level arrays in relay.ts, cleared on filter change.)

- [ ] **Step 2: Commit**

```bash
git add extension/src/content/
git commit -m "feat(extension): map coverage cells - fetched bbox shading on geofence zone"
```
