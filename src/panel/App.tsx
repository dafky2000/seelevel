import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type {
  MetricKey,
  PanelDown,
  PanelToContent,
  PanelUp,
  RegionRecord,
  TabStore,
} from "../types.ts";
import {
  defaultTabStore,
  mergeListings,
  resolveCoordinates,
  scopedListings,
} from "./store.ts";
import { availableWindowSizes, buildBuckets } from "./lib/bucket.ts";
import { aggregate } from "./lib/aggregate.ts";
import {
  computeZoneCoverage,
  reseedCoverage,
  zoneSignature,
} from "./lib/coverage.ts";
import { EulaGate } from "./components/EulaGate.tsx";
import { ScopeSelector } from "./components/ScopeSelector.tsx";
import { WindowPicker } from "./components/WindowPicker.tsx";
import { StatsRow } from "./components/StatsRow.tsx";
import { TimeSeriesChart } from "./components/TimeSeriesChart.tsx";
import { PriceHistogramChart } from "./components/PriceHistogramChart.tsx";
import { priceHistogram } from "./lib/histogram.ts";
import type { PriceHistogram } from "./lib/histogram.ts";
import { ZoneCoverage } from "./components/ZoneCoverage.tsx";
import { ZonePanel } from "./components/ZonePanel.tsx";
import { ExportButton } from "./components/ExportButton.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { Disclaimer } from "./components/Disclaimer.tsx";
import { OversizeNotice } from "./components/OversizeNotice.tsx";
import { Spinner } from "./components/Spinner.tsx";
import type { AggregateSummary, SeriesSide } from "./lib/aggregate.ts";
import { buildFigures } from "./lib/parity.ts";
import type { ParitySnapshot } from "./lib/parity.ts";

declare const __DEV__: boolean;

// Every metric is shown at once, stacked into one scrolling list - no tabs.
const METRICS: { key: MetricKey; label: string }[] = [
  { key: "price", label: "Price" },
  { key: "volume", label: "Volume" },
  { key: "dom", label: "Days on Market" },
  { key: "ppsf", label: "Price / sqft" },
  { key: "listToSold", label: "List → Sold %" },
];

interface MetricSection {
  metric: MetricKey;
  label: string;
  summary: AggregateSummary;
}

// Outer ring of a single-part, hole-less zone (a custom draw) — used only to
// keep the dev parity snapshot's single-ring `polygon` field populated.
function zoneOuterRing(zone: TabStore["zone"]): [number, number][] | null {
  if (zone && zone.length === 1 && zone[0].holes.length === 0) {
    return zone[0].outer;
  }
  return null;
}

// Build a ParitySnapshot for one tab's store — mirrors the panel's own
// scope/window/side selection so the snapshot matches what's on screen.
function buildSnapshot(store: TabStore): ParitySnapshot {
  const visible = scopedListings(store);
  const buckets = buildBuckets(
    new Date(),
    store.windowSize,
    store.alignmentMode,
    store.anchorDayOfWeek,
    store.anchorDayOfMonth,
  );
  // Array form of the render path's `side` (which wraps as `side ? [side]
  // : null` at its priceHistogram call) — buildFigures takes SeriesSide[].
  const side: SeriesSide[] | null = store.searchStatus === "active"
    ? ["list"]
    : store.searchStatus === "sold"
    ? ["sold"]
    : null;
  return {
    tabId: store.tabId,
    host: store.host,
    scope: store.scope,
    searchStatus: store.searchStatus,
    windowSize: store.windowSize,
    loading: store.loading,
    bbox: store.viewportBbox,
    polygon: zoneOuterRing(store.zone),
    figures: buildFigures(visible, buckets, side),
  };
}

function App() {
  // Per-mount only; deliberately not persisted so we don't need `storage`.
  const [eulaAcknowledged, setEulaAcknowledged] = useState(false);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const tabStores = useRef<Map<number, TabStore>>(new Map());
  const [store, setStore] = useState<TabStore | null>(null);
  const [sections, setSections] = useState<MetricSection[] | null>(null);
  // Price distribution for the most recent complete window (null = no data).
  const [priceHist, setPriceHist] = useState<
    { hist: PriceHistogram; label: string } | null
  >(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  // activeTabId mirrored into a ref so the (mount-once) port message handler
  // can read its current value without re-subscribing on every tab switch.
  const activeTabIdRef = useRef<number | null>(null);

  // Detect active tab changes
  useEffect(() => {
    function onActivated(info: chrome.tabs.OnActivatedInfo) {
      setActiveTabId(info.tabId);
    }
    chrome.tabs.onActivated.addListener(onActivated);
    // Get current active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) setActiveTabId(tabs[0].id);
    });
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, []);

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
  // panel_opened to every relay on this connection. Auto-reconnects if the
  // service worker is terminated by Chrome (memory pressure, extension
  // reload) - the new SW.onConnect re-broadcasts panel_opened to every
  // relay, so state catches up automatically.
  useEffect(() => {
    let reconnectTimer: number | undefined;
    let reconnectDelay = 1000;
    let cancelled = false;

    function onMessage(msg: PanelDown) {
      // Any inbound message means the connection is bidirectionally working;
      // reset the backoff so a future SW restart starts at 1s.
      reconnectDelay = 1000;
      if (msg.type === "tab_loaded") {
        // SW saw a relay port (re)connect - reset our view of that tab.
        tabStores.current.set(msg.tabId, defaultTabStore(msg.tabId));
        if (msg.tabId === activeTabIdRef.current) {
          setStore({ ...tabStores.current.get(msg.tabId)! });
        }
        return;
      }
      if (msg.type === "tab_meta") {
        const existing = tabStores.current.get(msg.tabId) ??
          defaultTabStore(msg.tabId);
        existing.host = msg.host;
        tabStores.current.set(msg.tabId, existing);
        if (msg.tabId === activeTabIdRef.current) {
          setStore({ ...existing });
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
        s.oversizeBbox = null;
        s.oversizeCount = null;
      }

      if (payload.type === "listings") {
        const resolved = resolveCoordinates(
          payload.listings,
          payload.properties,
        );
        s.session = mergeListings(s.session, resolved);
        s.viewportListings = payload.kind === "search" ? resolved : null;
        if (payload.kind === "search") s.searchStatus = payload.status;
        if (payload.bbox) s.fetchedBboxes = [...s.fetchedBboxes, payload.bbox];
        // A successful fetch supersedes any prior oversize state.
        s.oversizeBbox = null;
        s.oversizeCount = null;
        s.loading = false;
      }

      if (payload.type === "viewport_bbox") {
        s.viewportBbox = payload.bbox;
      }

      if (payload.type === "zone") {
        // Keep the active zone in sync with the overlay (custom-draw edits and
        // region renders both arrive here). Adopt zone scope when a zone first
        // appears; scope is otherwise driven explicitly by the ScopeSelector and
        // the ZonePanel reset/clear actions, so a null re-send never changes it.
        const isNewZone = !!payload.shape && !s.zone;
        // The relay re-sends the same zone on every listings tick; only a
        // genuine shape change reseeds coverage, so accumulated fetch bboxes
        // survive re-sends. Region picks reseed at their call site below.
        const shapeChanged =
          zoneSignature(payload.shape) !== zoneSignature(s.zone);
        s.zone = payload.shape;
        if (isNewZone) s.scope = "zone";
        if (shapeChanged) {
          s.fetchedBboxes = payload.shape
            ? reseedCoverage(s.session, payload.shape, s.viewportBbox)
            : [];
        }
      }

      if (payload.type === "draw_state") {
        s.drawing = payload.drawing;
      }

      if (payload.type === "oversize_bbox") {
        // Oversize bbox: discard rows we never fetched, but preserve session +
        // fetchedBboxes (they're earlier successful fetches, still valid).
        // Clear viewportListings — its prior verbatim rows are stale for the new
        // wider bbox and would mis-count the header chip otherwise.
        s.oversizeBbox = payload.bbox;
        s.oversizeCount = payload.count;
        s.viewportListings = null;
        s.loading = false;
      }

      if (payload.type === "loading_state") {
        s.loading = payload.loading;
      }

      if (tabId === activeTabIdRef.current) {
        setStore({ ...s });
      }
    }

    function open() {
      if (cancelled) return;
      const port = chrome.runtime.connect({ name: "panel" });
      portRef.current = port;
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        // SW may have been terminated. Reconnect; SW.onConnect will
        // re-broadcast panel_opened to every relay so they re-emit state.
        if (cancelled) return;
        reconnectTimer = setTimeout(() => {
          // Preemptively double; onMessage will reset to 1s if reconnect
          // proves itself. Cap at 30s.
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          open();
        }, reconnectDelay);
      });
    }

    open();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

  // Send a panel→content payload through the SW broker to a specific tab.
  const postToRelay = useCallback((tabId: number, payload: PanelToContent) => {
    const port = portRef.current;
    if (!port) return;
    try {
      port.postMessage({ type: "msg", tabId, payload } satisfies PanelUp);
    } catch { /* port disconnected */ }
  }, []);

  // Dev-only parity harness: expose capture + sync hooks on the panel window.
  // The whole block is gated so --prod (__DEV__ === false) strips it entirely.
  useEffect(() => {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      const w = window as unknown as {
        __seelevelSnapshot?: () => ParitySnapshot[];
        __seelevelSync?: (
          opts?: {
            from?: number;
            to?: number;
            what?: "viewport" | "zone" | "both";
          },
        ) => unknown;
      };

      w.__seelevelSnapshot = () =>
        Array.from(tabStores.current.values()).map(buildSnapshot);

      w.__seelevelSync = (opts = {}) => {
        const stores = Array.from(tabStores.current.values());
        const find = (kw: string) =>
          stores.find((s) => (s.host ?? "").includes(kw));
        const fromStore = opts.from !== undefined
          ? tabStores.current.get(opts.from)
          : find("viewpoint");
        const toStore = opts.to !== undefined
          ? tabStores.current.get(opts.to)
          : find("engelvoelkers");
        if (!fromStore || !toStore) {
          return {
            error: "need one ViewPoint and one EV tab open (or pass {from,to})",
          };
        }
        const what = opts.what ?? "both";
        const result: Record<string, unknown> = {
          from: fromStore.tabId,
          to: toStore.tabId,
          what,
        };
        if (
          (what === "viewport" || what === "both") && fromStore.viewportBbox
        ) {
          postToRelay(toStore.tabId, {
            type: "drive_viewport",
            bbox: fromStore.viewportBbox,
          });
          result.bbox = fromStore.viewportBbox;
        }
        if ((what === "zone" || what === "both") && fromStore.zone) {
          const ring = zoneOuterRing(fromStore.zone);
          postToRelay(toStore.tabId, {
            type: "drive_viewport",
            bbox: ring
              ? {
                sw_lat: Math.min(...ring.map((p) => p[0])),
                sw_lng: Math.min(...ring.map((p) => p[1])),
                ne_lat: Math.max(...ring.map((p) => p[0])),
                ne_lng: Math.max(...ring.map((p) => p[1])),
              }
              : fromStore.viewportBbox!,
          });
          postToRelay(toStore.tabId, {
            type: "show_zone",
            shape: fromStore.zone,
          });
          result.zone = fromStore.zone;
        }
        return result;
      };

      return () => {
        delete w.__seelevelSnapshot;
        delete w.__seelevelSync;
      };
    }
  }, [postToRelay]);

  // Clean up tab stores when tabs are closed
  useEffect(() => {
    function onRemoved(tabId: number) {
      tabStores.current.delete(tabId);
    }
    chrome.tabs.onRemoved.addListener(onRemoved);
    return () => chrome.tabs.onRemoved.removeListener(onRemoved);
  }, []);

  // Recompute every metric whenever the store changes; auto-switch the window
  // size to the coarsest available one if the current size is no longer offered.
  useEffect(() => {
    if (!store) {
      setSections(null);
      setPriceHist(null);
      return;
    }
    const visible = scopedListings(store);
    if (visible.length === 0) {
      setSections(null);
      setPriceHist(null);
      return;
    }
    const availSizes = availableWindowSizes(visible.length);
    if (!availSizes.includes(store.windowSize)) {
      // Only weekly can fall out of range - drop to monthly (always available).
      updateStore({ windowSize: availSizes[0] });
      return; // updateStore re-renders → this effect re-runs with a valid size
    }
    const buckets = buildBuckets(
      new Date(),
      store.windowSize,
      store.alignmentMode,
      store.anchorDayOfWeek,
      store.anchorDayOfMonth,
    );
    // An explicit "for sale" search shows only listing-side series; an explicit
    // "sold" search only sale-side. A metric left with no relevant series (e.g.
    // DOM under a for-sale search) drops out entirely.
    const side = store.searchStatus === "active"
      ? "list"
      : store.searchStatus === "sold"
      ? "sold"
      : null;
    const sects: MetricSection[] = [];
    for (const m of METRICS) {
      const full = aggregate(visible, m.key, buckets);
      const series = side
        ? full.series.filter((s) => s.side === side)
        : full.series;
      if (series.length > 0) {
        sects.push({ metric: m.key, label: m.label, summary: { series } });
      }
    }
    setSections(sects);

    // Price distribution: bin the most recent complete window (the same period
    // the headline cards summarize), respecting the active/sold side filter.
    const complete = buckets.filter((b) => !b.isPartial);
    const latestBucket = complete.length > 0
      ? complete[complete.length - 1]
      : buckets[buckets.length - 1] ?? null;
    const hist = latestBucket
      ? priceHistogram(visible, latestBucket, side ? [side] : null, 20)
      : null;
    setPriceHist(
      hist && hist.hasData ? { hist, label: latestBucket!.label } : null,
    );
  }, [store]);

  const updateStore = useCallback((patch: Partial<TabStore>) => {
    if (!store || activeTabId === null) return;
    const updated = { ...store, ...patch };
    tabStores.current.set(activeTabId, updated);
    setStore(updated);
  }, [store, activeTabId]);

  if (!eulaAcknowledged) {
    return <EulaGate onAcknowledge={() => setEulaAcknowledged(true)} />;
  }

  const coverage = store?.zone && store.fetchedBboxes.length > 0
    ? computeZoneCoverage(store.fetchedBboxes, store.zone)
    : null;

  const listingCount = store ? scopedListings(store).length : 0;
  const isYearly = store?.windowSize === "yearly";
  // Zone tab selected but nothing drawn - prompt the user instead of falling
  // back to session data.
  const zoneNoPolygon = !!store && store.scope === "zone" && !store.zone;
  const viewportOversize = !!store?.oversizeBbox && store.scope === "viewport";
  const sessionOrZoneOversize = !!store?.oversizeBbox &&
    (store.scope === "session" || store.scope === "zone");
  const showSpinner = !!store && listingCount === 0 && store.loading;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div class="seelevel-section">
        <div class="seelevel-row" style={{ marginBottom: "7px" }}>
          <strong style={{ fontSize: "11px" }}>
            See<span style={{ color: "var(--color-accent)" }}>Level</span>
          </strong>
          {listingCount > 0 && !viewportOversize && (
            <span
              class="seelevel-label"
              style={{
                background: "oklch(30% 0.09 205 / 0.5)",
                padding: "1px 6px",
                borderRadius: "8px",
              }}
            >
              {listingCount} listings
            </span>
          )}
          {sessionOrZoneOversize && (
            <OversizeNotice mode="badge" count={store!.oversizeCount!} />
          )}
          <span
            style={{
              marginLeft: "auto",
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: listingCount > 0
                ? "var(--color-green)"
                : "var(--color-muted)",
              boxShadow: listingCount > 0
                ? "0 0 4px var(--color-green)"
                : "none",
            }}
          />
        </div>
        {store && (
          <>
            <ScopeSelector
              scope={store.scope}
              onScope={(scope) => updateStore({ scope })}
            />
            {store.scope === "zone" && (
              <ZonePanel
                selectedRegionId={store.selectedRegionId}
                drawing={store.drawing}
                hasZone={!!store.zone}
                onSelectRegion={(region: RegionRecord) => {
                  updateStore({
                    zone: region.shape,
                    selectedRegionId: region.id,
                    scope: "zone",
                    // Seed coverage from listings already in session that fall
                    // inside the region (incl. off-screen) plus the current
                    // view, so a freshly picked region isn't stuck at 0%.
                    fetchedBboxes: reseedCoverage(
                      store.session,
                      region.shape,
                      store.viewportBbox,
                    ),
                  });
                  if (activeTabId !== null) {
                    postToRelay(activeTabId, {
                      type: "drive_viewport",
                      bbox: region.bbox,
                    });
                    postToRelay(activeTabId, {
                      type: "show_zone",
                      shape: region.shape,
                    });
                  }
                }}
                onToggleDraw={() => {
                  if (activeTabId === null) return;
                  if (store.drawing) {
                    postToRelay(activeTabId, { type: "cancel_draw" });
                  } else {
                    updateStore({ selectedRegionId: null });
                    postToRelay(activeTabId, { type: "begin_draw" });
                  }
                }}
                onReset={() => {
                  // Stay on the Zone tab after reset - clearing the polygon
                  // drops back to the region picker / draw prompt, not Viewport.
                  updateStore({
                    zone: null,
                    selectedRegionId: null,
                    drawing: false,
                    scope: "zone",
                    fetchedBboxes: [],
                  });
                  if (activeTabId !== null) {
                    postToRelay(activeTabId, { type: "clear_zone" });
                  }
                }}
              />
            )}
            {store.scope === "zone" && coverage !== null && (
              <ZoneCoverage coverage={coverage} count={listingCount} />
            )}
          </>
        )}
      </div>

      {!store
        ? <EmptyState host={null} />
        : viewportOversize
        ? <OversizeNotice mode="block" count={store.oversizeCount!} />
        : zoneNoPolygon
        ? (
          <div class="seelevel-empty">
            <div class="seelevel-empty__icon">⬡</div>
            <div class="seelevel-empty__text">
              No zone yet. Pick a region above, or draw a custom zone — results
              are then filtered to listings inside it.
            </div>
          </div>
        )
        : showSpinner
        ? <Spinner />
        : listingCount === 0
        ? <EmptyState host={store.host} />
        : (
          <>
            <div class="seelevel-section">
              <WindowPicker
                windowSize={store.windowSize}
                alignmentMode={store.alignmentMode}
                anchorDayOfWeek={store.anchorDayOfWeek}
                anchorDayOfMonth={store.anchorDayOfMonth}
                availableSizes={availableWindowSizes(listingCount)}
                onWindowSize={(windowSize) => updateStore({ windowSize })}
                onAlignmentMode={(alignmentMode) =>
                  updateStore({ alignmentMode })}
                onAnchorDow={(dow) => updateStore({ anchorDayOfWeek: dow })}
                onAnchorDom={(dom) => updateStore({ anchorDayOfMonth: dom })}
              />
            </div>

            {
              /* Unified metric list - every metric stacked; charts, or plain
              value cards for the yearly window. Export lives in the footer. */
            }
            <div class="seelevel-metrics">
              {sections?.flatMap((sec) => {
                const els = [
                  <div class="seelevel-metric-section" key={sec.metric}>
                    <div class="seelevel-metric-section__title">
                      {sec.label}
                    </div>
                    <StatsRow summary={sec.summary} metric={sec.metric} />
                    {!isYearly && (
                      <TimeSeriesChart
                        summary={sec.summary}
                        metric={sec.metric}
                        windowSize={store.windowSize}
                      />
                    )}
                  </div>,
                ];
                // The price distribution sits directly beneath the Volume metric.
                if (sec.metric === "volume" && priceHist) {
                  els.push(
                    <div class="seelevel-metric-section" key="price-dist">
                      <div class="seelevel-metric-section__title">
                        Price distribution
                      </div>
                      <PriceHistogramChart
                        histogram={priceHist.hist}
                        windowLabel={priceHist.label}
                      />
                    </div>,
                  );
                }
                return els;
              })}
            </div>

            <div class="seelevel-footer">
              <button
                type="button"
                class="seelevel-btn seelevel-btn--ghost"
                onClick={() => {
                  updateStore({
                    session: [],
                    viewportListings: null,
                    fetchedBboxes: [],
                    viewportBbox: null,
                    zone: null,
                    selectedRegionId: null,
                    drawing: false,
                    scope: "viewport",
                  });
                  if (activeTabId !== null) {
                    postToRelay(activeTabId, { type: "clear_zone" });
                  }
                }}
              >
                {store.scope === "zone" ? "Clear data" : "Clear"}
              </button>
              <ExportButton sections={sections} host={store.host} />
              <span class="seelevel-footer__info">{listingCount} in scope</span>
            </div>
          </>
        )}
      <Disclaimer host={store?.host ?? null} />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
