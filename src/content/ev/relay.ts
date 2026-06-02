/// <reference types="chrome"/>
import { DRIVE_EVENT, EVT } from "../../types.ts";
import type {
  BBox,
  ContentToPanel,
  ListingRow,
  RelayDown,
  RelayUp,
  SearchStatus,
} from "../../types.ts";
import {
  beginDraw,
  cancelDraw,
  clearZone,
  getCurrentShape,
  initGeofenceOverlay,
  setOnDrawStateChange,
  setOnZoneChange,
  setOverlayVisible,
  showZone,
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
      const p = msg.payload;
      if (p.type === "clear_zone") clearZone();
      else if (p.type === "begin_draw") beginDraw();
      else if (p.type === "cancel_draw") cancelDraw();
      else if (p.type === "show_zone") showZone(p.shape);
      else if (p.type === "drive_viewport") {
        document.dispatchEvent(
          new CustomEvent(DRIVE_EVENT, { detail: { bbox: p.bbox } }),
        );
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
  emit({ type: "zone", shape: getCurrentShape() });
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
  emit({ type: "zone", shape: getCurrentShape() });
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
setOnZoneChange((shape) => emit({ type: "zone", shape }));
setOnDrawStateChange((drawing) => emit({ type: "draw_state", drawing }));
initGeofenceOverlay();
