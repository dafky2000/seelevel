import { assertEquals, assert } from "jsr:@std/assert@1";
import { buildBuckets, availableWindowSizes } from "../bucket.ts";

// Fixed reference: Wednesday May 14 2025 12:00:00 UTC
const NOW = new Date("2025-05-14T12:00:00Z");
const ONE_YEAR_AGO = new Date("2024-05-14T12:00:00Z");

Deno.test("buildBuckets today-weekly - no partial buckets", () => {
  const buckets = buildBuckets(NOW, "weekly", "today");
  for (const b of buckets) {
    assertEquals(b.isPartial, false, `Bucket ${b.label} should not be partial`);
  }
  // Each bucket is exactly 7 days
  for (const b of buckets) {
    const ms = b.end.getTime() - b.start.getTime();
    assertEquals(ms, 7 * 24 * 60 * 60 * 1000, `Bucket ${b.label} should be 7 days`);
  }
});

Deno.test("buildBuckets today-monthly - no partial buckets", () => {
  const buckets = buildBuckets(NOW, "monthly", "today");
  for (const b of buckets) {
    assertEquals(b.isPartial, false);
  }
});

Deno.test("buildBuckets calendar-weekly - current bucket is partial (today is Wed, anchor Mon)", () => {
  const buckets = buildBuckets(NOW, "weekly", "calendar", 1); // anchor Mon
  const last = buckets[buckets.length - 1];
  // May 14 is a Wed; latest Mon was May 12; so current week (May 12-19) is partial
  assertEquals(last.isPartial, true);
});

Deno.test("buildBuckets calendar-monthly - partial when not 1st of month", () => {
  const buckets = buildBuckets(NOW, "monthly", "calendar", undefined, 1);
  const last = buckets[buckets.length - 1];
  // May 14 is not May 1, so current month bucket (May 1-Jun 1) is partial
  assertEquals(last.isPartial, true);
});

Deno.test("buildBuckets - buckets are contiguous and ascending", () => {
  const buckets = buildBuckets(NOW, "weekly", "today");
  for (let i = 1; i < buckets.length; i++) {
    assertEquals(buckets[i].start.getTime(), buckets[i - 1].end.getTime());
  }
  assert(buckets[0].start >= ONE_YEAR_AGO);
  assert(buckets[buckets.length - 1].end <= NOW || buckets[buckets.length - 1].end.getTime() - NOW.getTime() < 86400000);
});

Deno.test("buildBuckets today-yearly - single bucket, not partial", () => {
  const buckets = buildBuckets(NOW, "yearly", "today");
  assertEquals(buckets.length, 1);
  assertEquals(buckets[0].isPartial, false);
  const ms = buckets[0].end.getTime() - buckets[0].start.getTime();
  assertEquals(ms, 365 * 24 * 60 * 60 * 1000);
});

Deno.test("availableWindowSizes - monthly and yearly always available, even with no data", () => {
  // Monthly is the minimum (and default) resolution - never gated.
  assertEquals(availableWindowSizes(0), ["monthly", "yearly"]);
});

Deno.test("availableWindowSizes - weekly enabled at ≥5 listings/week (260/yr)", () => {
  // 260/52 = 5 - exactly at the threshold.
  assertEquals(availableWindowSizes(260), ["weekly", "monthly", "yearly"]);
});

Deno.test("availableWindowSizes - weekly disabled just below the threshold", () => {
  // 259/52 = 4.98 < 5 - weekly is withheld, monthly+yearly remain.
  assertEquals(availableWindowSizes(259), ["monthly", "yearly"]);
});

Deno.test("availableWindowSizes - 'daily' is never offered", () => {
  for (const n of [0, 260, 100000]) {
    assertEquals(availableWindowSizes(n).includes("daily" as never), false);
  }
});
