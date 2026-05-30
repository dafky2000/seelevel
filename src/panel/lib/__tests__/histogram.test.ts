import { assertEquals } from "jsr:@std/assert@1";
import { priceHistogram } from "../histogram.ts";
import type { ListingRow } from "../../../types.ts";
import type { Bucket } from "../bucket.ts";

function makeListing(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: "L1",
    listing_id: "ML1",
    class_id: 1,
    status_id: 1,
    list_price: 300000,
    sold_price: null,
    list_dt: "2025-05-10",
    sold_dt: null,
    close_dt: null,
    tla: 1000,
    pid: "P1",
    lat: 44.8,
    lng: -63.1,
    ...overrides,
  };
}

// Local-time bucket so it lines up with parseDate's local-midnight handling.
const MAY: Bucket = {
  start: new Date("2025-05-01T00:00:00"),
  end: new Date("2025-06-01T00:00:00"),
  label: "2025-05",
  isPartial: false,
};

function sold(id: string, soldPrice: number): ListingRow {
  return makeListing({
    id,
    status_id: 2,
    list_price: 500000,
    sold_price: soldPrice,
    sold_dt: "2025-05-15",
  });
}

Deno.test("priceHistogram - nice bins from list prices", () => {
  const listings = [
    makeListing({ id: "1", list_price: 200000 }),
    makeListing({ id: "2", list_price: 240000 }),
    makeListing({ id: "3", list_price: 260000 }),
    makeListing({ id: "4", list_price: 700000 }),
  ];
  const h = priceHistogram(listings, MAY, null);
  assertEquals(h.hasData, true);
  assertEquals(h.seriesLabels, ["List", "Sold"]);
  // range 500k / 10 ≈ 50k → nice step 50k, first edge floored to 200k.
  assertEquals(h.step, 50000);
  assertEquals(h.bins[0].lo, 200000);
  // 200k and 240k both land in the first [200k,250k) bin (List = series 0).
  assertEquals(h.bins[0].counts[0], 2);
  // Every list value is binned - none dropped.
  const listTotal = h.bins.reduce((a, b) => a + b.counts[0], 0);
  assertEquals(listTotal, 4);
});

Deno.test("priceHistogram - both series share the same edges", () => {
  const listings = [
    makeListing({ id: "1", list_price: 200000 }),
    makeListing({ id: "2", list_price: 400000 }),
    sold("3", 300000),
  ];
  const h = priceHistogram(listings, MAY, null);
  assertEquals(h.seriesLabels.length, 2);
  // Each bin carries one count per series, aligned to seriesLabels.
  for (const bin of h.bins) assertEquals(bin.counts.length, 2);
  // The sold value (300k) and the sold listing's list value (500k) both count.
  const soldTotal = h.bins.reduce((a, b) => a + b.counts[1], 0);
  assertEquals(soldTotal, 1);
  const listTotal = h.bins.reduce((a, b) => a + b.counts[0], 0);
  assertEquals(listTotal, 3); // 200k, 400k, and the sold listing's 500k list price
});

Deno.test("priceHistogram - side filter keeps only the requested series", () => {
  const listings = [
    makeListing({ id: "1", list_price: 200000 }),
    sold("2", 300000),
  ];
  const listOnly = priceHistogram(listings, MAY, ["list"]);
  assertEquals(listOnly.seriesLabels, ["List"]);
  for (const bin of listOnly.bins) assertEquals(bin.counts.length, 1);

  const soldOnly = priceHistogram(listings, MAY, ["sold"]);
  assertEquals(soldOnly.seriesLabels, ["Sold"]);
  const soldTotal = soldOnly.bins.reduce((a, b) => a + b.counts[0], 0);
  assertEquals(soldTotal, 1);
});

Deno.test("priceHistogram - empty window has no data", () => {
  const h = priceHistogram([], MAY, null);
  assertEquals(h.hasData, false);
  assertEquals(h.bins, []);
});

Deno.test("priceHistogram - listings outside the bucket are excluded", () => {
  const listings = [
    makeListing({ id: "1", list_price: 300000, list_dt: "2025-03-10" }),
  ];
  const h = priceHistogram(listings, MAY, null);
  assertEquals(h.hasData, false);
});

Deno.test("priceHistogram - all-equal prices collapse to a single bin", () => {
  const listings = [
    makeListing({ id: "1", list_price: 300000 }),
    makeListing({ id: "2", list_price: 300000 }),
    makeListing({ id: "3", list_price: 300000 }),
  ];
  const h = priceHistogram(listings, MAY, null);
  assertEquals(h.hasData, true);
  assertEquals(h.bins.length, 1);
  assertEquals(h.bins[0].counts[0], 3);
});

Deno.test("priceHistogram - collapses the luxury tail into cap buckets", () => {
  const listings = [
    makeListing({ id: "1", list_price: 300000 }),
    makeListing({ id: "2", list_price: 400000 }),
    makeListing({ id: "3", list_price: 500000 }),
    makeListing({ id: "4", list_price: 1_500_000 }),
    makeListing({ id: "5", list_price: 6_000_000 }),
  ];
  const h = priceHistogram(listings, MAY, ["list"], 20);

  const oneM = h.bins.find((b) => b.label === "$1M+");
  const fiveM = h.bins.find((b) => b.label === "$5M+");
  // $2M–5M has no listings, so it is omitted ("as required").
  const twoM = h.bins.find((b) => b.label === "$2M+");

  assertEquals(oneM?.counts[0], 1); // the 1.5M listing
  assertEquals(fiveM?.counts[0], 1); // the 6M listing
  assertEquals(twoM, undefined);
  assertEquals(oneM?.isCap, true);
  // Every value is binned - the outliers are not dropped past the even region.
  const total = h.bins.reduce((a, b) => a + b.counts[0], 0);
  assertEquals(total, 5);
  // The even (sub-$1M) bins keep their resolution and never exceed $1M.
  const evenBins = h.bins.filter((b) => !b.isCap);
  for (const b of evenBins) assertEquals(b.hi <= 1_000_000, true);
});

Deno.test("priceHistogram - no cap buckets when the window is under $1M", () => {
  const listings = [
    makeListing({ id: "1", list_price: 300000 }),
    makeListing({ id: "2", list_price: 900000 }),
  ];
  const h = priceHistogram(listings, MAY, ["list"], 20);
  assertEquals(h.bins.some((b) => b.isCap), false);
  const total = h.bins.reduce((a, b) => a + b.counts[0], 0);
  assertEquals(total, 2); // 900k still binned, not pushed into a cap bucket
});

Deno.test("priceHistogram - a single cap tier when max is just over $1M", () => {
  const listings = [
    makeListing({ id: "1", list_price: 400000 }),
    makeListing({ id: "2", list_price: 1_200_000 }),
  ];
  const h = priceHistogram(listings, MAY, ["list"], 20);
  const caps = h.bins.filter((b) => b.isCap);
  assertEquals(caps.length, 1);
  assertEquals(caps[0].label, "$1M+");
  assertEquals(caps[0].counts[0], 1);
});

Deno.test("priceHistogram - bins never get narrower than the $25k floor", () => {
  // A tight 80k spread would otherwise yield ~5k bins; clamp to the $25k floor.
  const listings = [
    makeListing({ id: "1", list_price: 300000 }),
    makeListing({ id: "2", list_price: 320000 }),
    makeListing({ id: "3", list_price: 340000 }),
    makeListing({ id: "4", list_price: 360000 }),
    makeListing({ id: "5", list_price: 380000 }),
  ];
  const h = priceHistogram(listings, MAY, ["list"], 20);
  assertEquals(h.step, 25000);
  for (const b of h.bins) assertEquals(b.hi - b.lo, 25000);
});

Deno.test("priceHistogram - the max value lands in the last bin", () => {
  const listings = [
    makeListing({ id: "1", list_price: 100000 }),
    makeListing({ id: "2", list_price: 600000 }), // the max
  ];
  const h = priceHistogram(listings, MAY, null);
  const last = h.bins[h.bins.length - 1];
  assertEquals(last.counts[0], 1); // 600k counted, not dropped past the edge
  const total = h.bins.reduce((a, b) => a + b.counts[0], 0);
  assertEquals(total, 2);
});
