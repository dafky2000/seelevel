# Engel & Völkers Adapter Design Spec

**Date:** 2026-05-29 **Status:** Draft **Target:** Add a second host-site
adapter (`engelvoelkersnovascotia.com`) to SeeLevel, reusing the existing
aggregator / panel / SW broker. Introduces one extension-initiated network
request per viewport-settle (slim, page-context-fired, no new permissions) and a
new `oversize` state for viewports whose result set exceeds 2,000 listings.

---

## 1. Overview

SeeLevel currently ships one adapter targeting `viewpoint.ca`. This spec adds a
parallel adapter for `engelvoelkersnovascotia.com/map`, structured to mirror the
existing ViewPoint split (MAIN-world fetch-interceptor + ISOLATED-world relay)
and to reuse the SW broker, the panel app, the aggregator, and the per-tab
`TabStore` model unchanged.

Two meaningful differences from ViewPoint:

1. **Active network behavior.** EV's `get-listing` UI feed is paginated at
   `limit:10`, so pure passive observation would force the user to scroll dozens
   of pages per viewport to populate aggregates. The EV adapter therefore fires
   one slim sibling `get-listing` per viewport-settle, from page context,
   copying the bbox + filters from the page's own `get-ev-listing` POST. Slim
   projection (10 fields, ~460 B/row), capped at `limit:2001`, dedup'd,
   at-most-one-in-flight. No new manifest permissions.
2. **Oversize state.** If the server's reported count for the current bbox
   exceeds 2,000, the slim sibling discards the partial response and emits an
   `oversize` signal. The panel shows a block-style notice in viewport scope (no
   metrics) and a non-disruptive badge in session/zone scope (existing data
   continues to render). The bbox is not added to `fetchedBboxes`, so zone
   coverage stays accurate.

**Shared with ViewPoint, unchanged:** the underlying map runtime is
`google.maps.Map` on both sites (ViewPoint also embeds Google Maps under the
hood; the existing `fetch-interceptor.ts` already patches `google.maps.Map`'s
constructor to capture bounds). The existing `geofence-overlay.ts` —
Leaflet+Geoman rendered as a transparent overlay on top of the Google Maps
canvas — works for EV unchanged. One drawing implementation, one contract, both
adapters.

This spec also includes two precursor changes done as part of the same PR:

- **Rename** the legacy `vpa` / `vpa-` / `vpa:` identifiers (CSS classes,
  CustomEvent names, internal window flag) to `seelevel` / `seelevel-` /
  `seelevel:`. Mechanical, no behavior change.
- **Update** `2026-05-26-permissions-minimization-design.md` to reflect the
  per-adapter compliance posture (ViewPoint = pure passive; EV = one slim
  sibling per viewport-settle).

## 2. Goals & Non-Goals

**Goals**

- Ship a working SeeLevel experience on `engelvoelkersnovascotia.com/map` with
  metric parity to ViewPoint: price, volume, DOM (proxy), $/sqft, list→sold %
  across viewport / session / zone scopes.
- Behave correctly logged-out (active inventory + sparse pending-sold pool) and
  logged-in (additionally unlocks actually-closed deals with populated
  `ClosedPrice`).
- Add **zero** new manifest permissions; only `content_scripts.matches` gains
  one entry.
- Preserve every existing ViewPoint behavior unchanged.

**Non-Goals**

- Re-architect the SW broker, panel app, aggregator, or per-tab `TabStore`
  model.
- Introduce a second drawing implementation. The existing Leaflet+Geoman overlay
  (already shipped with the extension for ViewPoint) is reused on EV unchanged —
  same module, same code, instantiated against EV's `google.maps.Map` instance.
- Replace the existing aggregate-only CSV export. EV rows flow through the same
  export with no changes.
- Add any persistence. The session-only memory model is preserved.

## 3. Architecture & File Layout

The EV adapter is a parallel content-script set for
`engelvoelkersnovascotia.com`. The SW (`sw.ts`) and the panel app remain
site-agnostic — both adapters emit the same `ContentToPanel` payload shapes.

```
src/
  background/sw.ts                       (unchanged — site-agnostic broker)
  content/
    fetch-interceptor.ts                 (unchanged — ViewPoint MAIN-world)
    relay.ts                             (unchanged — ViewPoint ISOLATED)
    geofence-overlay.ts                  (unchanged — Leaflet+Geoman overlay;
                                          reused by EV relay verbatim)
    ev/                                  ← NEW
      main.ts                            MAIN-world entry; wires up:
                                          – the google.maps.Map constructor patch
                                            (factored out of the ViewPoint interceptor
                                            into a shared module — see § 3.1)
                                          – XHR observation for the get-ev-listing trigger
                                          – the slim sibling fetcher
      sibling-fetch.ts                   pure-ish: build the slim payload, fire, parse,
                                          dispatch the appropriate CustomEvent. State
                                          (dedup, in-flight, last-filter) module-scoped.
      parse.ts                           pure RESO row → ListingRow mapping (tested)
      relay.ts                           ISOLATED entry; opens the "relay" port, listens
                                          for seelevel:* CustomEvents from MAIN, instantiates
                                          the shared geofence-overlay against the page's
                                          google.maps.Map (same as ViewPoint relay does)
      __tests__/parse.test.ts            unit tests for the field mapping
  panel/
    App.tsx                              (modified — oversize render branches, spinner)
    store.ts                             (modified — reducer handles new payloads)
    components/
      OversizeNotice.tsx                 ← NEW (block / badge modes)
      Spinner.tsx                        ← NEW (loading state)
      (others unchanged in behavior; vpa- → seelevel- in CSS classes only)
  types.ts                               (modified — new payloads, TabStore fields, EVT const)

manifest.json                            +1 content_scripts entry, no new permissions
build.ts                                 +2 esbuild entries (ev/main, ev/relay)
panel/panel.css                          mechanical vpa- → seelevel- rename across all selectors
```

**Manifest delta in full:**

```jsonc
"content_scripts": [
  { /* existing ViewPoint entry, unchanged */ },
  {
    "matches": ["https://engelvoelkersnovascotia.com/*"],
    "js": ["content/ev/main.js"],
    "world": "MAIN",
    "run_at": "document_start"
  },
  {
    "matches": ["https://engelvoelkersnovascotia.com/*"],
    "js": ["content/ev/relay.js"],
    "world": "ISOLATED",
    "run_at": "document_start"
  }
]
```

`permissions` stays `["sidePanel"]`. `host_permissions` is still absent.

### 3.1 Shared `google.maps.Map` constructor patch

Both adapters need the same patch (intercept `window.google` assignment, wrap
`google.maps.Map`, fire `idle` / `bounds_changed` listeners on every constructed
instance, dispatch `seelevel:bbox` / `seelevel:mapbusy` CustomEvents). The
current implementation lives inline in `src/content/fetch-interceptor.ts`.
Factor it out into `src/content/shared/google-maps-hook.ts` (MAIN-world, no
imports of chrome APIs, no adapter-specific code) and import it from both
`src/content/fetch-interceptor.ts` and `src/content/ev/main.ts`. Mechanical
extract — no behavior change.

## 4. Slim Sibling Fetch

### Trigger

Every observed POST to
`https://dev-api.engelvoelkersnovascotia.com/api/v1/property/get-ev-listing`.
The EV page fires this on every map-settle and on every filter change — it's the
page's own debounced viewport signal. We piggyback for free.

### Request

```jsonc
POST https://dev-api.engelvoelkersnovascotia.com/api/v1/property/get-listing
Headers:
  content-type: application/json
  authorization: Bearer <localStorage.authToken>   // omitted if absent
Body:
{
  "limit": 2001,
  "skip": 0,
  "sortBy": "ModificationTimestamp",
  "sortOrder": "desc",
  "fields": "id,MlsStatus,StandardStatus,ListPrice,ClosedPrice,ListingContractDate,ModificationTimestamp,BuildingAreaTotal,Latitude,Longitude",
  "filters": <copied verbatim from the observed get-ev-listing body, includes boundingBox>
}
```

`limit:2001` because we want to detect "exactly at threshold" vs "over
threshold" with one round-trip. `sortBy: ModificationTimestamp desc` biases
toward the most recently transacted rows and surfaces actually-closed records
when the request is authenticated.

### Response handling

- HTTP 200, `data.mlsPropertyResult.count > 2000` → dispatch
  `seelevel:oversize`. Discard rows. Do not update session.
- HTTP 200, `count ≤ 2000` → parse rows via `ev/parse.ts`. Dispatch
  `seelevel:listings` with `kind: "search"`, `bbox: <bbox>`, status derived from
  `filters.MlsStatus`.
- Anything else (network error, 401, 4xx, 5xx, malformed JSON) → silently
  swallow. `console.warn` once per session on contract drift.

### State (module-scoped in `sibling-fetch.ts`)

```ts
let lastFiredKey: string | null = null; // JSON.stringify({bbox, filters}); dedup
let lastFilterKey: string | null = null; // JSON.stringify(filters - bbox); change → clear_session
let inFlight: boolean = false; // at-most-one-in-flight
```

If a trigger arrives with `lastFiredKey === <new key>` → skip. If
`inFlight === true` → skip (next page fire retriggers). If `lastFilterKey`
changed → dispatch `seelevel:clear-session` before firing.

### Login-state behavior

The API has **no auth enforcement** on `get-listing`. The slim sibling fires
regardless of login state. Effect of `authToken` presence:

| State      | Active inventory | Pending-sold (under contract)       | Actually-closed (with `ClosedPrice`)     |
| ---------- | ---------------- | ----------------------------------- | ---------------------------------------- |
| Logged out | Full             | Full (sparse `ClosedPrice` — ~1–4%) | Empty (auth-gated via `CloseDate` sort)  |
| Logged in  | Full             | Full (sparse `ClosedPrice`)         | Full (100% `ClosedPrice` on closed rows) |

The user's choice of filter on the EV page is the gate that matters in practice
— the EV UI only exposes the Sold filter to authenticated users. SeeLevel
mirrors whatever filter is active; no login-conditional logic in extension code.

### Field whitelist rationale

The 10 fields requested map 1:1 to what `aggregate.ts` and `store.ts` actually
consume:

| RESO field                     | ListingRow field       | Used by                                                                        |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------------ |
| `id` (UUID)                    | `id`                   | `store.ts` dedup key                                                           |
| `MlsStatus` + `StandardStatus` | `status_id`            | `aggregate.ts:59` (STATUS_SOLD === 2 gate)                                     |
| `ListPrice`                    | `list_price`           | price, ppsf-list, list→sold % numerator                                        |
| `ClosedPrice`                  | `sold_price`           | sold price, ppsf-sold, list→sold % denominator                                 |
| `ListingContractDate`          | `list_dt`              | list-side bucket date                                                          |
| `ModificationTimestamp`        | `sold_dt` / `close_dt` | sold-side bucket date (proxy; `CloseDate` is null on the feed for closed rows) |
| `BuildingAreaTotal`            | `tla`                  | ppsf denominator                                                               |
| `Latitude`                     | `lat`                  | viewport + zone scope geo-filter                                               |
| `Longitude`                    | `lng`                  | viewport + zone scope geo-filter                                               |

The server **always** appends four extra fields no matter what (`createdAt`,
`FirstMedia`, `ListingId`, `OpenHouse`); we ignore the first three and route
`ListingId` into the unused `listing_id` field for free MLS-number export.

### Measured cost per request

| Scenario                                       | Bytes/row | Total              | Wall time |
| ---------------------------------------------- | --------- | ------------------ | --------- |
| Halifax bbox SOLD residential (~2,500 rows)    | ~460      | ~1.1 MB            | ~0.5 s    |
| Province-wide SOLD residential (count ~14,000) | n/a       | oversize → discard | n/a       |
| Typical neighborhood viewport (<500 rows)      | ~460      | <0.25 MB           | <0.5 s    |

### Parse mapping (`ev/parse.ts`)

```ts
export function parseEvListing(raw: Record<string, unknown>): ListingRow {
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const status_id = (() => {
    if (raw.MlsStatus === "ACTIVE") return 1;
    if (raw.MlsStatus === "SOLD" && raw.StandardStatus === "Closed") return 2;
    if (raw.MlsStatus === "SOLD") return 6; // pending / under contract
    return 0;
  })();
  const isClosed = raw.StandardStatus === "Closed";
  return {
    id: String(raw.id ?? ""),
    listing_id: String(raw.ListingId ?? ""), // server-tacked; free bonus
    class_id: 0, // vestigial — type-compat with ViewPoint
    status_id,
    list_price: num(raw.ListPrice),
    sold_price: num(raw.ClosedPrice),
    list_dt: typeof raw.ListingContractDate === "string"
      ? raw.ListingContractDate
      : null,
    sold_dt: isClosed && typeof raw.ModificationTimestamp === "string"
      ? raw.ModificationTimestamp
      : null,
    close_dt: isClosed && typeof raw.ModificationTimestamp === "string"
      ? raw.ModificationTimestamp
      : null,
    tla: num(raw.BuildingAreaTotal),
    pid: null, // lat/lng arrive on the row directly
    lat: num(raw.Latitude),
    lng: num(raw.Longitude),
  };
}
```

The companion `properties: PropertyRow[]` field on the listings payload is
always `[]` for EV — no `pid → coord` join needed.

## 5. Data Flow

### Wire protocol additions

`ContentToPanel` gains two variants:

```ts
| { type: "oversize_bbox"; bbox: BBox; count: number }
| { type: "loading_state"; loading: boolean }
```

`TabStore` gains three fields:

```ts
oversizeBbox: BBox | null;
oversizeCount: number | null;
loading: boolean;
```

Initial values in `defaultTabStore`: `null`, `null`, `false`.

### Reducer behavior (in `App.tsx`'s `onMessage`)

| Payload                     | Effect                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"listings"` (any kind)     | Standard merge into `session`. If `kind === "search"` AND `bbox !== null`: set `viewportListings`, push to `fetchedBboxes`. Always clear `oversizeBbox`, `oversizeCount`, `loading`.                                                                                                                                                                                                                      |
| `"oversize_bbox"`           | `oversizeBbox = bbox; oversizeCount = count; viewportListings = null; loading = false`. Does **not** touch `session`, `fetchedBboxes`. Clearing `viewportListings` is important — without it the stale verbatim rows from the prior smaller bbox would still satisfy `scopedListings()` in viewport scope, mis-counting the header chip even though the OversizeNotice block correctly hides the metrics. |
| `"loading_state"`           | `loading = payload.loading`.                                                                                                                                                                                                                                                                                                                                                                              |
| `"clear_session"`           | Clear `session`, `viewportListings`, `fetchedBboxes`, `oversizeBbox`, `oversizeCount`, `searchStatus`. `polygon`, `viewportBbox`, `loading` persist.                                                                                                                                                                                                                                                      |
| `"zone"`, `"viewport_bbox"` | Unchanged behavior.                                                                                                                                                                                                                                                                                                                                                                                       |

### Key invariants

- A `"listings"` payload with `bbox !== null` AND `kind === "search"` is the
  **only** input that grows `fetchedBboxes`. Page-observed partial payloads (if
  we ever add passive observation later) would pass `bbox: null` and would not
  grow coverage.
- A successful `"listings"` payload **supersedes** any prior oversize state for
  the same scope. Without this, panning from a wide oversize bbox back to a
  narrow fitted bbox would leave the badge stuck.
- `loading` is binary, derived solely from the slim sibling lifecycle. It does
  not block existing data from rendering — only fills the empty-scope hole.

### Render precedence (App.tsx body)

```
if (scope === "viewport" && oversizeBbox)  → <OversizeNotice mode="block" count={oversizeCount} />
else if (scope === "zone" && !polygon)     → existing "Draw a zone" prompt
else if (listingCount === 0 && loading)    → <Spinner />                    ← NEW
else if (listingCount === 0)               → <EmptyState />
else                                       → metrics
                                              + <OversizeNotice mode="badge" />
                                                in session/zone if oversizeBbox is set
```

### Header count chip

The existing `{listingCount} listings` chip in the header renders
unconditionally today. With oversize state, **suppress the chip when
`scope === "viewport" && oversizeBbox !== null`** — otherwise it would display
the partial session-intersect-bbox count alongside the OversizeNotice block's
"Too many listings ({3214})" copy, which is confusing. In session/zone scope the
chip continues to render normally next to the oversize badge (showing the real,
accurate scope count).

### Flow walkthroughs

**Page load, logged out:**

1. `ev/main.ts` patches `google.maps.Map` constructor and
   `XMLHttpRequest.{open,send}`.
2. `google.maps.Map` instance is constructed → captured for the geofence
   overlay.
3. `google.maps.Map` fires `idle` → dispatch `seelevel:bbox`. Relay caches;
   forwards when panel opens.
4. Page fires `get-ev-listing` → `sibling-fetch.ts`:
   - `localStorage.authToken` is null. Fire anyway, no auth header.
   - Dispatch `seelevel:loading-state {loading: true}`.
   - Fetch slim sibling. Response: `count: 414`.
   - Parse 414 rows. Dispatch `seelevel:listings`.
   - Dispatch `seelevel:loading-state {loading: false}`.
5. Relay → SW → Panel: session populated, viewportListings set verbatim,
   fetchedBboxes appended.

**Pan to oversize viewport, logged in:**

1. Page fires `get-ev-listing` with the new wide bbox.
2. `sibling-fetch.ts`: filter unchanged. New bbox → fire.
3. Dispatch `seelevel:loading-state {loading: true}`.
4. Slim sibling response: `count: 3214`.
5. Dispatch `seelevel:oversize {bbox, count: 3214}`. Dispatch
   `seelevel:loading-state {loading: false}`.
6. Panel reducer: `oversizeBbox = bbox; oversizeCount = 3214`. Session
   unchanged.
7. **Viewport scope**: `<OversizeNotice mode="block" count={3214} />` replaces
   metrics.
8. **Session scope**: previous session metrics render; header badge "Current
   view too large to record — 3214 skipped".
9. **Zone scope**: same badge; zone coverage % unchanged (no new bbox added).

**Filter change (Active → Sold):**

1. User toggles EV filter; page fires `get-ev-listing` with new
   `filters.MlsStatus`.
2. `sibling-fetch.ts`: `lastFilterKey` changed → dispatch
   `seelevel:clear-session` first.
3. Reducer wipes session, viewportListings, fetchedBboxes, oversize state.
   Polygon and viewportBbox persist.
4. Continue with normal sibling fetch path. Loading state → spinner if scope
   empty during fetch.

**Panel mount mid-fetch:**

1. SW broadcasts `panel_opened` to all relays (existing behavior).
2. EV relay wipes its sessionListings buffer, re-emits the latest known state:
   - `viewport_bbox` (last `seelevel:bbox` event)
   - `oversize_bbox` (if `lastOversize` is set)
   - `loading_state` (`lastLoading`)
   - `zone` (if `lastZone` polygon is set)
3. No re-fetch — next user pan retriggers.

## 6. Zone Drawing UI (EV)

The existing `src/content/geofence-overlay.ts` works for EV unchanged. ViewPoint
and EV both use `google.maps.Map` as their underlying map runtime; SeeLevel's
overlay is a Leaflet+Geoman-backed transparent layer rendered on top of the
Google Maps canvas, bound to the page's `google.maps.Map` instance for
bounds-tracking. The coupling is to Google Maps bounds events (which both sites
have) and to its own DOM overlay element (which both sites can host) — nothing
in the overlay is ViewPoint-specific.

### EV relay wiring

The EV relay (`ev/relay.ts`) imports the same `geofence-overlay` module and
instantiates it the same way the ViewPoint relay does:

```ts
import {
  clearZone,
  mountOverlay,
  setOnZoneChange,
  setPromptActive,
} from "../geofence-overlay.ts";

setOnZoneChange((polygon) => {
  port.postMessage({ type: "msg", payload: { type: "zone", polygon } });
});
// mountOverlay() runs once the shared google-maps-hook reports a Map instance,
// same trigger as in the ViewPoint relay.
```

Panel→overlay messages (`zone_prompt`, `clear_zone`) call into the overlay's
existing `setPromptActive(active)` and `clearZone()` functions exactly as
ViewPoint does. No new cross-context CustomEvents are required for the drawing
UI — the overlay lives in the ISOLATED relay alongside the wiring code, no
MAIN↔ISOLATED hop.

### Why this works on both sites

| Layer                    | ViewPoint                                          | EV                |
| ------------------------ | -------------------------------------------------- | ----------------- |
| Underlying map           | `google.maps.Map`                                  | `google.maps.Map` |
| SeeLevel-shipped overlay | Leaflet (own instance) + Geoman, transparent layer | Identical         |
| Overlay binding          | Page's `google.maps.Map` bounds events             | Identical         |
| Draw button              | DOM button in overlay container                    | Identical         |
| Polygon vertex shape     | `[[lat, lng], …]`                                  | Identical         |
| Panel→overlay protocol   | `zone_prompt`, `clear_zone` port payloads          | Identical         |
| Overlay→panel protocol   | `{type: "zone", polygon}` port payload             | Identical         |

One drawing implementation, two adapters, zero duplicated logic. The only
adapter-specific code path is the relay's choice of which CustomEvent stream to
listen to for data — the overlay code, the visual style, and the user
interaction model are shared.

### Visual style

Per `BRAND.md`: sentence case ("Draw zone", "Clear zone"), no emoji except ⬡,
accent color `var(--color-accent)`. Pulse animation uses
`@keyframes seelevel-zone-pulse` (renamed from `vpa-zone-pulse` via the
precursor). No EV-specific styling.

## 7. OversizeNotice & Spinner Components

### `src/panel/components/OversizeNotice.tsx`

Single component, two render modes selected by `mode` prop:

- `mode="block"` — used in viewport scope when `oversizeBbox` is set. Replaces
  metrics area, follows the visual layout of `EmptyState`: centered icon (⊘ or
  similar), explanatory text "Too many listings in view ({count}) to compute
  statistics. Zoom in or narrow your filter to see analytics."
- `mode="badge"` — used in session/zone scope when `oversizeBbox` is set. Small
  inline badge in the header row next to the existing count chip. Text: "Current
  view too large to record — {count} skipped". Non-disruptive; existing metrics
  render normally below.

### `src/panel/components/Spinner.tsx`

Small component, single render. Used only when `listingCount === 0 && loading`.
Centered in the same vertical space `EmptyState` uses. Border-based CSS spinner
(no library), accent-teal, caption "Fetching listings…". No emoji.

## 8. Error Handling

The fetch-interceptor runs in MAIN world (page context). Errors there can break
the page's own JS — every patch and every fetch is `try/catch`-wrapped, never
re-thrown.

| Outcome                                           | Cause                                       | Behavior                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Network error (DNS, abort, reset)                 | User offline, page navigation mid-fetch     | Swallow. No event. Next pan retriggers.                                                                                                                                                                                                                      |
| HTTP 401                                          | JWT expired                                 | Swallow. Page's own XHR will likely 401 too and redirect to login.                                                                                                                                                                                           |
| HTTP 400 ("Limit should be less than 6000")       | Should not happen (our limit is 2001)       | Swallow, `console.warn` once, no user surface.                                                                                                                                                                                                               |
| HTTP 5xx                                          | EV backend hiccup                           | Swallow. No automatic retry.                                                                                                                                                                                                                                 |
| Malformed JSON / missing `data.mlsPropertyResult` | API contract drift                          | Swallow, `console.warn` once.                                                                                                                                                                                                                                |
| `count === 0`, rows empty                         | Filter excludes everything in this viewport | Emit `seelevel:listings` with empty `rows` array, `bbox` set, `kind: "search"`. Reducer clears oversize and appends the bbox to `fetchedBboxes` — the bbox is fully "covered" (we asked, the server returned zero rows). Zone coverage % advances correctly. |

### Race conditions

- **Rapid pan:** dedup + at-most-one-in-flight ⇒ at most one slim sibling per
  page settle. Newer triggers dropped during in-flight; next page-fired
  `get-ev-listing` retriggers with current state.
- **Out-of-order responses:** impossible with at-most-one-in-flight.
- **Page navigation mid-fetch:** `try/catch` swallows; CustomEvents fired on a
  torn-down document are silently ignored.
- **SW restart during loading:** relay re-emits `lastLoading` on reconnect. If
  the in-flight fetch eventually resolves in MAIN, the `loading: false` event
  flows through the reconnected relay. If not, next pan self-heals.
- **Token storage corruption:** `localStorage.getItem("authToken")` returns
  string-or-null. Garbage value → 401 → swallowed.

### Deliberate non-features

- **No retries.** Retries amplify hiccups. Next pan retriggers organically.
- **No proactive token refresh.** EV's page owns its own auth lifecycle.
- **No fetch timeout.** A hung fetch holds the `inFlight` slot until resolve or
  page abort. Acceptable.
- **No diagnostic UI.** Panel surface for errors is exactly: the oversize
  notice. That's it.

## 9. Testing

Per the existing convention (`CLAUDE.md`): only pure `lib/`-style modules are
unit-tested. The EV adapter follows suit.

### `src/content/ev/__tests__/parse.test.ts`

Cases:

| Case                                                              | Asserts                                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Active row                                                        | `status_id === 1`, `list_price === Number(ListPrice)`, `sold_price === null`, `sold_dt === null`, `lat`/`lng` populated |
| Closed sold (`StandardStatus: "Closed"`, `ClosedPrice: "300000"`) | `status_id === 2`, `sold_price === 300000`, `sold_dt === ModificationTimestamp`                                         |
| Pending sold (`MlsStatus: "SOLD"`, `StandardStatus !== "Closed"`) | `status_id === 6`, `sold_price === null`                                                                                |
| Closed sold with `ClosedPrice: null` (logged-out edge case)       | `status_id === 2`, `sold_price === null`                                                                                |
| Empty-string fields                                               | `Number("")` paths coerce to `null`, never `NaN`                                                                        |
| `ListPrice` as string                                             | Coerces to number                                                                                                       |
| `BuildingAreaTotal: null`                                         | `tla === null`                                                                                                          |
| Server-tacked fields (`createdAt`, `FirstMedia`, `OpenHouse`)     | Don't appear in output; `ListingId` flows into `listing_id`                                                             |

### Not unit-tested

- `ev/main.ts`, `ev/sibling-fetch.ts`, `ev/relay.ts`,
  `shared/google-maps-hook.ts` — need real `XMLHttpRequest`, `google.maps`,
  `chrome.runtime`, DOM. Same as the existing ViewPoint interceptor.
- `OversizeNotice.tsx`, `Spinner.tsx` — pure render, no logic.
- Reducer arms in `App.tsx` — embedded in `onMessage` closure. Same as today.
- `geofence-overlay.ts` — unchanged from today; already not tested.

### Manual verification checklist

1. Logged out on `/map` — active inventory metrics render after first pan;
   sold-side sparse (expected).
2. Log in, select Sold filter — slim sibling attaches auth header;
   `ClosedPrice`-populated rows flow in; metrics update.
3. Zoom out to count > 2000 — `OversizeNotice` block in viewport scope; badge in
   session/zone; existing data renders below the badge.
4. Zoom back in — oversize state clears, metrics return.
5. Pan rapidly across 10 viewports — at most one slim sibling in flight at any
   time.
6. Open panel mid-fetch — spinner shows, resolves to metrics.
7. Switch the side panel between an EV tab and a ViewPoint tab — per-tab
   `TabStore` (including new oversize/loading fields) stays isolated.
8. Reload the SW via `chrome://extensions` while panel is open — auto-reconnect,
   state catches up after next pan.
9. Network panel: confirm exactly one extra request (slim `get-listing`) per
   viewport settle, no extras during in-flight throttling.
10. Draw a zone on the EV map — polygon completes, zone scope filters session
    accordingly.
11. "Clear zone" button removes polygon, zone scope falls back appropriately.
12. Pulse the draw button by switching to Zone tab with no polygon — confirms
    `zone_prompt` cross-context plumbing.

## 10. Precursor: `vpa` → `seelevel` Rename

Mechanical rename of 144 occurrences across 14 files, **zero behavior change**,
executed as the opening commits of the EV adapter PR so all new EV files are
built using the canonical names.

### Three categories

**CustomEvent name protocol (wire contract):**

| Old            | New                 |
| -------------- | ------------------- |
| `vpa:listings` | `seelevel:listings` |
| `vpa:bbox`     | `seelevel:bbox`     |
| `vpa:mapbusy`  | `seelevel:mapbusy`  |

Plus the three new events introduced by this spec join the same namespace (no
`:ev:` infix):

```
seelevel:oversize
seelevel:clear-session
seelevel:loading-state
```

(The zone-drawing UI does not need new CustomEvents — overlay lives in the
ISOLATED relay alongside the wiring code; see § 6.)

**CSS class names — mechanical `vpa-` → `seelevel-`** across all ~60 distinct
classes and the one ID selector (`#vpa-leaflet-css`). Affects
`src/panel/panel.css` and every `.tsx` in `src/panel/components/`.

**Window flag:** `window.vpa_hooked` → `window.__seelevel_hooked`
(double-underscore prefix marks it as extension-private to anyone debugging the
page).

### `EVT` constants (new, in `src/types.ts`)

To prevent typo regressions across the adapter set:

```ts
// Wire protocol event names — MAIN ↔ ISOLATED via document CustomEvent.
// Adapter-agnostic; ViewPoint and Engel & Völkers both use them.
export const EVT = {
  listings: "seelevel:listings",
  bbox: "seelevel:bbox",
  mapbusy: "seelevel:mapbusy",
  oversize: "seelevel:oversize",
  clearSession: "seelevel:clear-session",
  loadingState: "seelevel:loading-state",
} as const;
```

Every `addEventListener` / `dispatchEvent` site in the codebase references
through `EVT.*` after the rename. A typo becomes a TypeScript error, not a
silent no-op.

### Verification

- `deno fmt && deno lint` clean.
- Smoke test ViewPoint tab end-to-end: panel renders identically, drawing works,
  NEW TODAY repopulation works.
- `grep -rn 'vpa' src/ manifest.json build.ts` returns zero matches after the
  rename commits.

## 11. Permissions-Minimization Doc Update

Concrete edits to
`docs/superpowers/specs/2026-05-26-permissions-minimization-design.md`, executed
as part of this PR.

### Edit 1 — Reframe "zero extra API requests" as per-adapter

Replace the single global statement with this table:

| Adapter                                           | Intercepted requests                              | Extension-initiated requests                                                                                                                                                                | Notes                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ViewPoint (`viewpoint.ca/*`)                      | Page-fired XHRs only (passive observation)        | **None**                                                                                                                                                                                    | Zero extra API requests. Unchanged.                                                                                    |
| Engel & Völkers (`engelvoelkersnovascotia.com/*`) | Page-fired XHRs observed for bbox + filter signal | **Exactly one slim `get-listing` per viewport-settle**, fired from MAIN world, copying the user's `authToken` from `localStorage["authToken"]` (or fired without auth header if logged out) | Slim projection (10 fields, ~460 B/row), `limit:2001`, dedup'd + at-most-one-in-flight, ~0.5–3 MB per typical viewport |

### Edit 2 — Add rationale paragraph for the EV relaxation

> EV's UI feed paginates `get-listing` at `limit:10`. Pure passive observation
> would require the user to scroll dozens of pages per viewport to populate any
> SeeLevel aggregate — the same UX failure mode the Permissions-Minimization
> spec was originally written to avoid for ViewPoint. The slim sibling is fired
> from page context (MAIN-world fetch, same
> `Origin: engelvoelkersnovascotia.com`, no host_permissions required in the
> manifest). From the EV server's CORS standpoint the request is
> indistinguishable from a page-native one; from the Chrome Web Store review
> standpoint the manifest's `host_permissions` key remains absent and
> `permissions` remains exactly `["sidePanel"]`.

### Edit 3 — Update Manifest Permissions section

Add an entry noting that `content_scripts.matches` grows by one host
(`engelvoelkersnovascotia.com/*`). State explicitly: no change to `permissions`,
no `host_permissions`, no `activeTab`, `storage`, `tabs`, `scripting`,
`webRequest`, or `cookies`. The only manifest delta is
`content_scripts.matches`.

### Edit 4 — Update Zone Overlay section

> Both adapters use SeeLevel's existing Leaflet+Geoman overlay module (bundled
> into ISOLATED relay), rendered as a transparent layer on top of each site's
> `google.maps.Map`. One implementation, both adapters; only the relay's
> data-event listener set differs between them.

### Edit 5 — EULA copy

`EulaGate.tsx` currently says, in effect, "this extension observes data your
browser already receives". For EV this is no longer literally true. Add one
sentence, shown only on EV tabs (gate already mounts per panel session and knows
the active tab's origin):

> "On engelvoelkersnovascotia.com, SeeLevel issues one small filtered request
> per map move to provide complete viewport coverage. Requests use your existing
> session and follow the site's own access controls."

Exact wording can be polished in the implementation PR.

### Headline summary (new, prominent in the updated doc)

> **ViewPoint:** SeeLevel is a pure passive observer; the network footprint with
> SeeLevel installed is bit-identical to the footprint without it. **Engel &
> Völkers:** SeeLevel adds exactly one request per viewport-settle — a slim
> 10-field `get-listing` projection issued from page context, capped at 2001
> rows, dedup'd against the previous trigger, throttled at-most-one-in-flight.
> No new manifest permissions, no new origins beyond `content_scripts.matches`,
> no persisted data, no auth tokens stored or transmitted off-device.

## 12. Compliance & Constraints (Preserved)

The following from `CLAUDE.md` and prior specs remain load-bearing:

- **Nothing is persisted.** Zero `chrome.storage` usage. The EULA is
  acknowledged per panel-mount via plain `useState`. Listing/analytical data
  lives in Preact memory only. The slim sibling fetch does **not** persist
  anything either — its response is parsed and dispatched; the parsed rows live
  in panel memory like ViewPoint rows do.
- **CSV export is aggregate-only**, `< 5 listings` bucket floor, attribution
  header row. EV rows flow through the same export with no changes.
- **Manifest `permissions` is exactly `["sidePanel"]`.** No additions.
- **EULA gate** clears on every panel mount before anything else renders.
- **Voice:** clear, calm, factual; sentence case; no hype words; no exclamation
  marks; no ALL-CAPS; describe the tool, let the data speak.

## 13. Scope Boundary (Explicitly Out)

- **Additional sites.** This spec is EV-only. The architecture supports adding a
  third adapter; doing so is a separate spec.
- **Passive observation of EV's own `get-listing` calls.** Considered, dropped.
  The slim sibling supersedes them (limit:2001 vs limit:10) and merging the
  partial paginated batches adds code paths for no incremental data.
- **Active inventory optimization.** We always fire the slim sibling regardless
  of filter. Skipping it when only active is selected (which never exceeds ~550
  statewide) is a micro-optimization not worth the conditional logic.
- **Sold-cutoff date proxies beyond `ModificationTimestamp`.** The aggregator
  already accommodates the proxy via `sold_dt ?? close_dt`. Better proxies
  (e.g., NSAR field heuristics) are a v2 concern if data quality is found
  wanting in practice.
- **Cluster endpoint augmentation.** `get-listing-filtered-mobile` returns
  server-side cluster centers with `total_listings` counts. Could enrich a
  future "wide-zoom overview" mode but adds no value when our oversize threshold
  is 2000 and the cluster counts can't drive any price/area metric. Not in
  scope.
