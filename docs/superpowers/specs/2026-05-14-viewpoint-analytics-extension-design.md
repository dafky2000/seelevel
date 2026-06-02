# ViewPoint Analytics - Chrome Extension Design Spec

**Date:** 2026-05-14\
**Status:** Approved\
**Target:** Chrome Web Store (MV3), distributable

---

## 1. Overview

A Chrome extension that overlays real-estate analytics on top of viewpoint.ca.
It passively intercepts listing data the user's browser already receives and
computes aggregate metrics (avg, median, std dev, count, DOM, $/sqft, list→sold
ratio) over rolling time windows. A native Chrome Side Panel displays
time-series charts. A lightweight content script injects a polygon-drawing tool
onto the viewpoint map so users can scope analytics to a custom geofenced area.

**Core constraints:**

- No persistent storage. No `storage`, `cookies`, `webRequest`, or `tabs`
  permissions.
- No extra API calls - intercept only. The extension reads data viewpoint
  already loads.
- Data lives exclusively in Preact side panel state. Closing the panel clears
  everything.
- Export produces aggregated chart buckets (avg + count per bucket) as CSV -
  never raw listing records.
- Distributable: minimal permission footprint for Chrome Web Store review.

---

## 2. Extension Structure

### Manifest (MV3)

```json
{
  "manifest_version": 3,
  "name": "ViewPoint Analytics",
  "permissions": ["sidePanel", "activeTab", "scripting"],
  "host_permissions": ["*://*.viewpoint.ca/*"],
  "side_panel": { "default_path": "build/panel/index.html" },
  "content_scripts": [
    {
      "matches": ["*://*.viewpoint.ca/map*"],
      "js": ["build/content/relay.js"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    }
  ],
  "background": { "service_worker": "build/background/sw.js" }
}
```

> `fetch-interceptor.js` is injected into MAIN world programmatically via
> `chrome.scripting.executeScript` from `relay.js` on load - this is the
> standard MV3 pattern for patching `window.fetch` without declaring a MAIN
> world content script in the manifest.

### File Layout

```
extension/
  manifest.json
  src/
    content/
      fetch-interceptor.ts    # MAIN world - patches window.fetch, fires CustomEvent
      relay.ts                # ISOLATED world - bridges CustomEvent → chrome.runtime.sendMessage
      geofence-overlay.ts     # injects Draw Zone button + Leaflet canvas overlay
    panel/
      index.html              # side panel shell
      App.tsx                 # Preact root, message listener, session accumulator
      components/
        ScopeSelector.tsx     # Viewport / Session / Zone tabs
        FilterBadge.tsx       # mirrors viewpoint's active/sold/any filter
        WindowPicker.tsx      # Daily / Weekly / Monthly + Today/Calendar alignment toggle
        MetricTabs.tsx        # Avg Price · Volume · DOM · $/sqft · List→Sold%
        StatsRow.tsx          # avg + median + std dev for current metric
        TimeSeriesChart.tsx   # scrollable/zoomable 1-year chart (uPlot)
        ZoneCoverage.tsx      # progress bar + % + estimated total
        ExportButton.tsx      # downloads aggregated CSV
      lib/
        aggregate.ts          # time bucketing, avg/median/stddev/count/DOM computation
        geofence.ts           # point-in-polygon (ray-casting), bbox-polygon intersection area
        parse.ts              # reused from scrapers/viewpoint/client.ts
        coverage.ts           # tracks fetched bboxes, computes union ∩ polygon / polygon area
    background/
      sw.js                   # minimal service worker (required by MV3); opens side panel on icon click
  build/                      # esbuild output
  build.ts                    # Deno esbuild build script
```

---

## 3. Data Flow

```
viewpoint XHR (/api/v2/listing/search)
  → fetch-interceptor.ts (MAIN world)
      patches window.fetch
      on response to /api/v2/listing/search:
        calls parseSearchResponse() → ListingRow[]
        fires CustomEvent('vpa:listings', { detail: { listings, bbox, status } })
  → relay.ts (ISOLATED world)
      listens for 'vpa:listings'
      reads current status from URL params / DOM
      calls chrome.runtime.sendMessage({ type: 'listings', listings, bbox, status })
  → App.tsx (side panel)
      chrome.runtime.onMessage listener
      if status changed → clear session accumulator
      appends ListingRow[] to sessionRef (useRef - not state, avoids re-render per batch)
      schedules debounced recompute (16ms)
  → aggregate()
      filters by scope (viewport bbox / all session / polygon point-in-polygon)
      filters by time window (last 365 days from today, using list_dt or sold_dt)
      buckets into daily/weekly/monthly intervals per alignment setting
      computes per-bucket: avg, median, stddev, count, avg DOM, avg $/sqft, avg list→sold%
  → TimeSeriesChart (uPlot)
      renders 1 year of buckets, pannable/zoomable
      Export button serialises visible buckets to CSV
```

### Status Detection

`relay.ts` reads the current viewpoint filter (active/sold/any) from the page
URL's query params (`?status=sold`, etc.) and attaches it to every message
batch. When the side panel receives a batch whose `status` differs from the
current session status, it clears `sessionRef` before appending - ensuring
session data is never a mix of filter modes.

### Bbox Tracking (for coverage)

Every successful batch message includes the `bbox` (sw_lat/sw_lng/ne_lat/ne_lng)
from the search URL. `coverage.ts` maintains a list of all received bboxes. When
a zone is active, it computes:

```
coverage % = area(union(bbox_i ∩ polygon)) / area(polygon) × 100
```

Polygon area and intersection area use the shoelace formula on geographic
coordinates (accurate enough at Nova Scotia scale without projection). Coverage
updates on every new batch.

---

## 4. Scope Model

| Scope        | What's included                                                                                      | Cleared when                                             |
| ------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Viewport** | Listings from the most recently received API response batch (i.e. the bbox viewpoint last requested) | Every new batch replaces the viewport set                |
| **Session**  | All listings accumulated since panel opened                                                          | Viewpoint filter changes (active/sold/any)               |
| **Zone**     | Session listings whose `lat/lng` is inside the drawn polygon                                         | Zone is redrawn or cleared; also clears on filter change |

**lat/lng join:** `ListingRow.lat/lng` is always `null` from our parser
(viewpoint returns coordinates on `PropertyRow`, not `ListingRow`). The relay
message includes both `listings` and `properties` arrays. `App.tsx` builds a
`pid → {lat, lng}` lookup from `properties` on each batch and annotates listings
before storing them. Listings with no resolvable coordinates are excluded from
Viewport and Zone scopes but included in Session.

**Multi-tab:** Each viewpoint tab is a fully independent workspace. Content
scripts tag every message with their `chrome.runtime` tab ID. The side panel
maintains a separate store per tab ID: separate listing accumulator, separate
scope selection, separate geofence polygon, separate metric/window/alignment
settings, separate coverage state. When the user switches between viewpoint
tabs, the side panel switches to that tab's store - the UI updates to reflect
that tab's independent state. Closing a tab destroys its store. This means
opening three viewpoint tabs with different filters gives three completely
independent analytics workspaces.

---

## 5. Rolling Window & Alignment

**Window sizes:** Daily · Weekly · Monthly (user-selectable tab)

**Alignment:**

- **Today** (default for all window sizes): buckets trail backwards from
  `Date.now()`. The most recent bucket may be partial (e.g. the current week so
  far).
- **Calendar** (opt-in):
  - Weekly → anchor to a chosen day-of-week (default: Monday). Bucket boundaries
    fall on that weekday.
  - Monthly → anchor to a chosen day-of-month (default: 1st). Bucket boundaries
    fall on that day each month.

**Time span:** Always 1 calendar year back from today. The chart renders all 365
days' worth of buckets. The user scrolls/zooms to explore specific windows.

**Date field by filter mode:**

- Active listings → `list_dt`
- Sold listings → `sold_dt` (falls back to `close_dt` if `sold_dt` is null)
- Any → each listing uses whichever date field is non-null (sold_dt/close_dt
  preferred, else list_dt)

**Partial/incomplete buckets:** Only Calendar-aligned buckets can be partial.
The current calendar period (e.g. the current Monday-anchored week if today is
Wednesday) has only accumulated a few days of data and is rendered with a
lighter fill and dashed top edge; its tooltip notes "(partial - in progress)".
Today-anchored buckets are never partial: a "1 week" bucket always spans exactly
7 days back from `Date.now()`, so every bucket in that alignment is always
complete.

---

## 6. Metrics

| Tab        | Primary stat                  | Secondary (stats row) | Chart       |
| ---------- | ----------------------------- | --------------------- | ----------- |
| Avg Price  | avg list/sold price           | median, std dev       | line + area |
| Volume     | count                         | -                     | bar         |
| DOM        | avg days on market            | median DOM            | line        |
| $/sqft     | avg list_price / tla          | median, std dev       | line        |
| List→Sold% | avg (sold_price / list_price) | count with ratio      | line        |

Stats row always shows: **avg · median · std dev** for the selected metric
across the full visible scope + time window (not per-bucket - the summary of all
data in view).

Delta shown in stats row: current bucket vs previous same-size bucket (e.g. this
week vs last week).

---

## 7. Geofence Overlay (Content Script)

### Injection

`geofence-overlay.ts` runs in ISOLATED world alongside `relay.ts`. On load it:

1. Waits for the Google Maps container to appear in the DOM.
2. Injects a Leaflet `<canvas>` overlay positioned absolutely over the map div
   (z-index above Google Maps tiles, below Google Maps UI controls).
3. Injects the **Draw Zone** button next to Google Maps' zoom controls
   (top-right of map).

Leaflet and Leaflet-Geoman are bundled into the extension (not loaded from CDN -
Chrome Web Store policy requires no remote code execution).

### Drawing UX

- **Idle**: "⬡ Draw Zone" button visible. No overlay active.
- **Drawing**: Button becomes "✕ Cancel". Leaflet-Geoman polygon draw tool
  activates. Map panning is suspended. A ghost line follows the cursor. The
  first vertex shows a close-ring indicator - clicking it closes the polygon.
  Escape also cancels.
- **Zone active**: "⬡ Redraw" + "✕" (clear) buttons. The completed polygon
  renders with a green fill/stroke. Fetched bboxes that intersect the polygon
  are shaded as faint green cells; uncovered portions show faint blue. Pins
  inside the zone get a green ring; pins outside are dimmed to 25% opacity. A
  small badge on the map shows "67% covered · 89 listings".
- **Live editing** (zone active, without clicking Redraw): Vertex handles are
  always draggable on the completed polygon. Dragging two vertices close
  together and releasing collapses the edge between them, removing the shared
  point. Each edge midpoint shows a faint anchor - clicking it inserts a new
  vertex at that position. These edits update the zone filter in the side panel
  immediately (the polygon message is re-sent on every vertex change).
  Leaflet-Geoman's edit mode handles this natively.

### Coordinate Relay

When a polygon is completed, `geofence-overlay.ts` sends:

```
chrome.runtime.sendMessage({ type: 'zone', polygon: [[lat, lng], ...] })
```

The side panel receives this, switches Scope to Zone, and begins filtering.

When the zone is cleared:

```
chrome.runtime.sendMessage({ type: 'zone', polygon: null })
```

Side panel reverts to Session scope.

---

## 8. Side Panel UI

### Header

- **VPAnalytics** logo + listing count badge + live indicator dot (pulses green
  when receiving data).
- **Scope tabs**: Viewport · Session · Zone (coloured: blue / orange / green).
- **Filter badge**: Active / Sold / Any - mirrored from viewpoint's native
  filter. Small note: "clears session on change".
- **Zone coverage block** (visible only when Zone scope active): progress bar,
  coverage %, estimated total, "Pan to fill gaps" hint.

### Controls

- **Window picker**: Daily | Weekly | Monthly tabs.
- **Alignment split button**: "Today" (default) | calendar anchor label ("Mon"
  for weekly, "1st" for monthly). Clicking the calendar side opens a small
  popover to change the anchor day/date.
- **Metric tabs**: Avg Price · Volume · DOM · $/sqft · L→S%.

### Chart Area

- **Stats row**: avg · median · std dev (or relevant summary stats for the
  metric). Delta vs prior period.
- **Primary chart**: line+area (or bar for Volume). 1-year span, scroll/pinch to
  zoom.
- **Volume chart**: always shown below primary chart as a bar chart with same
  x-axis alignment.
- Bucket boundaries shown as faint vertical grid lines. Partial bucket rendered
  with lighter fill.
- "scroll/pinch to pan" hint shown on first load.

### Footer

- **↓ Export CSV**: downloads currently visible bucket data (bucket start date,
  avg, median, count, std dev). No raw listing records.
- **Clear** (or "Clear zone" when Zone scope active).
- Right-aligned: last-updated timestamp or listing count summary.

### Empty State

Shown when no data has been received yet. Prompt: "Browse viewpoint.ca/map to
start collecting data. Listings appear as you pan and filter."

---

## 9. Build System (esbuild)

Single `build.ts` Deno script using esbuild:

- Bundles `src/content/fetch-interceptor.ts` →
  `build/content/fetch-interceptor.js`
- Bundles `src/content/relay.ts` (entry point, imports `geofence-overlay.ts`) →
  `build/content/relay.js`
- Bundles `src/panel/App.tsx` + all components → `build/panel/panel.js`
- Copies `src/panel/index.html` → `build/panel/index.html`
- Copies `manifest.json` → `build/manifest.json`
- Leaflet + Geoman bundled as vendor chunk

**@dano usage:**

- `@dano/styles`: OKLCH design tokens (imported as CSS custom properties in
  `panel/index.html`). Gives the side panel visual consistency with the
  fromaway.ca site.
- `@dano/ui`: Preact components where applicable (layout primitives, tokens).
  Anything generic that emerges from this project is upstreamed to dano later.
- Chart library: **uPlot** - extremely lightweight (~40kb), canvas-based,
  designed for time-series with pan/zoom. Does not use React/Preact internals,
  renders to a canvas element.

---

## 10. Release Pipeline (GitHub Actions)

Extension builds and releases are automated via GitHub Actions (mirrored to
Gitea).

### Build workflow (`.github/workflows/extension-build.yml`)

Triggers on: push to `main` with changes under `extension/`, or manual
`workflow_dispatch`.

Steps:

1. Set up Deno
2. Run `deno run -A extension/build.ts` → produces `extension/build/`
3. Zip `extension/build/` → `viewpoint-analytics-extension-v{version}.zip`
4. On tagged releases (`v*`): create a GitHub Release and attach the zip as a
   release asset
5. Optionally: trigger Chrome Web Store API upload via `chrome-webstore-action`
   (when Web Store credentials are configured as secrets)

### Version

Version is read from `extension/manifest.json` → `version` field. Bump it
manually before tagging.

### Issue tracking

The extension footer links to the GitHub issues page for feedback. A "Report an
issue" link opens
`https://github.com/dafky2000/viewpoint-analytics-extension/issues/new` in a new
tab. Build metadata (extension version) is pre-populated in the issue template.

---

## 11. Compliance & Responsible Use

### ViewPoint ToS Analysis Summary

ViewPoint's ToS is notably permissive compared to most real estate sites - there
is no prohibition on browser extensions, overlays, analytics tools, derivative
works, automated tools, or reverse engineering. The copyright clause is narrow.
However, two clauses require active mitigation:

1. **Professional Use clause:** Users who access the site "in the course of a
   commercial or professional activity" where ViewPoint data "informs or
   contributes to a work product or service" for compensation must contact
   ViewPoint to arrange such use. This includes appraisers, agents, developers,
   analysts.
2. **Fair Use clause:** "Inconsistent with normal usage patterns" - passive
   intercept (no extra requests) keeps this risk minimal.

**Data provenance:** Property data (assessment, boundaries) is owned by the
Province of Nova Scotia. MLS® listing data is licensed from NSAR. Both are
upstream rights holders independent of ViewPoint.

### Tier 1 - Critical (required to ship)

1. **Personal use gate on first run.** Modal on first extension open:
   > "ViewPoint Analytics is for personal real estate exploration only. If you
   > use ViewPoint.ca in the course of commercial or professional work,
   > ViewPoint requires you to contact them directly before using
   > data-augmenting tools. By continuing, you confirm your use is personal and
   > non-commercial." Requires explicit click-through. Stored as a per-install
   > flag (the only item ever written to `chrome.storage.local` - a boolean
   > `eulaAccepted`).

2. **No paid tier, no professional edition, no commercial licence.** Free only.
   Charging users pushes them into the Professional Use clause.

3. **No persistent listing data.** Already in spec - `chrome.storage.*` is not
   used for any listing, property, or analytical data.

4. **Aggregate-only exports with a minimum bucket floor of ≥ 5 listings.**
   Buckets with fewer than 5 listings are suppressed in exports (shown as "< 5"
   in the chart, omitted from CSV). This prevents reverse-engineering individual
   properties from exported data.

5. **No PII or identifying data in exports.** CSV exports contain only: bucket
   date range, avg, median, count, std dev. No listing IDs, addresses, agent
   names, photos, or contact info. Listing IDs are used internally only (for
   deduplication in the in-memory accumulator) and never surface in any exported
   or displayed data.

6. **Strict client-side only.** No telemetry, no error reporting to external
   servers, no analytics on user behaviour. Nothing leaves the user's machine
   except the extension's own GitHub issues link (user-initiated only).

7. **Do not market as an "MLS data tool" or "ViewPoint alternative."**
   Positioning: "Personal analytics for your ViewPoint browsing session." The
   extension augments ViewPoint - users still visit ViewPoint, see ViewPoint's
   UI, and interact with ViewPoint Realty. This framing also matters for Web
   Store review.

### Tier 2 - Strong defensibility

8. **Persistent in-extension disclaimer** (small footer in the side panel,
   always visible):
   > "Processes data your browser receives from ViewPoint.ca for personal use
   > only. Does not store, transmit, or redistribute listing data. Source:
   > ViewPoint.ca - NSAR MLS® System and Province of Nova Scotia."

9. **Attribution in every CSV export** (as a comment row at the top of the
   file):
   > `# Source: ViewPoint.ca (NSAR MLS® System and Province of Nova Scotia). Aggregated [date range]. Personal use only.`

10. **No account sharing, no multi-profile features.** One install, one user,
    one ViewPoint session. The extension has no login of its own.

11. **No additional API requests.** Passive intercept only - already enforced by
    architecture.

12. **No rate-limit evasion, header spoofing, or anti-bot circumvention.** The
    extension does not modify request headers, does not forge user-agent
    strings, and does not alter or replay requests.

13. **Privacy policy** (hosted at a stable URL, linked from Chrome Web Store
    listing and from the extension's About section): Plain-language statement
    that the extension collects no data, stores no data, transmits no data, and
    that all processing is local to the user's browser. One page, simple
    language.

### Compliance Attribution Block

Reproduced wherever data attribution is required (exports, About panel, privacy
policy):

> **Data source:** ViewPoint.ca - listing data licensed from the Nova Scotia
> Association of REALTORS® (NSAR) MLS® System. Property assessment and boundary
> data © Province of Nova Scotia. This tool processes data received during your
> personal ViewPoint.ca browsing session. It does not store, copy, or
> redistribute MLS® data.

---

## 12. What's Explicitly Out of Scope

- **No extra API requests** - the extension never calls viewpoint's API
  directly.
- **No login/auth flow** - extension relies on the user's existing logged-in
  browser session.
- **No persistent storage** - `chrome.storage.*` is not used at all.
- **No raw data export** - CSV export contains only aggregated bucket summaries.
- **No Firefox support** - Chrome MV3 only for now.
- **No background data collection** - extension is passive; nothing happens when
  the side panel is closed.
- **No settings page** - the alignment anchor override lives in the panel UI
  itself.
