/// <reference types="chrome"/>
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
// deno-lint-ignore-file no-explicit-any
// @ts-ignore - CSS imported as text string via esbuild npm-css-text plugin
import leafletCss from "leaflet/dist/leaflet.css";
// @ts-ignore - CSS imported as text string via esbuild npm-css-text plugin
import geomanCss from "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import type { BBox } from "../types.ts";

// Callback registered by relay.ts so zone changes propagate through the
// shared "relay" port instead of the legacy broadcast mechanism.
let onZoneChange: ((polygon: [number, number][] | null) => void) | null = null;
export function setOnZoneChange(
  fn: (polygon: [number, number][] | null) => void,
): void {
  onZoneChange = fn;
}

let leafletMap: L.Map | null = null;
let drawnLayer: L.Polygon | null = null;
let drawBtn: HTMLButtonElement | null = null;
let clearBtn: HTMLButtonElement | null = null;
let overlayEl: HTMLElement | null = null;

// ─── In-progress draw state ───────────────────────────────────────────────────
// The zone is drawn by click-to-place rather than Geoman's draw mode. Geoman's
// draw needs the overlay to capture every pointer event, which blocks the map.
// Here the overlay stays pointer-events:none throughout, so drags and scrolls
// fall straight through - the map pans and zooms freely while drawing - and
// vertices are placed from a document-level click listener (a click never
// fires at the end of a pan-drag).
let drawing = false;
let draftPts: L.LatLng[] = [];
let draftShape: L.Polyline | null = null; // placed points
let draftHint: L.Polyline | null = null; // rubber-band from last point to cursor
let draftStartDot: L.CircleMarker | null = null; // click-to-close affordance
let mouseDownAt: { x: number; y: number } | null = null;

// Set by the panel: pulse the draw button while the Zone tab is open with no
// zone yet. `buttonState` is tracked so the pulse only shows in the idle state.
let promptActive = false;
let buttonState: "idle" | "drawing" | "active" = "idle";

function injectStyles(): void {
  if (document.getElementById("seelevel-leaflet-css")) return;
  const style = document.createElement("style");
  style.id = "seelevel-leaflet-css";
  style.textContent = leafletCss + "\n" + geomanCss +
    "\n#seelevel-leaflet-overlay.leaflet-container { background: transparent !important; }" +
    // Leaflet's own rule `.leaflet-pane > svg path.leaflet-interactive` forces
    // pointer-events:auto back onto the polygon path, overriding the pane. Kill
    // it: the polygon must NEVER capture events so pan/zoom passes through to
    // Google Maps. Geoman's vertex handles are div markers in markerPane (not
    // paths), so polygon editing is unaffected.
    "\n#seelevel-leaflet-overlay .leaflet-overlay-pane svg path" +
    " { pointer-events: none !important; cursor: inherit !important; }" +
    // Attention pulse for the draw button when a zone is expected but missing.
    "\n@keyframes seelevel-zone-pulse {" +
    " 0%,100% { box-shadow: 0 1px 5px rgba(0,0,0,.15); }" +
    " 50% { box-shadow: 0 0 0 5px rgba(255,194,102,.6), 0 1px 6px rgba(0,0,0,.25); } }" +
    "\n#seelevel-draw-wrap .seelevel-draw-btn--prompt {" +
    " animation: seelevel-zone-pulse 1.2s ease-in-out infinite;" +
    " border-color: #ffc266 !important; }";
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
  if (drawing) endDraw(false); // cancel any in-progress draw first
  if (drawnLayer) {
    leafletMap?.removeLayer(drawnLayer);
    drawnLayer = null;
  }
  setButtonState("idle");
  setInteractivePanes(false);
  onZoneChange?.(null);
}

// Pulse the draw button only when the panel asked for it AND no zone exists
// (idle state) - never mid-draw or while a zone is already drawn.
function refreshPrompt(): void {
  drawBtn?.classList.toggle(
    "seelevel-draw-btn--prompt",
    promptActive && buttonState === "idle",
  );
}

function setButtonState(state: "idle" | "drawing" | "active"): void {
  buttonState = state;
  if (!drawBtn || !clearBtn) return;
  if (state === "idle") {
    drawBtn.textContent = "⬡ Draw Zone";
    drawBtn.className = "seelevel-draw-btn";
    clearBtn.style.display = "none";
  } else if (state === "drawing") {
    drawBtn.textContent = "✕ Cancel";
    drawBtn.className = "seelevel-draw-btn seelevel-draw-btn--drawing";
    clearBtn.style.display = "none";
  } else {
    drawBtn.textContent = "⬡ Redraw";
    drawBtn.className = "seelevel-draw-btn seelevel-draw-btn--active";
    clearBtn.style.display = "block";
  }
  refreshPrompt();
}

// Called from the relay when the panel's Zone tab opens/closes without a zone.
export function setDrawPrompt(active: boolean): void {
  promptActive = active;
  refreshPrompt();
}

function buildButtons(container: HTMLElement): void {
  const wrap = document.createElement("div");
  wrap.id = "seelevel-draw-wrap";
  // Bottom-right, just above Google's Layers + Street View controls, and
  // right-aligned with them (their right edge sits ~4px off the map edge).
  wrap.style.cssText =
    "position:absolute;right:4px;bottom:125px;z-index:2;display:flex;gap:4px;";

  drawBtn = document.createElement("button");
  drawBtn.className = "seelevel-draw-btn";
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
    // While drawing: finish if the polygon has enough points, else cancel.
    if (drawing) endDraw(draftPts.length >= 3);
    else startDraw();
  });

  clearBtn.addEventListener("click", clearZone);

  // ✕ delete sits to the LEFT of the draw/redraw button.
  wrap.appendChild(clearBtn);
  wrap.appendChild(drawBtn);
  container.appendChild(wrap);
}

// ─── Click-to-place draw ──────────────────────────────────────────────────────

function startDraw(): void {
  clearZone(); // remove any existing polygon
  drawing = true;
  draftPts = [];
  mouseDownAt = null;
  setButtonState("drawing");
  document.addEventListener("mousedown", onDraftDown, true);
  document.addEventListener("click", onDraftClick, true);
  document.addEventListener("mousemove", onDraftMove, true);
  document.addEventListener("keydown", onDraftKey, true);
  // Suppress click/dblclick/contextmenu that land over the map so Google
  // Maps' marker popups, double-click zoom and context menu don't fire while
  // drawing. mousedown/move/wheel pass through, so pan, drag and scroll-wheel
  // zoom still work normally.
  document.addEventListener("dblclick", onSuppressOverMap, true);
  document.addEventListener("contextmenu", onSuppressOverMap, true);
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

  for (const layer of [draftShape, draftHint, draftStartDot]) {
    if (layer) leafletMap?.removeLayer(layer);
  }
  draftShape = draftHint = draftStartDot = null;
  const pts = draftPts;
  draftPts = [];

  if (commit && pts.length >= 3 && leafletMap) {
    const poly = L.polygon(pts);
    poly.addTo(leafletMap);
    onPolygonCreated(poly);
  } else {
    setButtonState(drawnLayer ? "active" : "idle");
  }
}

// Is the event over the map proper - not a control or our own buttons, and not
// while the overlay is hidden mid-zoom (when the view would be stale)?
function overMap(e: MouseEvent): boolean {
  if (!overlayEl || overlayEl.style.visibility === "hidden") return false;
  const t = e.target as Element | null;
  if (
    t && typeof t.closest === "function" &&
    t.closest("#seelevel-draw-wrap, .gmnoprint, .gm-style-cc")
  ) return false;
  const r = overlayEl.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right &&
    e.clientY >= r.top && e.clientY <= r.bottom;
}

function onDraftDown(e: MouseEvent): void {
  mouseDownAt = { x: e.clientX, y: e.clientY };
}

function onDraftMove(e: MouseEvent): void {
  if (!leafletMap || draftPts.length === 0 || !overMap(e)) return;
  redrawDraft(
    leafletMap.containerPointToLatLng(leafletMap.mouseEventToContainerPoint(e)),
  );
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

  if (drawBtn) {
    drawBtn.textContent = draftPts.length >= 3 ? "✓ Finish" : "✕ Cancel";
  }
}

function onPolygonCreated(layer: L.Polygon): void {
  drawnLayer = layer;
  setButtonState("active");

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
    const polygon: [number, number][] = latlngs.map((p) => [p.lat, p.lng]);
    onZoneChange?.(polygon);
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

  buildButtons(mapContainer);
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

export function getCurrentPolygon(): [number, number][] | null {
  if (!drawnLayer) return null;
  return (drawnLayer.getLatLngs()[0] as L.LatLng[]).map((p) => [p.lat, p.lng]);
}

// Programmatically render a zone polygon (parity harness drive_zone). Reuses
// onPolygonCreated so the synced zone behaves exactly like a hand-drawn one —
// styled, editable, and propagated to the panel via onZoneChange.
export function setZone(polygon: [number, number][]): void {
  if (!leafletMap || polygon.length < 3) return;
  if (drawing) endDraw(false);
  if (drawnLayer) {
    leafletMap.removeLayer(drawnLayer);
    drawnLayer = null;
  }
  const poly = L.polygon(
    polygon.map(([lat, lng]) => [lat, lng] as L.LatLngTuple),
  );
  poly.addTo(leafletMap);
  onPolygonCreated(poly);
}

// Coverage % is shown in the side panel - no map overlay rectangles needed.
// deno-lint-ignore no-unused-vars
export function updateCoverageOverlay(_fetchedBboxes: BBox[]): void {}
