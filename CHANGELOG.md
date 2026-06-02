# Changelog

All notable changes to SeeLevel are documented here.

## [v0.1.1] - 2026-05-28

### Fixed

- **Panel data no longer disappears at idle** — Chrome's MV3 service worker is
  terminated after ~30 seconds of inactivity. On restart, the relay and panel
  ports both reconnect with ~1 s backoff. If the panel reconnected first, the
  subsequent relay reconnect triggered a `tab_loaded` message that wiped the
  panel's in-memory session — the same signal used for genuine page navigation.
  The relay now connects as `"relay-reconnect"` when its content-script context
  holds live session data, and the service worker skips the `tab_loaded` reset
  for that name. The relay session maps are also no longer cleared on
  `panel_opened`, since on a genuine new page load they are always empty anyway
  (new content-script context), and on SW-restart reconnects clearing them
  discarded live data the panel still needed.

## [v0.1.0] - 2026-05-25

Initial release. SeeLevel is a Chrome MV3 side-panel extension that turns the
ViewPoint.ca listings you browse into price, volume, days-on-market,
list-to-sold and price-per-sqft trends - a clear, calm read on the Nova Scotia
market. Personal, non-commercial use only.

### Features

- **Side panel UI** - Five metric sections stacked in one scrolling view: Price,
  Volume, Days on Market, Price/sqft, and List to Sold percentage. Each section
  has headline stats (average, median, standard deviation), an Active vs Sold
  split, and a uPlot time-series chart with hover tooltips. Window picker
  switches between Weekly, Monthly, and Yearly buckets.
- **Three scopes** - Viewport (what is on screen right now), Session (everything
  browsed since the last ViewPoint mode switch), and Zone (only listings inside
  a polygon drawn on the map).
- **Geofence drawing** - A polygon tool is injected onto ViewPoint's Google Maps
  view via a Leaflet + Geoman overlay. Draw, redraw, edit vertices live, and
  clear. Every metric filters down to listings inside the shape.
- **Zone coverage indicator** - A progress bar shows how much of the drawn zone
  has actually been fetched, so the numbers are never silently extrapolated past
  what was loaded.
- **CSV export** - Aggregated buckets only, never raw rows. A
  less-than-five-listing floor suppresses small buckets, and every export
  carries a ViewPoint / NSAR / Province of Nova Scotia attribution header.
- **Per-tab state** - Two ViewPoint tabs do not cross-pollute; each tab has its
  own session, zone, scope, and metric/window settings. Opening the panel
  triggers a clean repopulate from the current page state, so the panel never
  shows stale buffered data.
- **Per-session EULA acknowledgement** - A short modal states the personal-use
  scope clearly and points professional users to ViewPoint; the user
  acknowledges per panel open. Nothing is persisted. A permanent disclaimer at
  the bottom of the panel links to the public source and a pre-filled issue
  reporter.

### Privacy and ViewPoint posture

- **Passive observer only** - The extension never issues XHR or fetch requests
  to ViewPoint endpoints. Every byte it processes is one the browser was already
  going to fetch as part of normal browsing.
- **Nothing is persisted, full stop** - The extension does not use
  `chrome.storage` at all. The EULA acknowledgement is per-session React state;
  listing and analytical data live in Preact memory and are gone when the panel
  is closed.
- **Read-only XHR observation** - `XMLHttpRequest.prototype.open` and `send` are
  wrapped; arguments are forwarded verbatim, and the patches are wrapped in
  try/catch so a bug here can never block or modify a request. Patched functions
  mask `name`, `length`, and `toString` to mirror their native originals.
- **Non-success responses are dropped** - The HTTP 400 "too many results" error
  returned for over-zoomed maps is never treated as listings, so its bbox cannot
  falsely count toward zone coverage.
- **No telemetry** - Nothing leaves the user's machine. No analytics, no error
  reporting, no remote logging. The only outbound link is the user-initiated
  "Report an issue" footer button.
- **Minimal manifest permissions** - exactly `["sidePanel"]`. No
  `host_permissions` key, no `activeTab`, no `storage`, no `tabs`, no
  `scripting`, no `webRequest`, no `cookies`, no `<all_urls>`. Access to
  viewpoint.ca is granted by `content_scripts.matches`, which gives the same
  install-time UX as `host_permissions` would without tripping Chrome Web
  Store's "Limited Host Use" in-depth review.

### Under the Hood

- **Four execution contexts, port-brokered** - A MAIN-world fetch interceptor,
  an ISOLATED-world relay that owns the geofence overlay, an MV3 background
  service worker that brokers messages, and the Preact side panel. Every
  cross-context message rides one of two long-lived `chrome.runtime.connect`
  ports (`"relay"`, one per tab, and `"panel"`, one global) routed through the
  SW by tab id. Both sides reconnect on SW termination with 1s → 30s exponential
  backoff; backoff only resets when an inbound message proves the port is
  bidirectionally working. Data flows in one direction throughout.
- **Google Maps constructor patch** - The only stable way to obtain a Map
  instance to attach `idle` / `bounds_changed` / `zoom_changed` listeners to,
  with a DOM-scan fallback for the race where ViewPoint constructs the map
  before the patch lands.
- **Drag-only mid-pan sync** - The Leaflet overlay re-syncs via
  `requestAnimationFrame` while the user drags, and hides on zoom until Google
  fires `idle`. The side panel only re-aggregates on settled bounds, not during
  mid-drag frames.
- **Session as buffered upsert by id** - Revisiting a listing refreshes it
  instead of duplicating it; the session resets only on a ViewPoint mode switch
  (NEW TODAY, TOP LISTINGS, or a search submission).
- **NEW TODAY localStorage mirror** - ViewPoint hydrates the New Today sidebar
  from `localStorage["vp.new_today"]` and only XHRs deltas. The relay reads the
  cache directly (a content script shares the page's localStorage with no extra
  permission), gated on New Today being the active sidebar mode.
- **Deno + esbuild toolchain** - No Node, no package-lock churn; the same npm
  specifiers resolve at build, typecheck, and test time. A custom esbuild plugin
  loads npm CSS dependencies (Leaflet, Geoman) directly from the Deno npm cache.
- **Pure-function test surface** - Aggregation, bucketing, coverage, geofence
  math, and the parse layer are pure functions under `src/panel/lib/` with unit
  tests via `jsr:@std/assert`.
- **Tag-driven release workflow** - A GitHub Action validates that the pushed
  git tag matches `manifest.json`'s `version` field, runs tests, builds with
  `--package`, extracts the matching section from `CHANGELOG.md`, and publishes
  the zip as a GitHub Release. Eliminates the "tagged but forgot to bump" and
  "shipped but forgot to write notes" failure modes.

### Brand

- **Wordplay name** - View to See, Point to Level. The mark is a sun setting at
  a sea horizon on a dark badge; the waterline is the level (a reference line),
  and the filled sea doubles as an analytics area chart.
- **OKLCH palette** - Navy sky, teal sea, amber sun. The List series renders
  teal, the Sold series renders amber.
- **Voice** - Clear, calm, factual. Sentence case throughout, no hype words, no
  exclamation marks, no ALL-CAPS. Describe the tool; let the data speak.
