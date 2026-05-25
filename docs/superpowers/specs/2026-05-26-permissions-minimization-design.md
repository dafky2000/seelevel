# Permissions Minimization Design Spec

**Date:** 2026-05-26
**Status:** Approved
**Target:** Reduce manifest permission surface for faster Chrome Web Store review

---

## 1. Overview

SeeLevel v0.1.0 ships with three permission keys (`activeTab`, `storage`, `sidePanel`) and one `host_permissions` entry (`*://*.viewpoint.ca/*`). The Web Store's "Limited Host Use" review policy treats the *presence* of `host_permissions` as a trigger for in-depth review — even for a single narrow host. This spec removes everything that isn't load-bearing so the manifest declares only `sidePanel`.

**Result:** `permissions` drops from 3 entries to 1; the `host_permissions` key disappears entirely; `content_scripts.matches` is preserved (still required to inject on viewpoint.ca, and it produces the same user-visible install prompt regardless).

## 2. Goals & Non-Goals

**Goals**
- Drop `activeTab`, `storage`, and `host_permissions` from the manifest.
- Preserve every existing user-facing behaviour (panel renders the same metrics, zone drawing works, NEW TODAY repopulation works, multi-tab independence works).
- Preserve the just-shipped "reset on panel open" invariant.

**Non-goals**
- Reducing the install-time permission prompt the user sees. `content_scripts.matches` for `*://*.viewpoint.ca/map*` is intrinsic to the extension's purpose and will continue to produce the "Read and modify data on viewpoint.ca" prompt. The win here is what the *reviewer* sees declared, not what the *user* sees.
- Rewriting the panel UI, the aggregation logic, the zone-drawing system, or the build pipeline.
- Touching pre-existing code beyond what the four targeted changes require.

## 3. Architecture — Port Topology

The current design uses `chrome.runtime.sendMessage` broadcasts in both directions plus a special-cased `chrome.runtime.connect` port for the geofence overlay. This is replaced with a uniform port-broker topology:

```
[ Content script in tab A ]  ──port "relay"──→  ┐
[ Content script in tab B ]  ──port "relay"──→  │
                                                ├──→  [ Background SW ]
                                                │      • relayPorts: Map<tabId, Port>
[ Panel page ]               ──port "panel"──→  ┘      • panelPort: Port | null
```

**Why ports work without `host_permissions`:** `chrome.runtime.connect` is intrinsic — neither end requires host permission to open or read a port. `chrome.tabs.sendMessage` (which *does* require `host_permissions` or `activeTab`) is removed entirely.

**SW state:**

```ts
const relayPorts = new Map<number, chrome.runtime.Port>();
let panelPort: chrome.runtime.Port | null = null;
```

**Connection naming:**

- `"relay"` — opened by `relay.ts` on content-script load. The geofence overlay's previous separate `"geofence-<n>"` port is folded into this single port (the overlay lives in the same ISOLATED bundle and shares the same lifecycle).
- `"panel"` — opened by `App.tsx` on panel mount.

**Routing:** the SW maintains a routing table by `port.sender.tab.id`. Relay→panel messages are wrapped in `{tabId, payload}` envelopes so the panel writes to the correct per-tab `TabStore`. Panel→relay messages are addressed `{tabId, payload}` by the panel; SW looks up `relayPorts.get(tabId)` and forwards.

## 4. Message Flow & Lifecycle

**Wire-level envelope types** (added to `types.ts`):

```ts
// content script → SW
type RelayUp = { type: "msg"; payload: ContentToPanel };

// SW → content script
type RelayDown =
  | { type: "panel_opened" }
  | { type: "msg"; payload: PanelToContent };

// panel → SW
type PanelUp = { type: "msg"; tabId: number; payload: PanelToContent };

// SW → panel
type PanelDown =
  | { type: "tab_loaded"; tabId: number }
  | { type: "msg"; tabId: number; payload: ContentToPanel };
```

`ContentToPanel` and `PanelToContent` (the existing semantic payload unions) are pruned but otherwise unchanged:

- Remove from `ContentToPanel`: `tab_loaded` (now SW-synthesised; see below).
- Remove from `PanelToContent`: `panel_ready`, `reset_session` (both subsumed by `panel_opened`).

**Lifecycle:**

1. **Relay loads** (page navigation or refresh): opens `port "relay"`. Begins observing the page (XHRs, localStorage poll, map events) but emits *nothing* up the port — waits for `panel_opened`.
2. **Panel mounts**: opens `port "panel"`. SW sets `panelPort`, then sends `{type: "panel_opened"}` over every entry in `relayPorts`.
3. **Each relay receives `panel_opened`**: wipes `sessionListings`, `sessionProperties`, `lastSearch`, and resets `lastNewTodayRaw` to `""`. Emits the current `bbox` snapshot (if known) and current `polygon` (if drawn). The pre-existing 1.5s `pollNewTodayCache` re-emits the cache on its next tick because `lastNewTodayRaw` was cleared.
4. **Live events while panel is open**: relay events → SW → panel, wrapped in `{tabId, payload}`.
5. **New relay connects while panel is already open** (new viewpoint.ca tab opened, or existing tab navigated): SW sees the new port, sends `{type: "tab_loaded", tabId}` to panel (panel resets that tab's `TabStore` — which may hold stale state from the pre-navigation page) *and* `{type: "panel_opened"}` to the new relay (relay begins emitting). One port-connect event triggers both symmetric resets. (Note: step 2 deliberately does *not* send `tab_loaded` because the panel just mounted with an empty `tabStores` Map — there's no stale state to reset.)
6. **Panel closes**: panel port disconnects. SW clears `panelPort`. Relays continue observing; SW silently drops their events. Buffers will be wiped when the panel next opens.
7. **Tab closes / navigates away**: relay port disconnects. SW removes from `relayPorts`. (On viewpoint→viewpoint navigation, a new relay loads and reconnects with the same `tabId` — handled by case 5.)

**Per-tab state separation:** preserved by construction. Each tab has its own content-script instance (so its own buffer), its own `relayPorts` entry in SW (keyed by `tabId`), and its own `TabStore` in the panel (keyed by `tabId`). The only cross-tab event is the initial broadcast in step 2 — *N* independent wipes triggered simultaneously, not state merged across tabs.

**SW suspension:** MV3 SWs idle out after ~30s without activity, but active ports keep the SW alive. While any viewpoint tab is open *or* the panel is open, the SW stays alive. When everything is closed, the SW suspends — nothing to broker.

## 5. EULA Without Storage

**State model:** `eulaAcknowledged` becomes a plain `useState(false)` in `App.tsx`. Default `false` on every mount; the gate's button flips it to `true`; state dies with the panel on close. No `chrome.storage.local.get` on mount, no `chrome.storage.local.set` on accept, no loading branch.

**Renames:** `eulaAccepted` → `eulaAcknowledged` throughout (reflects per-session not persistent).

**`EulaGate.tsx` shrunk:** the current ~15-line copy collapses to four lines plus button. The load-bearing compliance content is preserved (personal/non-commercial scope, ViewPoint contact requirement for commercial use, NSAR MLS® attribution, "no data stored or transmitted"). The inline GitHub URL is dropped from the gate; `Disclaimer.tsx` (the persistent footer) keeps the link.

**Draft copy** (to be finalised at implementation time):

> **SeeLevel** — personal, non-commercial use only.
>
> Commercial or professional users must contact ViewPoint.ca directly before use.
>
> Data: NSAR MLS® via ViewPoint.ca. This extension does not store, transmit, or redistribute listing data.
>
> [ I understand — continue ]

**Friction trade-off:** the user re-acknowledges every panel open. The condensed gate keeps this to a single click on a one-screen acknowledgement, no scrolling. Acceptable cost for dropping the `storage` permission.

**What's unchanged:** `Disclaimer.tsx` (the always-visible footer) keeps reinforcing personal-use intent throughout the session.

## 6. Manifest Changes

```diff
 {
   "manifest_version": 3,
   "name": "SeeLevel",
   "version": "0.1.0",
   "description": "...",
-  "permissions": ["sidePanel", "activeTab", "storage"],
-  "host_permissions": ["*://*.viewpoint.ca/*"],
+  "permissions": ["sidePanel"],
   "side_panel": { "default_path": "panel/index.html" },
   "background": { "service_worker": "background/sw.js", "type": "module" },
   "content_scripts": [
     { "matches": ["*://*.viewpoint.ca/map*"], "js": ["content/fetch-interceptor.js"], "run_at": "document_start", "world": "MAIN" },
     { "matches": ["*://*.viewpoint.ca/map*"], "js": ["content/relay.js"], "run_at": "document_start", "world": "ISOLATED" }
   ],
   "action": { "default_title": "SeeLevel" },
   "icons": { ... }
 }
```

Net: three permission entries → one. `host_permissions` key removed entirely. Content-script declarations untouched.

## 7. Implementation Sequence

Three commits, in order:

**Commit 1 — Port-broker refactor.** The largest change; must work end-to-end before manifest cleanup removes the safety net.

- 1a. Extend `sw.ts`: `relayPorts: Map<tabId, Port>` and `panelPort: Port | null`. Wire `chrome.runtime.onConnect` to dispatch by `port.name`. Fold existing geofence port handling into the `"relay"` channel.
- 1b. Rewrite `relay.ts`: replace every `chrome.runtime.sendMessage` with `port.postMessage` via the single `"relay"` port opened on load. Wait silently for `panel_opened` before emitting anything. Implement the `panel_opened` handler: wipe `sessionListings` + `sessionProperties` + `lastSearch`, reset `lastNewTodayRaw = ""`, emit current `bbox` and `polygon` snapshots.
- 1c. Rewrite `App.tsx`: replace `chrome.runtime.onMessage.addListener` with a single `chrome.runtime.connect({name: "panel"})` port; handle the existing payload types over the port. Replace `chrome.tabs.sendMessage` calls (`panel_ready`, `reset_session`, `zone_prompt`, `clear_zone`) with `port.postMessage` envelopes addressed by `tabId`. Delete `resetTabs` Set and the `panel_ready`/`reset_session` choreography.
- 1d. Trim `types.ts`: remove `tab_loaded` from `ContentToPanel` (SW synthesises it); remove `panel_ready` and `reset_session` from `PanelToContent`. Add the four wire-envelope types.
- 1e. `geofence-overlay.ts`: drop its own port; share the relay port for `clear_zone` reception.

**Commit 2 — EULA acknowledge-each-open.**

- 2a. Slim `EulaGate.tsx` to four-line copy + button per Section 5.
- 2b. `App.tsx`: `eulaAccepted` → `eulaAcknowledged: useState(false)`. Remove the `chrome.storage.local.get` mount-effect and the `chrome.storage.local.set` in the accept handler. Remove the `eulaAccepted === null` loading branch.
- 2c. `Disclaimer.tsx`: add the GitHub URL if it isn't already there.

**Commit 3 — Manifest cleanup.**

- 3a. Strip `activeTab` and `storage` from `permissions`. Strip the entire `host_permissions` key. No code references should remain.
- 3b. Smoke test on a fresh unpacked load: panel open with viewpoint tab already open; panel open before viewpoint tab loaded; tab reload while panel is open; multi-tab switching in panel; zone draw + clear; NEW TODAY repopulation within 1.5s of panel open.

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Commit 1 regresses the reset/replay/zone-prompt timing we just fixed | The `panel_opened` → wipe → snapshot-emit sequence is *locally* ordered inside the relay (no async chain between contexts), which is structurally simpler than the current `reset_session` → `panel_ready` two-message handshake it replaces. Tests should explicitly cover: panel open with no viewpoint tab yet, panel open with stale buffer, page reload while panel is open. |
| SW suspends mid-session, drops port state | Active ports keep MV3 SWs alive. The risk only exists if all viewpoint tabs *and* the panel are closed — at which point there's nothing to broker. |
| Commit 3 surfaces a missed message path from Commit 1 | Sequencing intentionally puts the manifest change last, after Commits 1 and 2 are both verified working. Bisecting a Commit 3 failure points directly at a missed migration in Commit 1 or 2. |
| `tab_loaded` synthesis fires for a port-connect that isn't a "page load" (e.g., an extension reload re-injecting content scripts) | The panel's `tab_loaded` handler is idempotent — it just resets that tab's `TabStore` to default. An extra reset of an already-empty `TabStore` is a no-op. |
| EULA re-acknowledgement annoys users who open the panel many times per day | Gate is condensed to a single click with no scroll. If feedback shows it's still too much, a future change can re-introduce `chrome.storage.session` (which requires re-adding `storage`) — out of scope here. |

## 9. Open Questions

None at spec time. Final EULA copy is the only knob left, tuned during implementation.
