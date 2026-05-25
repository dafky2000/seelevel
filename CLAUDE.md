# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**SeeLevel** - a Chrome MV3 extension (Deno + esbuild + Preact) that passively
overlays real-estate analytics on top of `viewpoint.ca`. It reads the listing
data the user's browser already receives, computes rolling-window aggregates
(price, volume, DOM, $/sqft, list→sold %), and renders charts in a Side Panel.
A polygon "zone" tool is injected onto the ViewPoint map (Leaflet + Geoman).

The canonical product spec lives at
`docs/superpowers/specs/2026-05-14-viewpoint-analytics-extension-design.md` -
read it for any non-trivial change. The permissions-minimization design
that produced the current port-broker topology and the per-session EULA
is at `docs/superpowers/specs/2026-05-26-permissions-minimization-design.md`.
`README.md` is the user-facing overview; `BRAND.md` defines voice and the
OKLCH palette (tokens are in `src/panel/panel.css`).

## Commands

```bash
deno task -c deno.json   # (no tasks defined - run scripts directly)

deno run -A build.ts              # dev build → build/ with inline sourcemaps
deno run -A build.ts --prod       # production build (minified, no sourcemaps)
deno run -A build.ts --package    # production + zip → seelevel-<version>.zip

deno test -A src/                                    # full suite
deno test -A src/panel/lib/__tests__/aggregate.test.ts   # one file
deno test -A --filter "bucket boundaries" src/       # by test name

deno fmt && deno lint            # built-in formatter/linter (not biome here)
```

Load the unpacked extension from `build/` in `chrome://extensions` (Developer
mode → Load unpacked). The `--package` zip is what gets uploaded to the
Chrome Web Store.

## Architecture - four execution contexts, port-brokered

The extension straddles four isolated JS environments. Data flows one way:
ViewPoint → MAIN → ISOLATED → background SW → side panel. All cross-context
messaging is over long-lived `chrome.runtime.connect` ports brokered through
the SW - no `chrome.runtime.sendMessage` broadcasts, no `chrome.tabs.sendMessage`,
no `chrome.runtime.onMessage`. This is why the manifest needs no
`host_permissions`, no `activeTab`, and no `tabs`.

```
ViewPoint page                    Extension
─────────────                     ─────────
                                                            ┌──────────────────────┐
[google.maps.Map] ─── vpa:bbox ──┐                          │ background/sw.ts     │
                                  ▼                          │   (port broker)      │
[XHR /api/v2/...] ── vpa:listings ┤                          │ relayPorts: Map<     │
        ▲                          │                          │   tabId, Port>       │
        │ (no extra requests)      │ CustomEvent on document  │ panelPort: Port|null │
        │                          ▼                          │ routes {tabId,       │
src/content/fetch-interceptor.ts  src/content/relay.ts ──────►│  payload} envelopes  │
   MAIN world                       ISOLATED world            └──────────┬───────────┘
   patches XHR + Maps ctor,         opens 1 port ("relay")               │ port "panel"
   emits CustomEvents               panel_opened → wipe + re-emit        ▼
                                                            ┌──────────────────┐
                                                            │ src/panel/App.tsx│
                                                            │ Preact side panel│
                                                            │ per-tab TabStore │
                                                            └──────────────────┘
```

- **`src/content/fetch-interceptor.ts` (MAIN world)** - no `chrome.*` access.
  Patches `XMLHttpRequest.prototype.open/send` and the `google.maps.Map`
  constructor. Emits `CustomEvent("vpa:listings" | "vpa:bbox" | "vpa:mapbusy")`
  on `document`. **All patches are masked to look native** (`maskAsNative`)
  and wrapped in try/catch so we can never block a page request.
- **`src/content/relay.ts` (ISOLATED world)** - bridges CustomEvents → the
  `"relay"` port. Opens its port on load and *observes silently* (buffers
  listings in `sessionListings`/`sessionProperties` Maps) until the SW
  signals `panel_opened`; at that point it wipes the buffer and re-emits
  current `viewport_bbox` and `zone` snapshots, then runs `pollNewTodayCache()`
  synchronously so the panel populates without waiting for the 1.5s tick.
  Detects ViewPoint mode switches (NEW TODAY / TOP_LISTINGS / search submit)
  to clear the session, and polls `localStorage["vp.new_today"]` (NEW TODAY
  is hydrated from cache, not XHR). Owns the geofence overlay - the overlay
  module exposes a `setOnZoneChange(fn)` hook so the overlay never touches
  `chrome.*` directly. On port disconnect (e.g. SW restart) reconnects with
  1s → 30s exponential backoff; backoff only resets when an inbound message
  proves the port is bidirectionally working.
- **`src/background/sw.ts`** - port broker. On a `"relay"` connect, stores
  `port` keyed by `port.sender.tab.id`; if `panelPort` is already set, sends
  `tab_loaded` to the panel (resets that tab's `TabStore`) and `panel_opened`
  to the new relay (in that order - the panel must reset before the relay
  re-emits, or snapshots merge into stale state). On a `"panel"` connect,
  broadcasts `panel_opened` to every relay. Routes `msg` envelopes both
  directions; drops messages silently if the peer port is null. Also opens
  the side panel on action click.
- **`src/panel/App.tsx`** - Preact side panel. Opens one `"panel"` port on
  mount (in a `useRef`-stable handler that reads `activeTabIdRef.current` so
  the port doesn't tear down on tab switches), maintains a `Map<tabId, TabStore>`
  (one independent workspace per ViewPoint tab), and re-runs `aggregate()` on
  every store change. Switches the active store when the user changes tabs.
  Same reconnect-with-backoff pattern as the relay side.

## Key data types & invariants

Everything lives in `src/types.ts`. The state model carries a few subtle
invariants - get these wrong and the UI silently lies:

- **`TabStore.session`** accumulates *every* listing seen since the last
  ViewPoint mode switch *or panel-open*. It is the master list. Pans and new
  searches add to it; a mode switch (`clear_session` from relay) empties it;
  opening the panel triggers SW to broadcast `panel_opened`, which makes the
  relay wipe its buffer and re-emit current snapshots (so a freshly opened
  panel never sees stale state).
- **`TabStore.viewportListings`** is set *only* in search mode (when
  `ListingKind === "search"`) - that result set is already geo-filtered
  server-side and is the verbatim viewport. For global datasets
  (`top_listings`, `new_today`) it is `null` and viewport falls back to
  `session ∩ viewportBbox` (see `scopedListings()` in `src/panel/store.ts`).
- **`searchStatus`** (`active | sold | any`) drives series visibility. An
  explicit "for sale" search hides the sold series; "sold" hides the list
  series. Global datasets (`status: "any"`) show both - never let a global
  batch overwrite the searchStatus.
- **Coordinates** - `ListingRow.lat/lng` always arrives `null` from the
  parser; the side panel joins them in via `resolveCoordinates()` using the
  `pid → PropertyRow` lookup from the same batch. Listings without resolvable
  coordinates are excluded from viewport and zone scopes but kept in session.
- **Zone switching** - receiving a `{ type: "zone", polygon }` message
  switches scope to "zone" *only when a polygon first appears*. The relay
  re-sends the polygon on every listings update; treat re-sends as no-ops or
  the user will be yanked back to the Zone tab while panning.
- **Map bounds** - `viewport_bbox` messages only fire on `settled` (idle), not
  during a drag. This keeps the panel from re-aggregating ~60×/sec.

## Build system specifics

`build.ts` runs four esbuild builds in parallel:

| Entry | Output | Format | Notes |
|---|---|---|---|
| `src/content/fetch-interceptor.ts` | `build/content/fetch-interceptor.js` | `iife` | MAIN world script |
| `src/content/relay.ts` | `build/content/relay.js` | `iife` | ISOLATED world; bundles geofence-overlay |
| `src/background/sw.ts` | `build/background/sw.js` | `esm` | service worker |
| `src/panel/App.tsx` | `build/panel/panel.js` | `iife` | Preact, JSX automatic |

Static files (`panel/index.html`, `panel/panel.css`, icons, manifest) are
copied. The build defines `__EXT_VERSION__` from `manifest.json` for the
panel bundle.

**Custom `npmCssPlugin`** - `deno-loader` intercepts `npm:` specifiers before
esbuild's `loader: { ".css": "text" }` runs, so we resolve npm CSS imports
(e.g. `leaflet/dist/leaflet.css`) by walking the Deno npm cache directly.
If you add a new npm dep that ships CSS, this plugin will pick it up
automatically - but it requires the package to be cached (run a dev build
once after any `deno.json` change).

## Compliance constraints (these are load-bearing)

These constraints exist for legal/Web Store reasons. Don't relax them:

- **No extra API requests.** The extension only observes XHRs ViewPoint
  already makes. Never call `fetch()` to a viewpoint endpoint from extension
  code.
- **Nothing is persisted, full stop.** Zero `chrome.storage` usage. The EULA
  is acknowledged per panel-mount via plain `useState`. Listing/analytical
  data lives in Preact memory only.
- **CSV export is aggregate-only**, with a `< 5 listings` bucket floor and
  an attribution header row. Never export raw listing records.
- **Manifest permissions are exactly `["sidePanel"]`.** No `host_permissions`,
  no `activeTab`, no `storage`, no `tabs`, no `scripting`, no `webRequest`,
  no `cookies`. Access to viewpoint.ca is granted by `content_scripts.matches`,
  which is the same install-time UX as `host_permissions` but doesn't trigger
  the Web Store's "Limited Host Use" in-depth review. Don't add anything to
  the permissions list - each addition expands the Web Store review surface.
- **EULA gate** (`EulaGate.tsx`) must clear on every panel mount before
  anything else renders. Two short paragraphs + one button; the user
  re-acknowledges per session. The persistent GitHub link stays in
  `Disclaimer.tsx`, not the gate.

## Voice (for any user-facing copy)

See `BRAND.md`. Short version: clear, calm, factual; sentence case; no hype
words (*powerful, unlock, supercharge, effortless*), no exclamation marks,
no ALL-CAPS. Describe the tool; let the data speak. The accent colour is
`var(--color-accent)` (teal), the secondary is `var(--color-sun)` (amber) -
List series uses teal, Sold series uses amber.

## Testing

Tests live alongside source as `src/panel/lib/__tests__/*.test.ts` and use
`jsr:@std/assert`. Only the pure `lib/` modules (aggregate, bucket,
coverage, geofence, parse) are unit-tested; the content scripts and Preact
components have no automated tests. When touching aggregation, bucketing,
geofence math, or the parse layer, **add or update a test in
`__tests__/`** - these modules are deliberately pure so they can be tested
without Chrome APIs or DOM.
