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
} from "../types.ts";
import { EVT } from "../types.ts";
import {
  clearZone,
  getCurrentPolygon,
  initGeofenceOverlay,
  setDrawPrompt,
  setOnZoneChange,
  setOverlayVisible,
  syncMapView,
} from "./geofence-overlay.ts";

let lastBbox: BBox | null = null;
let lastNewTodayRaw = ""; // last seen localStorage["vp.new_today"] payload

// Buffer of all listings/properties seen since the last ViewPoint mode switch.
// Persists across SW restarts (same content-script context). Cleared only by
// clearSession() on explicit mode switch; openPort() signals the SW whether
// this map is populated so the panel knows not to reset its in-memory store.
const sessionListings = new Map<string, ListingRow>();
const sessionProperties = new Map<string, PropertyRow>();

// One port to the SW broker. Opens immediately on content-script load; SW
// will signal panel_opened when (and only when) the side panel is also
// connected. Until then, we observe the page but don't emit.
let port: chrome.runtime.Port = openPort();
let panelOpen = false;
let reconnectTimeout: number | undefined;
let reconnectDelay = 1000;

function openPort(): chrome.runtime.Port {
  // Use "relay-reconnect" when we have live session data. A fresh content-script
  // context always starts with empty maps, so this name only appears on SW-restart
  // reconnects. The SW uses it to skip the tab_loaded reset that would otherwise
  // wipe the panel's in-memory store.
  const name = (sessionListings.size > 0 || sessionProperties.size > 0)
    ? "relay-reconnect"
    : "relay";
  const p = chrome.runtime.connect({ name });
  p.onMessage.addListener((msg: RelayDown) => {
    // Any inbound message means the connection is bidirectionally working;
    // reset the backoff so a future SW restart starts at 1s, not where the
    // last failure cycle left off.
    reconnectDelay = 1000;
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
  p.onDisconnect.addListener(() => {
    panelOpen = false;
    // SW may have been terminated. Reconnect with backoff. Each reconnect
    // re-triggers SW.onConnect, which broadcasts panel_opened if the panel
    // is still up - so state catches up automatically.
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
      // chrome.runtime.connect itself threw (rare); back off and retry.
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      scheduleReconnect();
      return;
    }
    // openPort() returned a port - but it may immediately disconnect if the
    // SW is still down. Double the backoff preemptively; if a message
    // arrives, the onMessage handler will reset it back to 1s.
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }, reconnectDelay);
}

function emit(payload: ContentToPanel): void {
  if (!panelOpen) return; // panel closed - drop silently
  try {
    port.postMessage({ type: "msg", payload } satisfies RelayUp);
  } catch { /* port disconnected mid-call - reconnect will fire */ }
}

// Re-emit current snapshots to a freshly-connected panel. Called on panel_opened.
// We no longer clear the session maps here: on a genuine new page load the maps
// are already empty (new content-script context), so clearing was always a no-op
// in that path. On a SW-restart reconnect the maps hold live data that the panel
// still needs - clearing them here would cause a second SW restart to wipe the
// session even though "relay-reconnect" prevented the first one.
function clearAndReEmit(): void {
  lastNewTodayRaw = ""; // force pollNewTodayCache to re-emit on next tick
  if (lastBbox) emit({ type: "viewport_bbox", bbox: lastBbox });
  emit({ type: "zone", polygon: getCurrentPolygon() });
  // Trigger a fresh poll synchronously so new_today (cache-only mode) doesn't
  // have to wait for the next 1.5s tick.
  pollNewTodayCache();
}

// boundsinfo XHR and Google Maps events both fire seelevel:bbox.
// The Google Maps hook also includes center_lat/center_lng/zoom for setView() precision.
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
  if (d.settled) {
    emit({ type: "viewport_bbox", bbox: lastBbox });
  }
});

document.addEventListener(EVT.mapbusy, () => setOverlayVisible(false));

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

document.addEventListener(EVT.listings, (e) => {
  const { body, url } = (e as CustomEvent<{ body: string; url: string }>)
    .detail;
  const parsed = parseInterceptedResponse(body, url);
  if (!parsed) return;

  upsertSession(parsed.listings, parsed.properties);

  const kind: ListingKind = url.includes("/api/v2/listing/search")
    ? "search"
    : "global";

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

// Zone draw/edit/clear events from the overlay → panel, via the shared port.
setOnZoneChange((polygon) => emit({ type: "zone", polygon }));

initGeofenceOverlay();
