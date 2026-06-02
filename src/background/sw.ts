import type { PanelDown, PanelUp, RelayDown, RelayUp } from "../types.ts";

// One port per ViewPoint tab, keyed by tab id, opened by relay.ts on
// content-script load. SW routes panel↔content messages through these.
const relayPorts = new Map<number, chrome.runtime.Port>();

// The host (e.g. "viewpoint.ca") for each connected relay tab, derived from
// port.sender?.url without requiring the `tabs` permission.
const hostByTab = new Map<number, string>();

// At most one panel port - the side panel is global, not per-tab. Null while
// the side panel is closed; SW silently drops relay→panel messages then.
let panelPort: chrome.runtime.Port | null = null;

// Suppress throws if a port disconnected between the routing decision and
// the actual postMessage. Disconnects can race with in-flight messages.
function safePost(port: chrome.runtime.Port, msg: unknown): void {
  try {
    port.postMessage(msg);
  } catch { /* port already disconnected */ }
}

chrome.runtime.onConnect.addListener((port) => {
  // "relay" = fresh page load (new content-script context, empty session).
  // "relay-reconnect" = relay re-dialing after a SW restart; the content-script
  //   context (and its sessionListings) is still alive. We must NOT send
  //   tab_loaded in that case — it would wipe the panel's in-memory store even
  //   though the data is still valid and the user didn't navigate anywhere.
  if (port.name === "relay" || port.name === "relay-reconnect") {
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) return; // not a tab-scoped connection - ignore
    relayPorts.set(tabId, port);

    try {
      const url = port.sender?.url;
      if (url) hostByTab.set(tabId, new URL(url).host);
    } catch { /* ignore malformed URL */ }

    if (panelPort) {
      if (port.name === "relay") {
        // Genuine new page load: panel may hold stale state from the previous
        // page. Reset it before the relay starts re-emitting.
        // Order matters: panel must reset its TabStore (tab_loaded) before the
        // relay starts re-emitting snapshots (triggered by panel_opened).
        safePost(panelPort, { type: "tab_loaded", tabId } satisfies PanelDown);
      }
      safePost(port, { type: "panel_opened" } satisfies RelayDown);
      const host = hostByTab.get(tabId);
      if (host) {
        safePost(
          panelPort,
          { type: "tab_meta", tabId, host } satisfies PanelDown,
        );
      }
    }

    port.onMessage.addListener((msg: RelayUp) => {
      if (msg.type !== "msg") return;
      if (!panelPort) return; // panel closed - drop silently
      safePost(
        panelPort,
        { type: "msg", tabId, payload: msg.payload } satisfies PanelDown,
      );
    });

    port.onDisconnect.addListener(() => {
      relayPorts.delete(tabId);
      hostByTab.delete(tabId);
    });
    return;
  }

  if (port.name === "panel") {
    panelPort = port;

    // Panel just mounted - tell every connected relay so they wipe their
    // buffer and re-emit current snapshots. Panel's tabStores is freshly
    // empty, so no tab_loaded is sent in this direction (it would be a
    // no-op reset of empty state).
    for (const relay of relayPorts.values()) {
      safePost(relay, { type: "panel_opened" } satisfies RelayDown);
    }
    // Seed the freshly-mounted panel with the host for every already-connected
    // relay tab so Disclaimer can render site-specific copy immediately.
    for (const [tabId, host] of hostByTab) {
      safePost(port, { type: "tab_meta", tabId, host } satisfies PanelDown);
    }

    port.onMessage.addListener((msg: PanelUp) => {
      if (msg.type !== "msg") return;
      const relay = relayPorts.get(msg.tabId);
      if (relay) {
        safePost(
          relay,
          { type: "msg", payload: msg.payload } satisfies RelayDown,
        );
      }
    });

    port.onDisconnect.addListener(() => {
      panelPort = null;
    });
    return;
  }
});

// Open the side panel when the user clicks the extension icon.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.sidePanel.open({ tabId: tab.id });
});
