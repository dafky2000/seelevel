import { assertEquals } from "jsr:@std/assert@1";
import { buildFigures, compareAggregates } from "../parity.ts";
import type { ParityFigures, ParitySnapshot } from "../parity.ts";
import type { Bucket } from "../bucket.ts";
import type { BBox, ListingRow } from "../../../types.ts";

// Minimal ListingRow factory — only the fields the price/volume series read.
function row(p: Partial<ListingRow>): ListingRow {
  return {
    id: p.id ?? "x",
    listing_id: p.listing_id ?? "",
    class_id: 0,
    status_id: p.status_id ?? 1,
    list_price: p.list_price ?? null,
    sold_price: p.sold_price ?? null,
    close_dt: p.close_dt ?? null,
    list_dt: p.list_dt ?? null,
    sold_dt: p.sold_dt ?? null,
    tla: p.tla ?? null,
    pid: p.pid ?? null,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
  };
}

// One complete April-2026 bucket.
const APRIL: Bucket = {
  start: new Date(2026, 3, 1),
  end: new Date(2026, 4, 1),
  label: "2026-04-01 → 2026-05-01",
  isPartial: false,
};

Deno.test("buildFigures — counts, volume, and averages for the bucket", () => {
  const listings: ListingRow[] = [
    // listed in April, still active
    row({ id: "a", status_id: 1, list_dt: "2026-04-10", list_price: 300000 }),
    // listed AND sold in April
    row({
      id: "b",
      status_id: 2,
      list_dt: "2026-04-02",
      list_price: 420000,
      sold_dt: "2026-04-15",
      sold_price: 400000,
    }),
    // sold in April, no list_dt
    row({ id: "c", status_id: 2, sold_dt: "2026-04-20", sold_price: 500000 }),
  ];

  const f = buildFigures(listings, [APRIL], null);

  assertEquals(f.scopedCount, 3);
  assertEquals(f.listedCount, 2); // a, b have list_dt in April
  assertEquals(f.soldCount, 2); // b, c sold in April
  assertEquals(f.listAvg, 360000); // (300000 + 420000) / 2
  assertEquals(f.soldAvg, 450000); // (400000 + 500000) / 2
  assertEquals(f.soldVolume, 900000); // 400000 + 500000
  // Histogram has bins and the sold counts across bins total the sold sample.
  const soldTotal = f.histogram.reduce((n, b) => n + b.soldCount, 0);
  assertEquals(soldTotal, 2);
});

Deno.test("buildFigures — empty input yields zeroed figures", () => {
  const f = buildFigures([], [APRIL], null);
  assertEquals(f.scopedCount, 0);
  assertEquals(f.listedCount, 0);
  assertEquals(f.soldCount, 0);
  assertEquals(f.soldVolume, 0);
  assertEquals(f.listAvg, null);
  assertEquals(f.soldAvg, null);
  assertEquals(f.histogram, []);
});

Deno.test("buildFigures — picks the latest complete bucket", () => {
  const MAY_PARTIAL: Bucket = {
    start: new Date(2026, 4, 1),
    end: new Date(2026, 5, 1),
    label: "May",
    isPartial: true,
  };
  // A May-sold listing must NOT count — only the latest COMPLETE bucket (April).
  const listings = [
    row({ id: "b", status_id: 2, sold_dt: "2026-04-15", sold_price: 400000 }),
    row({ id: "m", status_id: 2, sold_dt: "2026-05-15", sold_price: 999000 }),
  ];
  const f = buildFigures(listings, [APRIL, MAY_PARTIAL], null);
  assertEquals(f.soldCount, 1);
  assertEquals(f.soldVolume, 400000);
});

const BBOX: BBox = { sw_lat: 44.6, sw_lng: -63.6, ne_lat: 44.7, ne_lng: -63.5 };

function figs(p: Partial<ParityFigures> = {}): ParityFigures {
  return {
    scopedCount: 10,
    listedCount: 4,
    soldCount: 4,
    soldVolume: 1_600_000,
    listAvg: 400000,
    listMedian: 390000,
    soldAvg: 400000,
    soldMedian: 395000,
    histogram: [{ label: "$300k–400k", listCount: 4, soldCount: 4 }],
    ...p,
  };
}

function snap(p: Partial<ParitySnapshot> = {}): ParitySnapshot {
  return {
    tabId: 1,
    host: "viewpoint.ca",
    scope: "viewport",
    searchStatus: "any",
    windowSize: "monthly",
    loading: false,
    bbox: BBOX,
    polygon: null,
    figures: figs(),
    ...p,
  };
}

Deno.test("compareAggregates — identical snapshots: aligned, all pass", () => {
  const r = compareAggregates(
    snap({ host: "viewpoint.ca" }),
    snap({ host: "ev" }),
  );
  assertEquals(r.aligned, true);
  assertEquals(r.deltas.every((d) => d.pass), true);
});

Deno.test("compareAggregates — soldVolume beyond tolerance fails that row", () => {
  const a = snap();
  const b = snap({ figures: figs({ soldVolume: 2_400_000 }) }); // +50%
  const r = compareAggregates(a, b);
  const sv = r.deltas.find((d) => d.key === "soldVolume")!;
  assertEquals(sv.pass, false);
  assertEquals(sv.absDelta, 800000);
});

Deno.test("compareAggregates — small count diff passes via absFloor", () => {
  const a = snap({ figures: figs({ soldCount: 1 }) });
  const b = snap({ figures: figs({ soldCount: 2 }) }); // diff 1 <= absFloor 2
  const r = compareAggregates(a, b);
  const sc = r.deltas.find((d) => d.key === "soldCount")!;
  assertEquals(sc.pass, true);
});

Deno.test("compareAggregates — one-sided null fails with null delta", () => {
  const a = snap({ figures: figs({ soldAvg: 400000 }) });
  const b = snap({ figures: figs({ soldAvg: null }) });
  const r = compareAggregates(a, b);
  const d = r.deltas.find((x) => x.key === "soldAvg")!;
  assertEquals(d.pass, false);
  assertEquals(d.absDelta, null);
});

Deno.test("compareAggregates — histogram bin on one side only", () => {
  const a = snap();
  const b = snap({ figures: figs({ histogram: [] }) });
  const r = compareAggregates(a, b);
  const d = r.deltas.find((x) => x.key === "hist:$300k–400k:list")!;
  assertEquals(d.a, 4);
  assertEquals(d.b, null);
  assertEquals(d.pass, false);
});

Deno.test("compareAggregates — window mismatch breaks alignment", () => {
  const r = compareAggregates(snap(), snap({ windowSize: "weekly" }));
  assertEquals(r.aligned, false);
  assertEquals(r.alignment.windowMatch, false);
  assertEquals(r.alignment.scopeMatch, true);
});

Deno.test("compareAggregates — zone scope compares polygons for alignment", () => {
  const poly: [number, number][] = [[44.6, -63.6], [44.7, -63.6], [
    44.7,
    -63.5,
  ]];
  const a = snap({ scope: "zone", polygon: poly, bbox: null });
  const b = snap({ scope: "zone", polygon: poly, bbox: BBOX });
  const r = compareAggregates(a, b);
  assertEquals(r.alignment.bboxMatch, true); // polygons match → bounds match
  assertEquals(r.aligned, true);
});
