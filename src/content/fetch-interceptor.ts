// Runs in MAIN world - no chrome.* APIs available
// Communicates with ISOLATED relay via CustomEvent on document

// deno-lint-ignore-file no-explicit-any

type AnyFn = (...args: any[]) => any;

// Only the endpoints that return a *complete* result set. newtoday is omitted
// on purpose - its bulk data lives in localStorage["vp.new_today"] (read by the
// relay) and its ?since= XHRs are deltas, not authoritative datasets.
const LISTING_PATHS = [
  "/api/v2/listing/search",
  "/api/v2/listing/top_listings",
];

// ─── Google Maps bounds sync ──────────────────────────────────────────────────
// We hook every google.maps.Map instance to keep the Leaflet geofence overlay
// aligned with it:
//   • Pan  - bounds_changed + rAF while the user is dragging.
//   • Zoom - emit vpa:mapbusy on zoom start (overlay hides), re-sync on idle.
//
// To obtain the Map object we patch the google.maps.Map constructor - the only
// reliable way, since Google leaves no usable Map back-reference in the DOM.
// The patch is kept minimal: window.google is intercepted once to catch the
// namespace early, then released back to a plain value - no importLibrary
// wrapping and no permanent accessors on google.maps / google.maps.Map.
// A DOM-scan poll runs as a fallback for a map created before our patch landed.
(function installGoogleMapsHook() {
  type AnyObj = Record<string, any>;

  let currentMap: AnyObj | null = null;

  // ── Emit current bounds as vpa:bbox ──────────────────────────────────────
  // `settled` = the map has come to rest (idle / initial) vs a mid-drag frame.
  function emitBbox(m: AnyObj, settled: boolean): void {
    const b = m.getBounds?.();
    if (!b) return;
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const c = m.getCenter?.();
    const z = m.getZoom?.();
    document.dispatchEvent(new CustomEvent("vpa:bbox", {
      detail: {
        sw_lat: sw.lat(), sw_lng: sw.lng(),
        ne_lat: ne.lat(), ne_lng: ne.lng(),
        settled,
        ...(c && z !== undefined ? { center_lat: c.lat(), center_lng: c.lng(), zoom: z } : {}),
      },
    }));
  }

  // ── Attach sync listeners to a Maps instance ─────────────────────────────
  function hookInstance(m: AnyObj): void {
    if (!m || m.__vpa_hooked) return;
    m.__vpa_hooked = true;
    currentMap = m;

    let dragging = false;
    let raf = 0;

    m.addListener?.("dragstart", () => { dragging = true; });
    m.addListener?.("dragend", () => { dragging = false; });

    // Live pan sync - only while the user is dragging the map.
    m.addListener?.("bounds_changed", () => {
      if (!dragging) return; // zoom is handled by hide + idle resync
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => emitBbox(m, false));
    });

    // A zoom is starting - tell the overlay to hide until the map settles.
    m.addListener?.("zoom_changed", () => {
      document.dispatchEvent(new CustomEvent("vpa:mapbusy"));
    });

    // Authoritative sync - fires after every pan/zoom completes (and on load).
    m.addListener?.("idle", () => emitBbox(m, true));

    emitBbox(m, true); // Sync to current position immediately on hook
  }

  // ── Patch the google.maps.Map constructor (idempotent) ───────────────────
  function patchMapConstructor(): void {
    const maps: AnyObj = (window as any).google?.maps;
    const Original: AnyObj = maps?.Map;
    if (typeof Original !== "function" || (Original as AnyObj).__vpa) return;
    function Patched(this: AnyObj, ...args: any[]) {
      const inst = new (Original as any)(...args);
      try { hookInstance(inst); } catch { /* ignore */ }
      return inst;
    }
    Patched.prototype = Original.prototype;        // instanceof + methods
    Object.setPrototypeOf(Patched, Original);      // forward static members
    (Patched as AnyObj).__vpa = true;
    try { maps.Map = Patched; } catch { /* read-only - discovery fallback */ }
  }

  // Catch the window.google assignment so we can patch Map the instant the
  // namespace appears, then release window.google back to a plain value.
  if (!(window as any).google) {
    try {
      let _g: AnyObj | undefined;
      Object.defineProperty(window, "google", {
        configurable: true,
        get() { return _g; },
        set(v: AnyObj) {
          _g = v;
          try {
            Object.defineProperty(window, "google", {
              value: v, writable: true, configurable: true,
            });
          } catch { /* ignore */ }
          patchMapConstructor();
          queueMicrotask(patchMapConstructor); // Map may be defined just after
        },
      });
    } catch { /* not configurable - the polls below handle it */ }
  }

  // Fast poll to win the race against ViewPoint constructing its map.
  let fastTries = 0;
  function fastPatchPoll(): void {
    patchMapConstructor();
    const patched = !!((window as any).google?.maps?.Map as AnyObj)?.__vpa;
    if (!patched && ++fastTries < 600) requestAnimationFrame(fastPatchPoll);
  }
  fastPatchPoll();

  // ── Is the held instance still a live, attached map? ─────────────────────
  function isAlive(m: AnyObj | null): boolean {
    if (!m) return false;
    try {
      const div = m.getDiv?.();
      return !!div && document.contains(div);
    } catch {
      return false;
    }
  }

  // ── DOM-scan fallback - find a Map instance already rendered into the DOM ─
  function discover(): AnyObj | null {
    const container = document.querySelector(".gm-style")?.parentElement;
    if (!container) return null;

    const MapCls = (window as any).google?.maps?.Map;
    const keys: (string | symbol)[] = [
      ...Object.getOwnPropertyNames(container),
      ...Object.getOwnPropertySymbols(container),
    ];
    for (const key of keys) {
      try {
        const v = (container as any)[key];
        if (!v || typeof v !== "object") continue;
        const isMap = (MapCls && v instanceof MapCls) ||
          (typeof v.getBounds === "function" &&
            typeof v.getDiv === "function" &&
            typeof v.addListener === "function" &&
            typeof v.getCenter === "function");
        if (isMap) return v;
      } catch { /* skip inaccessible property */ }
    }
    return null;
  }

  // ── Continuous poll: keep the constructor patched and recover a lost map ──
  let elapsed = 0;
  function tick(): void {
    patchMapConstructor();           // idempotent - covers late namespace setup
    if (isAlive(currentMap)) return; // healthy - nothing to do
    currentMap = null;               // lost it, or never had one
    const m = discover();
    if (m) hookInstance(m);
  }
  function schedule(): void {
    const interval = elapsed < 30000 ? 200 : 1000;
    setTimeout(() => {
      elapsed += interval;
      tick();
      schedule();
    }, interval);
  }
  tick();     // immediate first attempt
  schedule(); // then keep polling
})();

// ─── XHR observation ──────────────────────────────────────────────────────────
// Passive, transparent monitoring - requests pass through completely unmodified.
// Hardening so we never interfere with native functionality:
//   • request arguments are forwarded verbatim (no reconstruction)
//   • our pre-work is wrapped in try/catch - a bug here can never block a request
//   • the URL is stashed in a WeakMap, not as an expando on the XHR object
//   • the response is read defensively (responseType-aware, never throws) and
//     all processing is deferred off the page's callback stack via setTimeout
//   • patched functions report native name/length/toString, so naive tamper
//     checks (fn.toString().includes("[native code]")) still pass. Note: a
//     check via Function.prototype.toString.call() can still see the patch -
//     fully defeating that is not possible without invasive Proxy trickery.
const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;

const urlByXhr = new WeakMap<XMLHttpRequest, string>();

function maskAsNative(patched: AnyFn, original: AnyFn): void {
  try {
    Object.defineProperty(patched, "name", { value: original.name, configurable: true });
    Object.defineProperty(patched, "length", { value: original.length, configurable: true });
    Object.defineProperty(patched, "toString", {
      value: original.toString.bind(original),
      writable: true,
      configurable: true,
    });
  } catch { /* ignore - masking is best-effort */ }
}

function isWatchedUrl(url: string): boolean {
  return LISTING_PATHS.some((p) => url.includes(p));
}

// Read the response as a string without throwing for non-text responseTypes.
function readBody(xhr: XMLHttpRequest): string | null {
  try {
    const rt = xhr.responseType;
    if (rt === "" || rt === "text") return xhr.responseText;
    if (rt === "json") return JSON.stringify(xhr.response);
    return null; // blob / arraybuffer / document - not our JSON endpoints
  } catch {
    return null;
  }
}

function processResponse(xhr: XMLHttpRequest, url: string): void {
  try {
    // Only a successful (2xx) response carries a complete dataset. A non-2xx
    // reply - e.g. the HTTP 400 "Too many search results" error returned when
    // the map is zoomed too far out - must never be treated as listings, or
    // its bbox would falsely count toward zone coverage.
    if (xhr.status < 200 || xhr.status >= 300) return;
    const body = readBody(xhr);
    if (body === null) return;
    // Listing endpoints only - the map bbox comes from the Google Maps hook.
    document.dispatchEvent(new CustomEvent("vpa:listings", { detail: { body, url } }));
  } catch { /* observation failure - never affects the page */ }
}

const patchedOpen = function (this: XMLHttpRequest) {
  try {
    urlByXhr.set(this, String(arguments[1]));
  } catch { /* ignore - never block the request */ }
  return (origOpen as any).apply(this, arguments);
};

const patchedSend = function (this: XMLHttpRequest) {
  try {
    const url = urlByXhr.get(this) ?? "";
    if (isWatchedUrl(url)) {
      const xhr = this;
      xhr.addEventListener("load", () => {
        // Defer all work off the page's XHR callback stack - the page's own
        // load handlers run fully before we touch anything.
        setTimeout(() => processResponse(xhr, url), 0);
      }, { once: true });
    }
  } catch { /* ignore - never block the request */ }
  return (origSend as any).apply(this, arguments);
};

maskAsNative(patchedOpen, origOpen);
maskAsNative(patchedSend, origSend);

XMLHttpRequest.prototype.open = patchedOpen as any;
XMLHttpRequest.prototype.send = patchedSend as any;
