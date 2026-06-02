import {
  assertAlmostEquals,
  assertEquals,
  assertExists,
} from "jsr:@std/assert@1";
import { aggregate } from "../aggregate.ts";
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
    list_dt: "2025-05-01",
    sold_dt: null,
    close_dt: null,
    tla: 1000,
    pid: "P1",
    lat: 44.8,
    lng: -63.1,
    ...overrides,
  };
}

const MAY_BUCKET: Bucket = {
  start: new Date("2025-05-01T00:00:00Z"),
  end: new Date("2025-06-01T00:00:00Z"),
  label: "2025-05",
  isPartial: false,
};

const APR_BUCKET: Bucket = {
  start: new Date("2025-04-01T00:00:00Z"),
  end: new Date("2025-05-01T00:00:00Z"),
  label: "2025-04",
  isPartial: false,
};

Deno.test("aggregate price - avg and median computed correctly", () => {
  const listings = [
    makeListing({ id: "1", list_price: 200000 }),
    makeListing({ id: "2", list_price: 400000 }),
    makeListing({ id: "3", list_price: 300000 }),
  ];
  const list = aggregate(listings, "price", [MAY_BUCKET]).series[0];
  assertEquals(list.buckets[0].count, 3);
  assertAlmostEquals(list.buckets[0].avg!, 300000, 1);
  assertAlmostEquals(list.buckets[0].median!, 300000, 1);
  assertAlmostEquals(list.overall.avg!, 300000, 1);
});

Deno.test("aggregate price - yields List and Sold series", () => {
  const listings = [
    makeListing({
      id: "1",
      status_id: 2, // Sold
      list_price: 300000,
      list_dt: "2025-05-02",
      sold_price: 290000,
      sold_dt: "2025-05-20",
    }),
  ];
  const result = aggregate(listings, "price", [MAY_BUCKET]);
  assertEquals(result.series.length, 2);
  assertEquals(result.series[0].label, "List");
  assertEquals(result.series[1].label, "Sold");
  assertAlmostEquals(result.series[0].buckets[0].avg!, 300000, 1);
  assertAlmostEquals(result.series[1].buckets[0].avg!, 290000, 1);
});

Deno.test("aggregate price - empty bucket returns nulls", () => {
  const list = aggregate([], "price", [MAY_BUCKET]).series[0];
  assertEquals(list.buckets[0].count, 0);
  assertEquals(list.buckets[0].avg, null);
});

Deno.test("aggregate dom - single series measuring list-to-sale duration", () => {
  const listings = [
    makeListing({
      id: "1",
      status_id: 2, // Sold
      list_dt: "2025-05-01",
      sold_dt: "2025-05-11",
      sold_price: 290000,
    }),
  ];
  const result = aggregate(listings, "dom", [MAY_BUCKET]);
  assertEquals(result.series.length, 1);
  assertEquals(result.series[0].label, "DOM");
  assertAlmostEquals(result.series[0].buckets[0].avg!, 10, 0.01);
});

Deno.test("aggregate volume - Listed and Sold series count by date", () => {
  const listings = [
    makeListing({
      id: "1",
      list_dt: "2025-05-03",
      sold_dt: null,
      sold_price: null,
    }),
    makeListing({
      id: "2",
      status_id: 2,
      list_dt: "2025-04-15",
      sold_dt: "2025-05-09",
      sold_price: 280000,
    }),
  ];
  const result = aggregate(listings, "volume", [MAY_BUCKET]);
  assertEquals(result.series[0].label, "Listed");
  assertEquals(result.series[1].label, "Sold");
  assertEquals(result.series[0].buckets[0].count, 1); // only listing 1 listed in May
  assertEquals(result.series[1].buckets[0].count, 1); // only listing 2 sold in May
});

Deno.test("aggregate - a non-sold status with a sold_dt is not counted as sold", () => {
  // status_id 6 (pending/conditional) carries a sold_dt without an actual sale.
  const pending = makeListing({
    id: "1",
    status_id: 6,
    sold_price: 0,
    sold_dt: "2025-05-20",
    list_dt: "2025-05-01",
  });
  const vol = aggregate([pending], "volume", [MAY_BUCKET]);
  assertEquals(vol.series[1].buckets[0].count, 0); // Sold volume excludes it
  assertEquals(vol.series[0].buckets[0].count, 1); // Listed volume still counts it
  // DOM is sold-only - the pending listing must not produce a value.
  assertEquals(
    aggregate([pending], "dom", [MAY_BUCKET]).series[0].buckets[0].count,
    0,
  );
});

Deno.test("aggregate ppsf - List and Sold series divide by tla", () => {
  const listings = [makeListing({
    id: "1",
    status_id: 2, // Sold
    list_price: 300000,
    sold_price: 270000,
    sold_dt: "2025-05-20",
    tla: 1500,
  })];
  const result = aggregate(listings, "ppsf", [MAY_BUCKET]);
  assertAlmostEquals(result.series[0].buckets[0].avg!, 200, 0.01); // List 300000/1500
  assertAlmostEquals(result.series[1].buckets[0].avg!, 180, 0.01); // Sold 270000/1500
});

Deno.test("aggregate latest - headline is the most recent complete bucket", () => {
  const apr = [
    makeListing({ id: "1", list_price: 200000, list_dt: "2025-04-10" }),
  ];
  const may = [
    makeListing({ id: "2", list_price: 400000, list_dt: "2025-05-10" }),
  ];
  const list =
    aggregate([...apr, ...may], "price", [APR_BUCKET, MAY_BUCKET]).series[0];
  assertAlmostEquals(list.latest!.avg!, 400000, 1); // May - not the 300k year average
  assertAlmostEquals(list.overall.avg!, 300000, 1);
});

Deno.test("aggregate latest - skips a partial trailing bucket", () => {
  const partialMay: Bucket = { ...MAY_BUCKET, isPartial: true };
  const apr = [
    makeListing({ id: "1", list_price: 200000, list_dt: "2025-04-10" }),
  ];
  const may = [
    makeListing({ id: "2", list_price: 400000, list_dt: "2025-05-10" }),
  ];
  const list =
    aggregate([...apr, ...may], "price", [APR_BUCKET, partialMay]).series[0];
  assertAlmostEquals(list.latest!.avg!, 200000, 1); // April - May is still partial
});

Deno.test("aggregate listToSold - ratio", () => {
  const listings = [
    makeListing({
      id: "1",
      status_id: 2, // Sold
      list_price: 300000,
      sold_price: 291000,
      sold_dt: "2025-05-10",
    }),
  ];
  const lts = aggregate(listings, "listToSold", [MAY_BUCKET]).series[0];
  assertAlmostEquals(lts.buckets[0].avg!, 0.97, 0.001);
});

Deno.test("aggregate delta - compares most recent to previous bucket", () => {
  const may = [
    makeListing({ id: "1", list_price: 400000, list_dt: "2025-05-10" }),
  ];
  const apr = [
    makeListing({ id: "2", list_price: 200000, list_dt: "2025-04-10" }),
  ];
  const list = aggregate(
    [...may, ...apr],
    "price",
    [APR_BUCKET, MAY_BUCKET],
  ).series[0];
  assertExists(list.delta);
  assertAlmostEquals(list.delta!, 1.0, 0.01); // +100% from 200k to 400k
});

Deno.test("aggregate bucket floor - buckets with <5 listings flagged", () => {
  const listings = [makeListing({ id: "1" }), makeListing({ id: "2" })];
  const list = aggregate(listings, "price", [MAY_BUCKET]).series[0];
  assertEquals(list.buckets[0].belowFloor, true);
});

Deno.test("aggregate - series carry list/sold side tags", () => {
  // Side drives the for-sale / sold search filter in the panel.
  assertEquals(aggregate([], "price", [MAY_BUCKET]).series.map((s) => s.side), [
    "list",
    "sold",
  ]);
  assertEquals(
    aggregate([], "volume", [MAY_BUCKET]).series.map((s) => s.side),
    ["list", "sold"],
  );
  assertEquals(aggregate([], "ppsf", [MAY_BUCKET]).series.map((s) => s.side), [
    "list",
    "sold",
  ]);
  assertEquals(aggregate([], "dom", [MAY_BUCKET]).series[0].side, "sold");
  assertEquals(
    aggregate([], "listToSold", [MAY_BUCKET]).series[0].side,
    "sold",
  );
});
