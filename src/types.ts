// Mirrors scrapers/viewpoint/types.ts - kept in sync by hand

export type SearchStatus = "any" | "active" | "sold";
// "search" = a geographic search whose result IS the viewport; "global" = a
// province-wide dataset (new today / top listings) the viewport bbox-filters.
export type ListingKind = "search" | "global";
export type MetricKey = "price" | "volume" | "dom" | "ppsf" | "listToSold";
export type ScopeKey = "viewport" | "session" | "zone";
export type WindowSize = "weekly" | "monthly" | "yearly";
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
  tla: number | null; // total living area (sqft)
  pid: string | null;
  lat: number | null; // resolved from paired PropertyRow
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
  searchUrl: string; // full URL including bbox + status params
}

// deno-lint-ignore no-explicit-any
export type RawListing = Record<string, any>;
// deno-lint-ignore no-explicit-any
export type RawProperty = Record<string, any>;

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
  | { type: "clear_session" }
  | { type: "oversize_bbox"; bbox: BBox; count: number }
  | { type: "loading_state"; loading: boolean };

// Messages from side panel → content scripts (semantic payloads, wrapped in
// a PanelUp envelope by the panel before delivery to the SW broker).
export type PanelToContent =
  | { type: "clear_zone" }
  | { type: "zone_prompt"; active: boolean }
  // Dev-only (parity harness): drive the page's map / zone. Only ever SENT by
  // the __DEV__-gated panel hooks and only HANDLED by __DEV__-gated relay code,
  // so --prod strips every producer and consumer even though the type remains.
  | { type: "drive_viewport"; bbox: BBox }
  | { type: "drive_zone"; polygon: [number, number][] };

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
  | { type: "tab_meta"; tabId: number; host: string }
  | { type: "msg"; tabId: number; payload: ContentToPanel };

// Per-tab state in the side panel (in Preact memory only, never persisted).
// `session` accumulates every listing seen since the last ViewPoint mode switch.
// `zone` = session within `polygon`. `viewport` = the verbatim search result in
// search mode (`viewportListings`), otherwise session within `viewportBbox`.
export interface TabStore {
  tabId: number;
  session: ListingRow[]; // master list - accumulates across pans & searches
  viewportListings: ListingRow[] | null; // verbatim search result (search mode); null otherwise
  viewportBbox: BBox | null; // live map bounds - filters session for non-search modes
  fetchedBboxes: BBox[]; // accumulated request bounds - for zone coverage
  polygon: [number, number][] | null; // the drawn zone - the zone filter
  scope: ScopeKey;
  searchStatus: SearchStatus; // last explicit search filter - hides the irrelevant series
  windowSize: WindowSize;
  alignmentMode: AlignmentMode;
  anchorDayOfWeek: number; // 0=Sun … 6=Sat; default 1=Mon
  anchorDayOfMonth: number; // 1-31; default 1
  // EV adapter oversize state: when the most recent slim sibling reports
  // count > 2000, oversizeBbox/Count are populated and viewportListings is
  // cleared. Reset by any successful "listings" payload or clear_session.
  oversizeBbox: BBox | null;
  oversizeCount: number | null;
  // Slim sibling in flight — drives the panel's spinner.
  loading: boolean;
  // The host of the tab's content-script sender (e.g. "viewpoint.ca").
  // Null until the SW sends a tab_meta envelope for this tab.
  host: string | null;
}

export function defaultTabStore(tabId: number): TabStore {
  return {
    tabId,
    session: [],
    viewportListings: null,
    viewportBbox: null,
    fetchedBboxes: [],
    polygon: null,
    scope: "viewport",
    searchStatus: "any",
    windowSize: "monthly",
    alignmentMode: "today",
    anchorDayOfWeek: 1,
    anchorDayOfMonth: 1,
    oversizeBbox: null,
    oversizeCount: null,
    loading: false,
    host: null,
  };
}

// Wire protocol event names — MAIN ↔ ISOLATED via document CustomEvent.
// Adapter-agnostic; ViewPoint and Engel & Völkers adapters both use them.
// Detail shapes are adapter-specific (see each adapter's main/relay pair).
export const EVT = {
  listings: "seelevel:listings",
  bbox: "seelevel:bbox",
  mapbusy: "seelevel:mapbusy",
  oversize: "seelevel:oversize",
  clearSession: "seelevel:clear-session",
  loadingState: "seelevel:loading-state",
} as const;

// Dev-only (parity harness) ISOLATED→MAIN drive event name. A standalone export
// (not an EVT property) so esbuild tree-shakes it out of --prod entirely once
// the only references — all inside __DEV__ blocks — are dead-code-eliminated.
export const DRIVE_EVENT = "seelevel:drive";
