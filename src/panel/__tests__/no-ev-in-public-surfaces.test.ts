import { assertEquals } from "@std/assert";

// Engel & Völkers support is disabled pending written permission from EV
// (Engel & Völkers Americas, Inc., New York) - see CLAUDE.md. While disabled,
// EV must not appear on any user-facing or public surface: the shipped manifest,
// the public README, or any rendered panel copy. The EV *adapter* under
// src/content/ev/ and its tests are preserved (the saved engine) and are
// intentionally NOT scanned here. This guard fails loudly if an EV reference
// leaks back into a shipped/public surface.
//
// To re-enable EV, restore the manifest content_scripts entries + panel copy
// (git history / CLAUDE.md), flip EV_ENABLED in build.ts, then delete this test.

const PUBLIC_SURFACES = [
  "../../../manifest.json",
  "../../../README.md",
  "../components/EulaGate.tsx",
  "../components/Disclaimer.tsx",
  "../components/EmptyState.tsx",
  "../components/ExportButton.tsx",
];

// Distinctive EV tokens. We deliberately avoid a bare "ev" match (too many false
// positives: "level", "review", "every", "development").
const FORBIDDEN = [
  "engel",
  "völkers",
  "volkers",
  "engelvoelkers",
  "evrealestate",
];

for (const rel of PUBLIC_SURFACES) {
  Deno.test(`no EV reference in shipped/public surface: ${rel}`, async () => {
    const url = new URL(rel, import.meta.url);
    const text = (await Deno.readTextFile(url)).toLowerCase();
    const hits = FORBIDDEN.filter((tok) => text.includes(tok));
    assertEquals(
      hits,
      [],
      `${rel} contains disabled-EV reference(s): ${hits.join(", ")}`,
    );
  });
}
