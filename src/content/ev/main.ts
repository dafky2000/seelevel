// MAIN-world entry for engelvoelkersnovascotia.com.
// Two responsibilities:
//   1. Install the shared google.maps.Map constructor hook (bounds → seelevel:bbox).
//   2. Observe outbound get-ev-listing POSTs and forward to ev/sibling-fetch.ts.

// deno-lint-ignore-file no-explicit-any

import { installGoogleMapsHook } from "../shared/google-maps-hook.ts";
import { fireIfNeeded } from "./sibling-fetch.ts";

installGoogleMapsHook();

// ─── XHR observation ──────────────────────────────────────────────────────────
// Mirrors the disciplined pattern in src/content/fetch-interceptor.ts:
//   - request arguments forwarded verbatim
//   - all observation wrapped in try/catch — never block the page
//   - URL stashed in a WeakMap, not as an expando
//   - body parsed defensively from string OR JSON-serialized request body

const EV_TRIGGER_PATH = "/api/v1/property/get-ev-listing";

const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;

const urlByXhr = new WeakMap<XMLHttpRequest, string>();
const bodyByXhr = new WeakMap<XMLHttpRequest, string>();

function maskAsNative(
  patched: (...a: any[]) => any,
  original: (...a: any[]) => any,
): void {
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
  } catch { /* best-effort */ }
}

const patchedOpen = function (this: XMLHttpRequest) {
  try {
    urlByXhr.set(this, String(arguments[1]));
  } catch { /* never block */ }
  return (origOpen as any).apply(this, arguments);
};
maskAsNative(patchedOpen, origOpen);
XMLHttpRequest.prototype.open = patchedOpen as any;

const patchedSend = function (this: XMLHttpRequest, body?: any) {
  try {
    const url = urlByXhr.get(this) ?? "";
    if (url.includes(EV_TRIGGER_PATH) && typeof body === "string") {
      bodyByXhr.set(this, body);
      // Defer observation off the page's callback stack.
      this.addEventListener("loadend", () => {
        try {
          const stashed = bodyByXhr.get(this);
          if (!stashed) return;
          const parsed = JSON.parse(stashed);
          fireIfNeeded(parsed);
        } catch { /* never block */ }
      });
    }
  } catch { /* never block */ }
  return (origSend as any).apply(this, arguments);
};
maskAsNative(patchedSend, origSend);
XMLHttpRequest.prototype.send = patchedSend as any;

// Also observe fetch() in case the page ever switches API client.
const origFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  // Extract the body BEFORE forwarding to origFetch. When `input` is a Request,
  // fetch() consumes its body synchronously, so a later input.clone() throws
  // "Request body is already used". Cloning here, before origFetch sees it,
  // preserves an independent copy for our reader.
  let bodyPromise: Promise<string> | null = null;
  try {
    const url = typeof input === "string"
      ? input
      : (input instanceof Request ? input.url : "");
    if (url && url.includes(EV_TRIGGER_PATH)) {
      if (typeof init?.body === "string") {
        bodyPromise = Promise.resolve(init.body);
      } else if (input instanceof Request) {
        try {
          bodyPromise = input.clone().text();
        } catch { /* never block */ }
      }
    }
  } catch { /* never block */ }

  const promise = origFetch.apply(this, arguments as any);

  if (bodyPromise) {
    bodyPromise
      .then((body) => {
        if (!body) return;
        try {
          const parsed = JSON.parse(body);
          // Fire after the page's own fetch settles, so we don't race the
          // page's own UI updates (mirrors the XHR loadend timing).
          promise.then(() => fireIfNeeded(parsed)).catch(() => {});
        } catch { /* never block */ }
      })
      .catch(() => {/* never block */});
  }
  return promise;
};
