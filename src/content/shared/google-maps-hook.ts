// MAIN-world only. Patches google.maps.Map's constructor and hooks every
// instance so seelevel:bbox + seelevel:mapbusy fire on idle / drag / zoom.
// Idempotent — calling more than once is harmless (each instance's hookInstance
// checks __seelevel_hooked).
//
// Adapter-agnostic: used by both src/content/fetch-interceptor.ts (ViewPoint)
// and src/content/ev/main.ts (Engel & Völkers). Both sites embed google.maps,
// so the same hook works for both.

// deno-lint-ignore-file no-explicit-any
import { DRIVE_EVENT, EVT } from "../../types.ts";
import type { BBox } from "../../types.ts";

declare const __DEV__: boolean;

type AnyObj = Record<string, any>;

export function installGoogleMapsHook(): void {
  let currentMap: AnyObj | null = null;

  // ── Emit current bounds as seelevel:bbox ─────────────────────────────────
  // `settled` = the map has come to rest (idle / initial) vs a mid-drag frame.
  function emitBbox(m: AnyObj, settled: boolean): void {
    const b = m.getBounds?.();
    if (!b) return;
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const c = m.getCenter?.();
    const z = m.getZoom?.();
    document.dispatchEvent(
      new CustomEvent(EVT.bbox, {
        detail: {
          sw_lat: sw.lat(),
          sw_lng: sw.lng(),
          ne_lat: ne.lat(),
          ne_lng: ne.lng(),
          settled,
          ...(c && z !== undefined
            ? { center_lat: c.lat(), center_lng: c.lng(), zoom: z }
            : {}),
        },
      }),
    );
  }

  // ── Attach sync listeners to a Maps instance ─────────────────────────────
  function hookInstance(m: AnyObj): void {
    if (!m || m.__seelevel_hooked) return;
    m.__seelevel_hooked = true;
    currentMap = m;

    let dragging = false;
    let raf = 0;

    m.addListener?.("dragstart", () => {
      dragging = true;
    });
    m.addListener?.("dragend", () => {
      dragging = false;
    });

    // Live pan sync - only while the user is dragging the map.
    m.addListener?.("bounds_changed", () => {
      if (!dragging) return; // zoom is handled by hide + idle resync
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => emitBbox(m, false));
    });

    // A zoom is starting - tell the overlay to hide until the map settles.
    m.addListener?.("zoom_changed", () => {
      document.dispatchEvent(new CustomEvent(EVT.mapbusy));
    });

    // Authoritative sync - fires after every pan/zoom completes (and on load).
    m.addListener?.("idle", () => emitBbox(m, true));

    emitBbox(m, true); // Sync to current position immediately on hook
  }

  // Wrap a Map constructor so each new instance gets hooked. Idempotent: if the
  // Original already carries our marker, returns it unchanged.
  function wrapMapClass(Original: AnyObj): AnyObj {
    if (typeof Original !== "function" || (Original as AnyObj).__seelevel) {
      return Original;
    }
    function Patched(this: AnyObj, ...args: any[]) {
      const inst = new (Original as any)(...args);
      try {
        hookInstance(inst);
      } catch { /* ignore */ }
      return inst;
    }
    Patched.prototype = Original.prototype; // instanceof + methods
    Object.setPrototypeOf(Patched, Original); // forward static members
    (Patched as AnyObj).__seelevel = true;
    return Patched;
  }

  // ── Patch the google.maps.Map constructor (idempotent) ───────────────────
  function patchMapConstructor(): void {
    const maps: AnyObj = (window as any).google?.maps;
    const Original: AnyObj = maps?.Map;
    if (typeof Original !== "function" || (Original as AnyObj).__seelevel) {
      return;
    }
    const Patched = wrapMapClass(Original);
    try {
      maps.Map = Patched;
    } catch { /* read-only - discovery fallback */ }
  }

  // ── Patch google.maps.importLibrary (modern modular loading API) ─────────
  // Engel & Völkers (and any modern Maps SDK consumer) uses
  // `await google.maps.importLibrary("maps")` to get the Map class. The
  // returned class is destructured into a local closure variable, so simply
  // patching `google.maps.Map` after the fact never reaches those callers.
  // Wrap importLibrary so every call to it that resolves with a `Map` field
  // returns OUR Patched wrapper instead.
  function patchImportLibrary(): void {
    const maps: AnyObj = (window as any).google?.maps;
    if (!maps || maps.__seelevel_importlib_patched) return;
    const orig = maps.importLibrary;
    if (typeof orig !== "function") return;
    maps.__seelevel_importlib_patched = true;
    maps.importLibrary = function (libName: string, ...rest: any[]) {
      const p = orig.call(this, libName, ...rest);
      if (libName !== "maps" || !p || typeof p.then !== "function") return p;
      return p.then((result: AnyObj) => {
        if (result && result.Map) result.Map = wrapMapClass(result.Map);
        return result;
      });
    };
  }

  // Catch the window.google assignment so we can patch Map the instant the
  // namespace appears, then release window.google back to a plain value.
  if (!(window as any).google) {
    try {
      let _g: AnyObj | undefined;
      Object.defineProperty(window, "google", {
        configurable: true,
        get() {
          return _g;
        },
        set(v: AnyObj) {
          _g = v;
          try {
            Object.defineProperty(window, "google", {
              value: v,
              writable: true,
              configurable: true,
            });
          } catch { /* ignore */ }
          patchMapConstructor();
          patchImportLibrary();
          queueMicrotask(patchMapConstructor); // Map may be defined just after
          queueMicrotask(patchImportLibrary);
        },
      });
    } catch { /* not configurable - the polls below handle it */ }
  }

  // Fast poll to win the race against ViewPoint constructing its map.
  let fastTries = 0;
  function fastPatchPoll(): void {
    patchMapConstructor();
    patchImportLibrary();
    const patched = !!((window as any).google?.maps?.Map as AnyObj)?.__seelevel;
    if (!patched && ++fastTries < 600) requestAnimationFrame(fastPatchPoll);
  }
  fastPatchPoll();

  // ── Dev-only: drive the map to a requested bbox (parity harness) ─────────
  // ISOLATED relay dispatches seelevel:drive; we fitBounds the live instance.
  // Stripped from --prod (__DEV__ === false → dead code).
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    document.addEventListener(DRIVE_EVENT, (e) => {
      const d = (e as CustomEvent<{ bbox: BBox }>).detail;
      if (!d?.bbox || !currentMap) return;
      try {
        currentMap.fitBounds?.({
          north: d.bbox.ne_lat,
          south: d.bbox.sw_lat,
          east: d.bbox.ne_lng,
          west: d.bbox.sw_lng,
        });
      } catch { /* never break the page */ }
    });
  }

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

  // Duck-type check: does this object look like a google.maps.Map instance?
  function isMapLike(v: AnyObj | null): boolean {
    if (!v || typeof v !== "object") return false;
    try {
      return (
        typeof v.getBounds === "function" &&
        typeof v.getCenter === "function" &&
        typeof v.addListener === "function"
      );
    } catch {
      return false;
    }
  }

  // ── DOM/React-scan fallback - find a Map instance the patches missed ─────
  // Two strategies in order:
  //   1. Direct DOM ownprop scan on .gm-style's parent — fast, covers the
  //      common Google Maps pattern of attaching the instance to the host div.
  //   2. React Fiber walk — covers SPAs (Engel & Völkers, etc.) that hold the
  //      Map in a React ref / props instead of a DOM property.
  // Strategy 2 is more expensive, but it's only reached when (1) fails.
  function discover(): AnyObj | null {
    const gmStyle = document.querySelector(".gm-style");
    if (!gmStyle) return null;

    // Strategy 1: scan .gm-style's parent ownprops
    const container = gmStyle.parentElement;
    const MapCls = (window as any).google?.maps?.Map;
    if (container) {
      const keys: (string | symbol)[] = [
        ...Object.getOwnPropertyNames(container),
        ...Object.getOwnPropertySymbols(container),
      ];
      for (const key of keys) {
        try {
          const v = (container as any)[key];
          if (!v || typeof v !== "object") continue;
          if ((MapCls && v instanceof MapCls) || isMapLike(v)) return v;
        } catch { /* skip inaccessible property */ }
      }
    }

    // Strategy 2: walk React Fibers from any div upward, checking props/state
    // for a Map-like reference. Bounded to keep the per-tick cost predictable.
    const divs = document.querySelectorAll("div");
    let scanned = 0;
    for (const el of divs) {
      if (scanned++ > 500) break; // cap to avoid pathological pages
      let fiberKey: string | undefined;
      for (const k in el) {
        if (k.startsWith("__reactFiber")) {
          fiberKey = k;
          break;
        }
      }
      if (!fiberKey) continue;
      let fiber = (el as any)[fiberKey];
      let hops = 0;
      while (fiber && hops < 30) {
        for (
          const slot of [
            fiber.memoizedProps,
            fiber.memoizedState,
            fiber.stateNode,
          ]
        ) {
          if (!slot || typeof slot !== "object") continue;
          for (const k of Object.keys(slot)) {
            try {
              const v = (slot as any)[k];
              if (isMapLike(v)) return v as AnyObj;
            } catch { /* skip */ }
          }
        }
        fiber = fiber.return;
        hops++;
      }
    }
    return null;
  }

  // ── Continuous poll: keep the constructor patched and recover a lost map ──
  let elapsed = 0;
  function tick(): void {
    patchMapConstructor(); // idempotent - covers late namespace setup
    if (isAlive(currentMap)) return; // healthy - nothing to do
    currentMap = null; // lost it, or never had one
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
  tick(); // immediate first attempt
  schedule(); // then keep polling
}
