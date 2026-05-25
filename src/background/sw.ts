/// <reference types="chrome"/>
import type { PanelDown, PanelUp, RelayDown, RelayUp } from "../types.ts";

// One port per ViewPoint tab, keyed by tab id, opened by relay.ts on
// content-script load. SW routes panel↔content messages through these.
const relayPorts = new Map<number, chrome.runtime.Port>();

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
  if (port.name === "relay") {
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) return; // not a tab-scoped connection - ignore
    relayPorts.set(tabId, port);

    // If the panel is already open when this relay connects (new viewpoint
    // tab opened, or existing tab navigated within viewpoint.ca), synthesise
    // tab_loaded for the panel (reset that tab's TabStore - it may hold stale
    // state from the pre-navigation page) and panel_opened for the new relay
    // (it can start emitting).
    if (panelPort) {
      // Order matters: panel must reset its TabStore (tab_loaded) before the
      // relay starts re-emitting snapshots (triggered by panel_opened).
      safePost(panelPort, { type: "tab_loaded", tabId } satisfies PanelDown);
      safePost(port, { type: "panel_opened" } satisfies RelayDown);
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
