/// <reference types="chrome"/>
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
// deno-lint-ignore-file no-explicit-any
// @ts-ignore - CSS imported as text string via esbuild npm-css-text plugin
import leafletCss from "leaflet/dist/leaflet.css";
// @ts-ignore - CSS imported as text string via esbuild npm-css-text plugin
import geomanCss from "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import type { BBox, ZoneShape } from "../types.ts";

// Callback registered by relay.ts so zone changes propagate through the
// shared "relay" port instead of the legacy broadcast mechanism.
let onZoneChange: ((shape: ZoneShape | null) => void) | null = null;
export function setOnZoneChange(
  fn: (shape: ZoneShape | null) => void,
): void {
  onZoneChange = fn;
}

let onDrawStateChange: ((drawing: boolean) => void) | null = null;
export function setOnDrawStateChange(fn: (drawing: boolean) => void): void {
  onDrawStateChange = fn;
}

let leafletMap: L.Map | null = null;
let drawnLayer: L.Polygon | null = null; // editable custom-draw layer
let regionLayers: L.Polygon[] = []; // non-editable rendered region parts
let currentShape: ZoneShape | null = null; // the active zone (custom or region)
let overlayEl: HTMLElement | null = null;
let hintEl: HTMLElement | null = null;

// ─── In-progress draw state ───────────────────────────────────────────────
let drawing = false;
let draftPts: L.LatLng[] = [];
let draftShape: L.Polyline | null = null;
let draftHint: L.Polyline | null = null;
let draftStartDot: L.CircleMarker | null = null;
let cursorDot: L.CircleMarker | null = null; // follows the mouse from draw start
let mouseDownAt: { x: number; y: number } | null = null;

function injectStyles(): void {
  if (document.getElementById("seelevel-leaflet-css")) return;
  const style = document.createElement("style");
  style.id = "seelevel-leaflet-css";
  style.textContent = leafletCss + "\n" + geomanCss +
    "\n#seelevel-leaflet-overlay.leaflet-container { background: transparent !important; }" +
    "\n#seelevel-leaflet-overlay .leaflet-overlay-pane svg path" +
    " { pointer-events: none !important; cursor: inherit !important; }";
  document.head.appendChild(style);
}

function setInteractivePanes(active: boolean): void {
  if (!leafletMap) return;
  // The overlay pane (polygon fill/stroke - it spans the whole map) is ALWAYS
  // non-interactive, so pan, zoom and control clicks pass straight through to
  // Google Maps. Only the marker pane (geoman vertex-edit handles) toggles, so
  // vertices stay draggable while everything between them is click-through.
  (leafletMap.getPane("overlayPane") as HTMLElement | undefined)
    ?.style.setProperty("pointer-events", "none");
  (leafletMap.getPane("markerPane") as HTMLElement | undefined)
    ?.style.setProperty("pointer-events", active ? "auto" : "none");
}

export function clearZone(): void {
  if (drawing) endDraw(false);
  if (drawnLayer) {
    leafletMap?.removeLayer(drawnLayer);
    drawnLayer = null;
  }
  for (const lyr of regionLayers) leafletMap?.removeLayer(lyr);
  regionLayers = [];
  currentShape = null;
  setInteractivePanes(false);
  onZoneChange?.(null);
}

// Faint on-map instruction banner shown only while drawing.
function showHint(): void {
  if (!overlayEl || hintEl) return;
  hintEl = document.createElement("div");
  hintEl.id = "seelevel-draw-hint";
  hintEl.textContent =
    "Click to add points · click the first point to close · Esc to cancel";
  hintEl.style.cssText =
    "position:absolute;left:50%;top:8px;transform:translateX(-50%);z-index:3;" +
    "pointer-events:none;background:rgba(0,0,0,.62);color:#fff;font-size:10px;" +
    "font-weight:600;padding:4px 9px;border-radius:6px;white-space:nowrap;";
  overlayEl.parentElement?.appendChild(hintEl);
}
function hideHint(): void {
  if (hintEl) {
    hintEl.remove();
    hintEl = null;
  }
}

// ─── Click-to-place draw ──────────────────────────────────────────────────────

export function beginDraw(): void {
  clearZone();
  drawing = true;
  draftPts = [];
  mouseDownAt = null;
  showHint();
  document.addEventListener("mousedown", onDraftDown, true);
  document.addEventListener("click", onDraftClick, true);
  document.addEventListener("mousemove", onDraftMove, true);
  document.addEventListener("keydown", onDraftKey, true);
  document.addEventListener("dblclick", onSuppressOverMap, true);
  document.addEventListener("contextmenu", onSuppressOverMap, true);
  onDrawStateChange?.(true);
}

export function cancelDraw(): void {
  if (drawing) endDraw(false);
}

function endDraw(commit: boolean): void {
  if (!drawing) return;
  drawing = false;
  document.removeEventListener("mousedown", onDraftDown, true);
  document.removeEventListener("click", onDraftClick, true);
  document.removeEventListener("mousemove", onDraftMove, true);
  document.removeEventListener("keydown", onDraftKey, true);
  document.removeEventListener("dblclick", onSuppressOverMap, true);
  document.removeEventListener("contextmenu", onSuppressOverMap, true);
  mouseDownAt = null;
  hideHint();

  for (const layer of [draftShape, draftHint, draftStartDot, cursorDot]) {
    if (layer) leafletMap?.removeLayer(layer);
  }
  draftShape =
    draftHint =
    draftStartDot =
    cursorDot =
      null;
  const pts = draftPts;
  draftPts = [];

  if (commit && pts.length >= 3 && leafletMap) {
    const poly = L.polygon(pts);
    poly.addTo(leafletMap);
    onPolygonCreated(poly);
  }
  onDrawStateChange?.(false);
}

// Is the event over the map proper - not a control or our own buttons, and not
// while the overlay is hidden mid-zoom (when the view would be stale)?
function overMap(e: MouseEvent): boolean {
  if (!overlayEl || overlayEl.style.visibility === "hidden") return false;
  const t = e.target as Element | null;
  if (
    t && typeof t.closest === "function" &&
    t.closest(".gmnoprint, .gm-style-cc")
  ) return false;
  const r = overlayEl.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right &&
    e.clientY >= r.top && e.clientY <= r.bottom;
}

function onDraftDown(e: MouseEvent): void {
  mouseDownAt = { x: e.clientX, y: e.clientY };
}

function onDraftMove(e: MouseEvent): void {
  if (!leafletMap || !overMap(e)) return;
  const at = leafletMap.containerPointToLatLng(
    leafletMap.mouseEventToContainerPoint(e),
  );
  if (cursorDot) cursorDot.setLatLng(at);
  else {
    cursorDot = L.circleMarker(at, {
      radius: 4,
      color: "#ffc266",
      fillColor: "#ffc266",
      fillOpacity: 0.9,
      weight: 1,
    }).addTo(leafletMap);
  }
  if (draftPts.length > 0) redrawDraft(at);
}

function onSuppressOverMap(e: Event): void {
  if (!overMap(e as MouseEvent)) return;
  e.stopPropagation();
  e.preventDefault();
}

function onDraftClick(e: MouseEvent): void {
  if (!leafletMap || !overMap(e)) return;
  // Over the map area: suppress propagation in EVERY path (vertex placement,
  // pan-drag-end, duplicate-tap) so Google Maps' click handlers — marker
  // popups, listing-cluster expansion, etc. — never fire while drawing.
  e.stopPropagation();
  e.preventDefault();
  // A click also fires at the end of a pan-drag - ignore it so panning the map
  // mid-draw never drops a stray vertex.
  if (mouseDownAt) {
    const moved = Math.hypot(
      e.clientX - mouseDownAt.x,
      e.clientY - mouseDownAt.y,
    );
    mouseDownAt = null;
    if (moved > 6) return;
  }
  const cp = leafletMap.mouseEventToContainerPoint(e);
  // Clicking on/near the first point closes the polygon.
  if (
    draftPts.length >= 3 &&
    cp.distanceTo(leafletMap.latLngToContainerPoint(draftPts[0])) <= 14
  ) {
    endDraw(true);
    return;
  }
  // Drop an accidental duplicate (e.g. the 2nd tap of a double-click zoom).
  if (
    draftPts.length > 0 &&
    cp.distanceTo(
        leafletMap.latLngToContainerPoint(draftPts[draftPts.length - 1]),
      ) <= 6
  ) {
    return;
  }
  draftPts.push(leafletMap.containerPointToLatLng(cp));
  redrawDraft();
}

function onDraftKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    endDraw(false);
  } else if (e.key === "Enter") {
    endDraw(draftPts.length >= 3);
  } else if (
    (e.key === "Backspace" || e.key === "Delete") && draftPts.length > 0
  ) {
    draftPts.pop();
    if (draftHint) {
      leafletMap?.removeLayer(draftHint);
      draftHint = null;
    }
    redrawDraft();
  }
}

// Repaint the in-progress outline, the start-point dot, and (if a cursor
// position is given) the rubber-band hint segment to it.
function redrawDraft(cursor?: L.LatLng): void {
  if (!leafletMap) return;

  if (draftShape) draftShape.setLatLngs(draftPts);
  else if (draftPts.length > 0) {
    draftShape = L.polyline(draftPts, {
      color: "#ffc266",
      weight: 2,
      dashArray: "5,3",
    })
      .addTo(leafletMap);
  }

  if (draftPts.length > 0) {
    if (draftStartDot) draftStartDot.setLatLng(draftPts[0]);
    else {
      draftStartDot = L.circleMarker(draftPts[0], {
        radius: 5,
        color: "#ffc266",
        fillColor: "#fff",
        fillOpacity: 1,
        weight: 2,
      }).addTo(leafletMap);
    }
  }

  if (cursor && draftPts.length > 0) {
    const seg: L.LatLngExpression[] = [draftPts[draftPts.length - 1], cursor];
    if (draftHint) draftHint.setLatLngs(seg);
    else {
      draftHint = L.polyline(seg, {
        color: "#ffc266",
        weight: 1.5,
        opacity: 0.5,
        dashArray: "4,4",
      }).addTo(leafletMap);
    }
  }
}

function onPolygonCreated(layer: L.Polygon): void {
  drawnLayer = layer;
  layer.setStyle({
    color: "#1f9bbf",
    fillColor: "#1f9bbf",
    fillOpacity: 0.1,
    weight: 1.5,
  });
  layer.pm.enable({ allowSelfIntersection: false });
  setInteractivePanes(true);

  const updateZone = () => {
    const latlngs = layer.getLatLngs()[0] as L.LatLng[];
    const outer: [number, number][] = latlngs.map((p) => [p.lat, p.lng]);
    currentShape = [{ outer, holes: [] }];
    onZoneChange?.(currentShape);
  };
  updateZone();
  layer.on("pm:edit", updateZone);
  layer.on("pm:vertexadded", updateZone);
  layer.on("pm:vertexremoved", updateZone);
}

function initLeafletOverlay(mapContainer: HTMLElement): void {
  injectStyles();

  const overlayDiv = document.createElement("div");
  overlayDiv.id = "seelevel-leaflet-overlay";
  // z-index:1 - the lowest value that still paints above Google's `.gm-style`
  // stacking context (z-index:0). pointer-events:none is permanent: the overlay
  // never captures, so pan/zoom always reach Google Maps - including mid-draw,
  // where vertices are placed from a document-level click listener instead.
  overlayDiv.style.cssText =
    "position:absolute;inset:0;z-index:1;pointer-events:none;background:transparent;";
  mapContainer.style.position = "relative";
  mapContainer.appendChild(overlayDiv);
  overlayEl = overlayDiv;

  leafletMap = L.map(overlayDiv, {
    zoomControl: false,
    attributionControl: false,
    doubleClickZoom: false,
    dragging: false,
    scrollWheelZoom: false,
    touchZoom: false,
    keyboard: false,
    zoomSnap: 0, // allow fractional zoom to match Google Maps exactly
    zoomDelta: 0.1, // fine-grained zoom control (irrelevant since zoom is driven externally)
  }).setView([45.2, -63.0], 8);

  // Keep Leaflet's cached container size fresh - a stale size is the classic
  // cause of overlay drift after the side panel opens or the window resizes.
  new ResizeObserver(() => leafletMap?.invalidateSize()).observe(mapContainer);

  leafletMap.pm.setGlobalOptions({ allowSelfIntersection: false });
}

export function initGeofenceOverlay(): void {
  const check = () => {
    const mapEl = document.getElementById("map") ??
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

// Called from relay with live Google Maps bounds (optionally center+zoom for precision)
export function syncMapView(
  swLat: number,
  swLng: number,
  neLat: number,
  neLng: number,
  centerLat?: number,
  centerLng?: number,
  zoom?: number,
): void {
  if (!leafletMap) return;
  if (
    centerLat !== undefined && centerLng !== undefined && zoom !== undefined
  ) {
    // Exact match with Google Maps zoom level - avoids integer-rounding drift
    leafletMap.setView([centerLat, centerLng], zoom, { animate: false });
  } else {
    leafletMap.fitBounds([[swLat, swLng], [neLat, neLng]], { animate: false });
  }
}

// Hide/show the polygon overlay - used to mask Google Maps zoom animations,
// during which the Leaflet view cannot be tracked frame-by-frame.
export function setOverlayVisible(visible: boolean): void {
  if (overlayEl) overlayEl.style.visibility = visible ? "visible" : "hidden";
}

export function getCurrentShape(): ZoneShape | null {
  return currentShape;
}

// Render a predefined region: one non-editable Leaflet polygon per part (with
// holes). Replaces any existing zone and becomes the current shape.
export function showZone(shape: ZoneShape): void {
  if (!leafletMap || shape.length === 0) return;
  clearZone();
  for (const part of shape) {
    const rings: L.LatLngExpression[][] = [
      part.outer.map(([lat, lng]) => [lat, lng]),
      ...part.holes.map((h) => h.map(([lat, lng]) => [lat, lng])),
    ];
    const poly = L.polygon(rings, {
      color: "#1f9bbf",
      fillColor: "#1f9bbf",
      fillOpacity: 0.1,
      weight: 1.5,
    });
    poly.addTo(leafletMap);
    regionLayers.push(poly);
  }
  currentShape = shape;
  onZoneChange?.(shape);
}

// Coverage % is shown in the side panel - no map overlay rectangles needed.
// deno-lint-ignore no-unused-vars
export function updateCoverageOverlay(_fetchedBboxes: BBox[]): void {}
