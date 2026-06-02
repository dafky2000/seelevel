// Runs in MAIN world - no chrome.* APIs available
// Communicates with ISOLATED relay via CustomEvent on document

// deno-lint-ignore-file no-explicit-any

import { EVT } from "../types.ts";

type AnyFn = (...args: any[]) => any;

// Only the endpoints that return a *complete* result set. newtoday is omitted
// on purpose - its bulk data lives in localStorage["vp.new_today"] (read by the
// relay) and its ?since= XHRs are deltas, not authoritative datasets.
const LISTING_PATHS = [
  "/api/v2/listing/search",
  "/api/v2/listing/top_listings",
];

// ─── Google Maps bounds sync ──────────────────────────────────────────────────
// See src/content/shared/google-maps-hook.ts. Same hook is also installed by
// the Engel & Völkers MAIN-world bundle; both sites embed google.maps.
import { installGoogleMapsHook } from "./shared/google-maps-hook.ts";
installGoogleMapsHook();

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
    Object.defineProperty(patched, "name", {
      value: original.name,
      configurable: true,
    });
    Object.defineProperty(patched, "length", {
      value: original.length,
      configurable: true,
    });
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
    document.dispatchEvent(
      new CustomEvent(EVT.listings, { detail: { body, url } }),
    );
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
      this.addEventListener("load", () => {
        // Defer all work off the page's XHR callback stack - the page's own
        // load handlers run fully before we touch anything.
        setTimeout(() => processResponse(this, url), 0);
      }, { once: true });
    }
  } catch { /* ignore - never block the request */ }
  return (origSend as any).apply(this, arguments);
};

maskAsNative(patchedOpen, origOpen);
maskAsNative(patchedSend, origSend);

XMLHttpRequest.prototype.open = patchedOpen as any;
XMLHttpRequest.prototype.send = patchedSend as any;
