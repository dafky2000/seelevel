# Permissions Minimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop `activeTab`, `storage`, and `host_permissions` from
`manifest.json` so SeeLevel can clear Chrome Web Store review faster, while
preserving every existing user-facing behaviour.

**Architecture:** Replace `chrome.runtime.sendMessage` broadcasts and
`chrome.tabs.sendMessage` calls with a port-broker topology — content scripts
and the side panel each open one long-lived `chrome.runtime.connect` port to the
background SW, which routes messages by `tabId`. EULA acknowledgement becomes
per-session React state instead of `chrome.storage.local`.

**Tech Stack:** Deno + esbuild + Preact, Chrome MV3 extension APIs, no test
framework changes (existing `jsr:@std/assert` Deno tests in
`src/panel/lib/__tests__/` continue to pass; messaging is verified by smoke test
as per repo convention).

**Companion spec:**
`docs/superpowers/specs/2026-05-26-permissions-minimization-design.md`

---

## Commit 1 — Port-broker refactor

Goal: replace all `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` usage
with a single port to a SW broker. No manifest or EULA changes in this commit —
those land in Commits 2 and 3.

### Task 1: Add wire envelope types to `types.ts`

**Files:**

- Modify: `src/types.ts:54-74`

- [ ] **Step 1: Replace the `ContentToPanel` and `PanelToContent` unions and
      append the wire envelope types**

Open `src/types.ts`. Replace the block from line 53 through line 74 (the
`ContentToPanel` and `PanelToContent` exports) with:

```ts
// Messages from content scripts → side panel (semantic payloads, wrapped in
// a PanelDown envelope by the SW broker before delivery).
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
  | { type: "clear_session" };

// Messages from side panel → content scripts (semantic payloads, wrapped in
// a PanelUp envelope by the panel before delivery to the SW broker).
export type PanelToContent =
  | { type: "clear_zone" }
  | { type: "zone_prompt"; active: boolean };

// ─── Port wire envelopes (chrome.runtime.connect transport) ────────────────
// Each tab's content script opens a "relay" port to the SW. The side panel
// opens a "panel" port. The SW routes by port.sender.tab.id.

// content script → SW
export type RelayUp = { type: "msg"; payload: ContentToPanel };

// SW → content script
export type RelayDown =
  | { type: "panel_opened" }
  | { type: "msg"; payload: PanelToContent };

// panel → SW
export type PanelUp = { type: "msg"; tabId: number; payload: PanelToContent };

// SW → panel
export type PanelDown =
  | { type: "tab_loaded"; tabId: number }
  | { type: "msg"; tabId: number; payload: ContentToPanel };
```

- [ ] **Step 2: Run the type-checked test suite to confirm nothing references
      the removed types yet**

Run: `deno test -A src/` Expected: all 39 tests PASS. (The removed types —
`tab_loaded` from `ContentToPanel`, `panel_ready`/`reset_session`/`tabId` on
`clear_zone` from `PanelToContent` — aren't referenced from pure lib code; the
references in `sw.ts`, `relay.ts`, and `App.tsx` will be replaced in the
following tasks. The build will be temporarily broken until those tasks land,
but tests don't depend on those files.)

### Task 2: Rewrite `sw.ts` as the port broker

**Files:**

- Modify: `src/background/sw.ts` (full rewrite)

- [ ] **Step 1: Replace `sw.ts` with the broker implementation**

Replace the entire contents of `src/background/sw.ts` with:

```ts
/// <reference types="chrome"/>
import type { PanelDown, PanelUp, RelayDown, RelayUp } from "../types.ts";

// One port per ViewPoint tab, keyed by tab id, opened by relay.ts on
// content-script load. SW routes panel↔content messages through these.
const relayPorts = new Map<number, chrome.runtime.Port>();

// At most one panel port - the side panel is global, not per-tab. Null while
// the side panel is closed; SW silently drops relay→panel messages then.
let panelPort: chrome.runtime.Port | null = null;

// Suppress throws if a port disconnected between the routing decision and
// the actual postMessage. Disconnects can race with in-flight messages.
function safePost(port: chrome.runtime.Port, msg: unknown): void {
  try {
    port.postMessage(msg);
  } catch { /* port already disconnected */ }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "relay") {
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) return; // not a tab-scoped connection - ignore
    relayPorts.set(tabId, port);

    // If the panel is already open when this relay connects (new viewpoint
    // tab opened, or existing tab navigated within viewpoint.ca), synthesise
    // tab_loaded for the panel (reset that tab's TabStore - it may hold stale
    // state from the pre-navigation page) and panel_opened for the new relay
    // (it can start emitting).
    if (panelPort) {
      safePost(panelPort, { type: "tab_loaded", tabId } satisfies PanelDown);
      safePost(port, { type: "panel_opened" } satisfies RelayDown);
    }

    port.onMessage.addListener((msg: RelayUp) => {
      if (msg.type !== "msg") return;
      if (!panelPort) return; // panel closed - drop silently
      safePost(
        panelPort,
        { type: "msg", tabId, payload: msg.payload } satisfies PanelDown,
      );
    });

    port.onDisconnect.addListener(() => {
      relayPorts.delete(tabId);
    });
    return;
  }

  if (port.name === "panel") {
    panelPort = port;

    // Panel just mounted - tell every connected relay so they wipe their
    // buffer and re-emit current snapshots. Panel's tabStores is freshly
    // empty, so no tab_loaded is sent in this direction (it would be a
    // no-op reset of empty state).
    for (const relay of relayPorts.values()) {
      safePost(relay, { type: "panel_opened" } satisfies RelayDown);
    }

    port.onMessage.addListener((msg: PanelUp) => {
      if (msg.type !== "msg") return;
      const relay = relayPorts.get(msg.tabId);
      if (relay) {
        safePost(
          relay,
          { type: "msg", payload: msg.payload } satisfies RelayDown,
        );
      }
    });

    port.onDisconnect.addListener(() => {
      panelPort = null;
    });
    return;
  }
});

// Open the side panel when the user clicks the extension icon.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.sidePanel.open({ tabId: tab.id });
});
```

- [ ] **Step 2: Verify the file parses**

Run: `deno check src/background/sw.ts 2>&1 | tail -5` Expected: no errors.
(Type-check of just this file; the broader build is still broken because
`relay.ts` and `App.tsx` still reference the old API — those land next.)

### Task 3: Expose `clearZone` from `geofence-overlay.ts` and drop its private port

**Files:**

- Modify: `src/content/geofence-overlay.ts:76` (export clearZone)
- Modify: `src/content/geofence-overlay.ts:344-348` (drop the geofence-specific
  port)

- [ ] **Step 1: Export `clearZone`**

In `src/content/geofence-overlay.ts`, find line 76
(`function clearZone(): void {`). Change it to:

```ts
export function clearZone(): void {
```

- [ ] **Step 2: Remove the geofence-specific port**

In `src/content/geofence-overlay.ts`, find lines 344-348 inside
`initLeafletOverlay`:

```ts
function initLeafletOverlay(mapContainer: HTMLElement): void {
  const port = chrome.runtime.connect({ name: "geofence-" + Date.now() });
  port.onMessage.addListener((msg) => {
    if (msg.type === "clear_zone") clearZone();
  });
```

Replace with:

```ts
function initLeafletOverlay(mapContainer: HTMLElement): void {
  // (Port for clear_zone is owned by relay.ts - it dispatches to clearZone()
  // when the panel sends a clear_zone command over the shared "relay" port.)
```

- [ ] **Step 3: Verify the file parses**

Run: `deno check src/content/geofence-overlay.ts 2>&1 | tail -5` Expected: no
errors.

### Task 4: Rewrite `relay.ts` to use the port

**Files:**

- Modify: `src/content/relay.ts` (full rewrite)

- [ ] **Step 1: Replace `relay.ts` with the port-based implementation**

Replace the entire contents of `src/content/relay.ts` with:

```ts
/// <reference types="chrome"/>
import {
  parseInterceptedResponse,
  parseViewpointCache,
} from "../panel/lib/parse.ts";
import type {
  BBox,
  ContentToPanel,
  ListingKind,
  ListingRow,
  PropertyRow,
  RelayDown,
  RelayUp,
  SearchStatus,
} from "../types.ts";
import {
  clearZone,
  getCurrentPolygon,
  initGeofenceOverlay,
  setDrawPrompt,
  setOverlayVisible,
  syncMapView,
} from "./geofence-overlay.ts";

let lastBbox: BBox | null = null;
let lastNewTodayRaw = ""; // last seen localStorage["vp.new_today"] payload
let lastSearch:
  | { listings: ListingRow[]; properties: PropertyRow[]; status: SearchStatus }
  | null = null;

// Buffer of all listings/properties seen since the last ViewPoint mode switch
// or panel-open event. Replayed nowhere - the buffer just persists state for
// listing/search responses that came in while the panel was closed; the next
// panel_opened wipes everything.
const sessionListings = new Map<string, ListingRow>();
const sessionProperties = new Map<string, PropertyRow>();

// One port to the SW broker. Opens immediately on content-script load; SW
// will signal panel_opened when (and only when) the side panel is also
// connected. Until then, we observe the page but don't emit.
const port = chrome.runtime.connect({ name: "relay" });
let panelOpen = false;

function emit(payload: ContentToPanel): void {
  if (!panelOpen) return; // panel closed - drop silently
  try {
    port.postMessage({ type: "msg", payload } satisfies RelayUp);
  } catch { /* port disconnected */ }
}

// Wipe buffered state and re-emit current snapshots. Called on panel_opened
// so a freshly-opened panel sees only fresh data - no stale buffer leak.
function clearAndReEmit(): void {
  sessionListings.clear();
  sessionProperties.clear();
  lastSearch = null;
  lastNewTodayRaw = ""; // force pollNewTodayCache to re-emit on next tick
  if (lastBbox) emit({ type: "viewport_bbox", bbox: lastBbox });
  emit({ type: "zone", polygon: getCurrentPolygon() });
  // Trigger a fresh poll synchronously so new_today (cache-only mode) doesn't
  // have to wait for the next 1.5s tick.
  pollNewTodayCache();
}

port.onMessage.addListener((msg: RelayDown) => {
  if (msg.type === "panel_opened") {
    panelOpen = true;
    clearAndReEmit();
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

port.onDisconnect.addListener(() => {
  panelOpen = false;
});

// boundsinfo XHR and Google Maps events both fire vpa:bbox.
// The Google Maps hook also includes center_lat/center_lng/zoom for setView() precision.
document.addEventListener("vpa:bbox", (e) => {
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
  if (d.settled) {
    emit({ type: "viewport_bbox", bbox: lastBbox });
  }
});

document.addEventListener("vpa:mapbusy", () => setOverlayVisible(false));

function upsertSession(
  listings: ListingRow[],
  properties: PropertyRow[],
): void {
  for (const l of listings) {
    const prev = sessionListings.get(l.id);
    sessionListings.set(
      l.id,
      prev ? { ...l, lat: l.lat ?? prev.lat, lng: l.lng ?? prev.lng } : l,
    );
  }
  for (const p of properties) sessionProperties.set(p.pid, p);
}

document.addEventListener("vpa:listings", (e) => {
  const { body, url } = (e as CustomEvent<{ body: string; url: string }>)
    .detail;
  const parsed = parseInterceptedResponse(body, url);
  if (!parsed) return;

  upsertSession(parsed.listings, parsed.properties);

  const kind: ListingKind = url.includes("/api/v2/listing/search")
    ? "search"
    : "global";
  lastSearch = kind === "search"
    ? {
      listings: parsed.listings,
      properties: parsed.properties,
      status: parsed.status,
    }
    : null;

  emit({
    type: "listings",
    listings: parsed.listings,
    properties: parsed.properties,
    bbox: parsed.bbox,
    kind,
    status: kind === "search" ? parsed.status : "any",
  });

  // Re-send the current polygon so a late-bound panel always knows the zone state.
  emit({ type: "zone", polygon: getCurrentPolygon() });
});

// ─── ViewPoint mode-switch detection ──────────────────────────────────────────
function clearSession(): void {
  sessionListings.clear();
  sessionProperties.clear();
  lastSearch = null;
  lastNewTodayRaw = "";
  emit({ type: "clear_session" });
}

document.addEventListener("click", (e) => {
  const t = e.target as Element | null;
  if (!t || typeof t.closest !== "function") return;
  if (
    t.closest(".sidebar-navigation-item-NEWTODAY") ||
    t.closest(".sidebar-navigation-item-TOP_LISTINGS") ||
    (t.closest(".vp-dialog-btn.btn-positive") &&
      t.closest("form.property-search-form"))
  ) {
    clearSession();
  }
}, true);

document.addEventListener("submit", (e) => {
  const t = e.target as Element | null;
  if (
    t && typeof t.closest === "function" &&
    t.closest("form.property-search-form")
  ) {
    clearSession();
  }
}, true);

// ─── localStorage cache mirror (NEW TODAY) ────────────────────────────────────
function pollNewTodayCache(): void {
  const tab = document.querySelector(".sidebar-navigation-item-NEWTODAY");
  if (!tab || !tab.classList.contains("selected")) return;

  const raw = localStorage.getItem("vp.new_today");
  if (!raw || raw === lastNewTodayRaw) return;
  lastNewTodayRaw = raw;

  const parsed = parseViewpointCache(raw);
  if (!parsed) return;

  upsertSession(parsed.listings, parsed.properties);
  lastSearch = null;

  emit({
    type: "listings",
    listings: parsed.listings,
    properties: parsed.properties,
    bbox: null,
    kind: "global",
    status: "any",
  });
}
setInterval(pollNewTodayCache, 1500);
pollNewTodayCache();

initGeofenceOverlay();
```

- [ ] **Step 2: Verify the file parses**

Run: `deno check src/content/relay.ts 2>&1 | tail -5` Expected: no errors.

### Task 5: Rewrite the panel's messaging in `App.tsx`

**Files:**

- Modify: `src/panel/App.tsx:37-152` (panel-port + handler block)
- Modify: `src/panel/App.tsx:196-200` (zone_prompt sender)
- Modify: `src/panel/App.tsx:292-300` (clear_zone sender)

- [ ] **Step 1: Add the port ref + activeTabId ref alongside existing state**

In `src/panel/App.tsx`, find the block at lines 36-40:

```tsx
function App() {
  const [eulaAccepted, setEulaAccepted] = useState<boolean | null>(null);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const tabStores = useRef<Map<number, TabStore>>(new Map());
  const [store, setStore] = useState<TabStore | null>(null);
  const [sections, setSections] = useState<MetricSection[] | null>(null);
```

Replace with:

```tsx
function App() {
  const [eulaAccepted, setEulaAccepted] = useState<boolean | null>(null);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const tabStores = useRef<Map<number, TabStore>>(new Map());
  const [store, setStore] = useState<TabStore | null>(null);
  const [sections, setSections] = useState<MetricSection[] | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  // activeTabId mirrored into a ref so the (mount-once) port message handler
  // can read its current value without re-subscribing on every tab switch.
  const activeTabIdRef = useRef<number | null>(null);
```

- [ ] **Step 2: Update the import statement to bring in `PanelDown` and
      `PanelUp`**

In `src/panel/App.tsx`, find line 4:

```tsx
import type { ContentToPanel, MetricKey, TabStore } from "../types.ts";
```

Replace with:

```tsx
import type {
  MetricKey,
  PanelDown,
  PanelToContent,
  PanelUp,
  TabStore,
} from "../types.ts";
```

(`ContentToPanel` no longer needs to be a direct import since the handler
narrows via the envelope; keep it implicit via `PanelDown`.)

- [ ] **Step 3: Replace the activeTabId-sync effect and the
      chrome.runtime.onMessage effect with a single port effect**

In `src/panel/App.tsx`, find the block at lines 62-152 — from the
`// Tabs whose relay buffer...` comment through the end of the
chrome.runtime.onMessage effect.

Replace the entire block with:

```tsx
// Mirror activeTabId into a ref for use inside the stable port handler.
useEffect(() => {
  activeTabIdRef.current = activeTabId;
}, [activeTabId]);

// Sync store when active tab changes. The relay's session is wiped by the
// SW broadcasting panel_opened on panel mount (NOT here) - tab switch is
// pure UI: just show that tab's stored data.
useEffect(() => {
  if (activeTabId === null) return;
  if (!tabStores.current.has(activeTabId)) {
    tabStores.current.set(activeTabId, defaultTabStore(activeTabId));
  }
  setStore({ ...tabStores.current.get(activeTabId)! });
}, [activeTabId]);

// Single port to the SW broker. Opened once on panel mount; SW broadcasts
// panel_opened to every relay on this connection. Disconnects when the
// panel closes - relays then drop messages silently.
useEffect(() => {
  const port = chrome.runtime.connect({ name: "panel" });
  portRef.current = port;

  function onMessage(msg: PanelDown) {
    if (msg.type === "tab_loaded") {
      // SW saw a relay port (re)connect - reset our view of that tab.
      tabStores.current.set(msg.tabId, defaultTabStore(msg.tabId));
      if (msg.tabId === activeTabIdRef.current) {
        setStore({ ...tabStores.current.get(msg.tabId)! });
      }
      return;
    }
    if (msg.type !== "msg") return;
    const { tabId, payload } = msg;
    if (!tabStores.current.has(tabId)) {
      tabStores.current.set(tabId, defaultTabStore(tabId));
    }
    const s = tabStores.current.get(tabId)!;

    if (payload.type === "clear_session") {
      // ViewPoint mode switch - drop accumulated listings. The drawn zone
      // and map bounds persist; the views just empty.
      s.session = [];
      s.viewportListings = null;
      s.fetchedBboxes = [];
      s.searchStatus = "any";
    }

    if (payload.type === "listings") {
      const resolved = resolveCoordinates(payload.listings, payload.properties);
      s.session = mergeListings(s.session, resolved);
      s.viewportListings = payload.kind === "search" ? resolved : null;
      if (payload.kind === "search") s.searchStatus = payload.status;
      if (payload.bbox) s.fetchedBboxes = [...s.fetchedBboxes, payload.bbox];
    }

    if (payload.type === "viewport_bbox") {
      s.viewportBbox = payload.bbox;
    }

    if (payload.type === "zone") {
      // Switch to zone scope only when a zone first appears - not on every
      // re-send (the relay re-sends the polygon on each listings update,
      // which would otherwise yank the user back to "zone" while panning).
      const isNewZone = !!payload.polygon && !s.polygon;
      s.polygon = payload.polygon;
      if (isNewZone) s.scope = "zone";
      else if (!payload.polygon && s.scope === "zone") s.scope = "session";
    }

    if (tabId === activeTabIdRef.current) {
      setStore({ ...s });
    }
  }

  port.onMessage.addListener(onMessage);
  return () => {
    port.disconnect();
    portRef.current = null;
  };
}, []);
```

- [ ] **Step 4: Add a small helper to post to a tab's relay via the port**

In `src/panel/App.tsx`, immediately after the port effect (the one ending in
`}, []);`), add:

```tsx
// Send a panel→content payload through the SW broker to a specific tab.
const postToRelay = useCallback((tabId: number, payload: PanelToContent) => {
  const port = portRef.current;
  if (!port) return;
  try {
    port.postMessage({ type: "msg", tabId, payload } satisfies PanelUp);
  } catch { /* port disconnected */ }
}, []);
```

- [ ] **Step 5: Replace the zone_prompt sender**

In `src/panel/App.tsx`, find the block around line 196-200:

```tsx
// Pulse the map's draw-zone button while the Zone tab is open with no zone.
useEffect(() => {
  if (activeTabId === null || !store) return;
  const active = store.scope === "zone" && !store.polygon;
  chrome.tabs.sendMessage(activeTabId, { type: "zone_prompt", active }).catch(
    () => {},
  );
}, [activeTabId, store?.scope, store?.polygon]);
```

Replace with:

```tsx
// Pulse the map's draw-zone button while the Zone tab is open with no zone.
useEffect(() => {
  if (activeTabId === null || !store) return;
  const active = store.scope === "zone" && !store.polygon;
  postToRelay(activeTabId, { type: "zone_prompt", active });
}, [activeTabId, store?.scope, store?.polygon, postToRelay]);
```

- [ ] **Step 6: Replace the clear_zone sender in the footer button**

In `src/panel/App.tsx`, find the block around line 292-300 (the Clear button's
onClick):

```tsx
<button class="vpa-btn vpa-btn--ghost" onClick={() => {
  updateStore({ session: [], viewportListings: null, fetchedBboxes: [], viewportBbox: null, polygon: null, scope: "viewport" });
  if (activeTabId !== null) {
    chrome.runtime.sendMessage({ type: "clear_zone", tabId: activeTabId }).catch(() => {});
  }
}}>
```

Replace with:

```tsx
<button class="vpa-btn vpa-btn--ghost" onClick={() => {
  updateStore({ session: [], viewportListings: null, fetchedBboxes: [], viewportBbox: null, polygon: null, scope: "viewport" });
  if (activeTabId !== null) {
    postToRelay(activeTabId, { type: "clear_zone" });
  }
}}>
```

- [ ] **Step 7: Verify the panel parses**

Run: `deno check src/panel/App.tsx 2>&1 | tail -5` Expected: no errors.

### Task 6: Build and run the unit test suite

- [ ] **Step 1: Production build**

Run: `deno run -A build.ts 2>&1 | tail -3` Expected: `Build complete.` (no
errors).

- [ ] **Step 2: Run all tests**

Run: `deno test -A src/ 2>&1 | tail -3` Expected: `ok | 39 passed | 0 failed`.

- [ ] **Step 3: Confirm no stale message types referenced**

Run:
`grep -rn "panel_ready\|reset_session\|\"tab_loaded\"" src/ --include="*.ts" --include="*.tsx"`
Expected: no matches. (`tab_loaded` _as a string literal_ only exists in the SW
now wrapped in `PanelDown`; the grep above explicitly looks for the bare quoted
string in source.)

Run:
`grep -rn "chrome\.tabs\.sendMessage\|chrome\.runtime\.sendMessage\|chrome\.runtime\.onMessage" src/`
Expected: no matches.

### Task 7: Smoke test the port refactor

- [ ] **Step 1: Load the unpacked extension and reload**

Manual: in `chrome://extensions`, locate SeeLevel, click reload. Reload any open
viewpoint.ca tab so new content scripts inject.

- [ ] **Step 2: Confirm the panel populates on open**

Manual: open the side panel via the action button on a viewpoint.ca/map page.
Confirm:

- EULA gate still appears (this commit doesn't change it yet).
- After acknowledging, the panel populates with listings within ~1.5s of opening
  (the new_today cache poll tick).
- Listing count in the header matches the visible bbox area.

- [ ] **Step 3: Close and re-open the panel — state resets**

Manual: close the side panel, reopen. Confirm:

- Panel re-shows the EULA gate (no `storage` change yet, so this is the same as
  before).
- After acknowledging, panel populates with fresh data again, with the listing
  count matching the visible bbox (not accumulating stale).

- [ ] **Step 4: Test zone draw + clear**

Manual:

- Open the panel, switch to the Zone tab → the draw button pulses on the map.
- Draw a polygon → panel switches to Zone scope, listings filter to the polygon.
- Click "Clear data" in the panel footer → polygon disappears from the map,
  panel resets.

- [ ] **Step 5: Test multi-tab independence**

Manual:

- Open viewpoint.ca/map in two tabs (A and B). Each shows different map
  positions.
- With panel open, switch between tabs A and B. Confirm:
  - The panel re-renders with each tab's own listings/bbox.
  - Switching tabs doesn't wipe either tab's data.

- [ ] **Step 6: Test page reload while panel is open**

Manual: with panel open on tab A, refresh tab A (Cmd/Ctrl+R). Confirm the panel
resets that tab's view to empty, then repopulates within ~1.5s.

### Task 8: Commit the port-broker refactor

- [ ] **Step 1: Stage and commit**

```bash
git add src/types.ts src/background/sw.ts src/content/relay.ts src/content/geofence-overlay.ts src/panel/App.tsx
git commit -m "$(cat <<'EOF'
Refactor messaging to port-broker topology

Replace chrome.runtime.sendMessage broadcasts and chrome.tabs.sendMessage
calls with a single chrome.runtime.connect port per context, brokered
through the background SW. Relay/panel each open one long-lived port;
SW routes by tab id. Folds the previous geofence-only port into the
shared "relay" port. Per the spec, panel_ready and reset_session are
subsumed by SW-broadcast panel_opened; tab_loaded is now synthesised by
SW from port-connect events.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Confirm the working tree is clean**

Run: `git status` Expected: `nothing to commit, working tree clean`.

---

## Commit 2 — EULA acknowledge-each-open

Goal: remove the `chrome.storage.local` dependency for EULA persistence so the
`storage` permission can be dropped in Commit 3.

### Task 9: Slim `EulaGate.tsx`

**Files:**

- Modify: `src/panel/components/EulaGate.tsx` (full rewrite)

- [ ] **Step 1: Replace `EulaGate.tsx`**

Replace the entire contents of `src/panel/components/EulaGate.tsx` with:

```tsx
import { h } from "preact";

export function EulaGate({ onAcknowledge }: { onAcknowledge: () => void }) {
  return (
    <div
      style={{
        padding: "24px 18px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      <strong style={{ fontSize: "14px" }}>
        See<span style={{ color: "var(--color-accent)" }}>Level</span>
      </strong>
      <p
        style={{
          fontSize: "11px",
          color: "var(--color-muted)",
          lineHeight: 1.6,
        }}
      >
        Personal, non-commercial use only. Commercial or professional users must
        contact ViewPoint.ca directly before use.
      </p>
      <p
        style={{
          fontSize: "10px",
          color: "var(--color-muted)",
          lineHeight: 1.6,
        }}
      >
        Data: NSAR MLS® via ViewPoint.ca. This extension does not store,
        transmit, or redistribute listing data.
      </p>
      <button
        class="vpa-btn vpa-btn--primary"
        style={{
          fontSize: "11px",
          padding: "8px 0",
          borderRadius: "6px",
          fontWeight: 700,
        }}
        onClick={onAcknowledge}
      >
        I understand — continue
      </button>
    </div>
  );
}
```

Note: the prop renames from `onAccept` to `onAcknowledge` to reflect per-session
semantics; the GitHub URL is removed (already present in `Disclaimer.tsx`).

- [ ] **Step 2: Verify the file parses**

Run: `deno check src/panel/components/EulaGate.tsx 2>&1 | tail -5` Expected: no
errors. (Will report unused prop name in App.tsx until the next task lands.)

### Task 10: Replace `chrome.storage.local` with per-session state in `App.tsx`

**Files:**

- Modify: `src/panel/App.tsx:36` (state declaration)
- Modify: `src/panel/App.tsx:42-47` (remove storage-load effect)
- Modify: `src/panel/App.tsx:197-200` (Eula gate render)

- [ ] **Step 1: Change the `useState` initial value and rename**

In `src/panel/App.tsx`, find line 36:

```tsx
const [eulaAccepted, setEulaAccepted] = useState<boolean | null>(null);
```

Replace with:

```tsx
// Per-session acknowledgement only - reset on every panel mount (no
// chrome.storage so no `storage` permission). Default false; the gate's
// button flips it to true.
const [eulaAcknowledged, setEulaAcknowledged] = useState(false);
```

- [ ] **Step 2: Remove the storage-load effect**

In `src/panel/App.tsx`, find lines 42-47:

```tsx
// Check EULA on mount
useEffect(() => {
  chrome.storage.local.get("eulaAccepted", (r) => {
    setEulaAccepted(!!r.eulaAccepted);
  });
}, []);
```

Delete the entire block (including the blank line after it).

- [ ] **Step 3: Update the render branch that gates on EULA**

In `src/panel/App.tsx`, find the block (was around line 197-200 before
deletions):

```tsx
if (eulaAccepted === null) return null; // loading
if (!eulaAccepted) {
  return (
    <EulaGate
      onAccept={() => {
        chrome.storage.local.set({ eulaAccepted: true });
        setEulaAccepted(true);
      }}
    />
  );
}
```

Replace with:

```tsx
if (!eulaAcknowledged) {
  return <EulaGate onAcknowledge={() => setEulaAcknowledged(true)} />;
}
```

(The "loading" branch goes away — there's no async load.)

- [ ] **Step 4: Verify nothing references `chrome.storage` anymore**

Run: `grep -n "chrome\.storage" src/` Expected: no matches.

- [ ] **Step 5: Build and test**

Run: `deno run -A build.ts 2>&1 | tail -3` Expected: `Build complete.`

Run: `deno test -A src/ 2>&1 | tail -3` Expected: `ok | 39 passed | 0 failed`.

### Task 11: Smoke test the EULA change

- [ ] **Step 1: Reload extension and viewpoint tab**

Manual: reload SeeLevel from `chrome://extensions`, refresh the viewpoint.ca
tab.

- [ ] **Step 2: Confirm gate shows on first open**

Manual: open the side panel. Confirm:

- The slim two-paragraph gate appears (not the previous longer version).
- The button reads "I understand — continue".

- [ ] **Step 3: Confirm acknowledge dismisses the gate**

Manual: click the button. Confirm the main panel renders.

- [ ] **Step 4: Confirm gate shows again on next open**

Manual: close the side panel, reopen it. Confirm the gate appears again
(per-session acknowledgement is working — no persistence).

- [ ] **Step 5: Confirm Disclaimer footer still shows the GitHub link**

Manual: in the main panel (post-acknowledge), scroll to the footer. Confirm the
GitHub repo URL and "Report an issue" link still appear in `Disclaimer.tsx`.

### Task 12: Commit the EULA change

- [ ] **Step 1: Stage and commit**

```bash
git add src/panel/App.tsx src/panel/components/EulaGate.tsx
git commit -m "$(cat <<'EOF'
EULA acknowledge per session instead of persistent storage

Replace chrome.storage.local-backed eulaAccepted with a per-panel-mount
useState(false). Slim the gate copy to two paragraphs since users now
re-acknowledge on every open; the GitHub URL stays in the persistent
Disclaimer footer. No code references chrome.storage anymore.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Confirm clean tree**

Run: `git status` Expected: `nothing to commit, working tree clean`.

---

## Commit 3 — Manifest cleanup

Goal: drop `activeTab`, `storage`, and the entire `host_permissions` key from
the manifest. Verifies that Commits 1 and 2 fully removed dependencies on those
permissions.

### Task 13: Strip permissions from `manifest.json`

**Files:**

- Modify: `manifest.json:6-7`

- [ ] **Step 1: Edit the permissions block**

In `manifest.json`, find lines 6-7:

```json
"permissions": ["sidePanel", "activeTab", "storage"],
"host_permissions": ["*://*.viewpoint.ca/*"],
```

Replace with:

```json
"permissions": ["sidePanel"],
```

(Both `host_permissions` and the extra entries in `permissions` are gone in one
edit.)

- [ ] **Step 2: Verify the final manifest**

Run: `cat manifest.json` Expected: `permissions` has exactly one entry
(`sidePanel`); no `host_permissions` key anywhere in the file; `content_scripts`
block is unchanged.

- [ ] **Step 3: Production build**

Run: `deno run -A build.ts 2>&1 | tail -3` Expected: `Build complete.`

### Task 14: Full smoke test on a fresh load

- [ ] **Step 1: Hard-reload the extension**

Manual: in `chrome://extensions`, remove SeeLevel entirely (don't just reload —
remove). Then "Load unpacked" from `build/` to install fresh. This is important
because Chrome caches the previous permission grants.

- [ ] **Step 2: Confirm install-time permission prompt is unchanged**

Manual: on the load-unpacked dialog, observe the prompt. Expected: still "Read
and modify data on viewpoint.ca" (from `content_scripts.matches`). The
user-facing prompt is the same; what changed is the _manifest_ declares less.

- [ ] **Step 3: Run all the smoke flows from Tasks 7 and 11**

Manual, on a fresh viewpoint.ca tab:

- EULA gate appears on first panel open.
- Acknowledging shows the main panel.
- Listings populate within ~1.5s.
- Close + reopen panel → EULA again, then fresh data.
- Multi-tab independence: open two viewpoint tabs, switch between them in the
  panel.
- Zone draw + clear works.
- Page reload while panel is open resets that tab's view.

- [ ] **Step 4: Confirm no console errors**

Manual: open DevTools on the viewpoint.ca page → Console. Expected: no errors
from `relay.js`, `fetch-interceptor.js`, or `sw.js`. (ViewPoint's own page
errors are out of scope.)

Open DevTools on the side panel (right-click panel → Inspect) → Console.
Expected: no errors from `panel.js`.

- [ ] **Step 5: Confirm permission revocation doesn't fire**

Manual: visit `chrome://extensions/?id=<seelevel-id>` → Details → Permissions.
Expected: only "Read and modify your data on www.viewpoint.ca" listed; nothing
about active tab, storage, or "Read your browsing history".

### Task 15: Commit the manifest cleanup

- [ ] **Step 1: Stage and commit**

```bash
git add manifest.json
git commit -m "$(cat <<'EOF'
Drop activeTab, storage, and host_permissions from manifest

The permission scope is now the minimum required to inject content
scripts on viewpoint.ca (via content_scripts.matches, which produces
the same install-time user prompt as the previous host_permissions
declaration). Web Store review should no longer trigger the
"Limited Host Use" in-depth review path on the host_permissions key.

All four permission-dependent code paths (chrome.tabs.sendMessage,
chrome.runtime.sendMessage broadcasts, chrome.storage.local,
chrome.action gate) were migrated in earlier commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Confirm history**

Run: `git log --oneline -5` Expected: three new commits on top of the previous
initial commit — port-broker refactor, EULA per session, manifest drop.

---

## Self-Review Notes

**Spec coverage:**

- §3 (port topology) → Tasks 2, 3, 4, 5
- §4 (message flow & lifecycle) → Tasks 2 (SW broadcast on relay-connect +
  panel-connect), 4 (relay `panel_opened` handler, `emit()` gate on `panelOpen`)
- §5 (EULA without storage) → Tasks 9, 10
- §6 (manifest changes) → Task 13
- §7 (sequence) → Three-commit structure preserved (Tasks 1-8, 9-12, 13-15)
- §8 risks → Task 7 (port-refactor smoke), Task 11 (EULA smoke), Task 14 (full
  post-manifest smoke) cover the regression-prone areas; SW suspension risk is
  structural (active ports prevent suspension) and not actionable in a task.

**Placeholder scan:** no TBDs; every edit has the full code shown; every command
has expected output.

**Type consistency:** `RelayUp`/`RelayDown`/`PanelUp`/`PanelDown` defined in
Task 1 are used identically in Tasks 2 (sw.ts), 4 (relay.ts), 5 (App.tsx).
`clearZone` exported in Task 3 is imported in Task 4. `onAcknowledge` prop
introduced in Task 9 is wired in Task 10.

**Ambiguities resolved:** `tab_loaded` synthesis happens only when a new relay
port connects (Task 2 step 1, lines around the `if (panelPort)` block), not on
panel-open broadcast — this matches the spec §4 note about asymmetric handling.
