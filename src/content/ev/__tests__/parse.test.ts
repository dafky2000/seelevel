import { assertEquals } from "jsr:@std/assert@1";
import { parseEvListing } from "../parse.ts";

Deno.test("parseEvListing — active listing", () => {
  const row = parseEvListing({
    id: "abc-1",
    MlsStatus: "ACTIVE",
    StandardStatus: "Active",
    ListPrice: "689900",
    ClosedPrice: null,
    ListingContractDate: "2026-05-28",
    ModificationTimestamp: "2026-05-29T13:02:06.200Z",
    BuildingAreaTotal: "2400",
    Latitude: "44.5994",
    Longitude: "-63.6022",
  });
  assertEquals(row.id, "abc-1");
  assertEquals(row.status_id, 1);
  assertEquals(row.list_price, 689900);
  assertEquals(row.sold_price, null);
  assertEquals(row.list_dt, "2026-05-28");
  assertEquals(row.sold_dt, null);
  assertEquals(row.close_dt, null);
  assertEquals(row.tla, 2400);
  assertEquals(row.lat, 44.5994);
  assertEquals(row.lng, -63.6022);
});

Deno.test("parseEvListing — closed sold listing", () => {
  const row = parseEvListing({
    id: "abc-2",
    MlsStatus: "SOLD",
    StandardStatus: "Closed",
    ListPrice: "549900",
    ClosedPrice: "530000",
    ListingContractDate: "2025-02-25",
    ModificationTimestamp: "2025-07-11T14:46:57.800Z",
    BuildingAreaTotal: "2100",
    Latitude: "44.65",
    Longitude: "-63.6",
  });
  assertEquals(row.status_id, 2);
  assertEquals(row.list_price, 549900);
  assertEquals(row.sold_price, 530000);
  assertEquals(row.sold_dt, "2025-07-11T14:46:57.800Z");
  assertEquals(row.close_dt, "2025-07-11T14:46:57.800Z");
});

Deno.test("parseEvListing — pending sold listing", () => {
  // MlsStatus: SOLD but StandardStatus not Closed → under contract; status_id 6
  const row = parseEvListing({
    id: "abc-3",
    MlsStatus: "SOLD",
    StandardStatus: "Pending",
    ListPrice: "689900",
    ClosedPrice: null,
    ListingContractDate: "2026-05-28",
    ModificationTimestamp: "2026-05-28T17:43:01.100Z",
    BuildingAreaTotal: "2248",
    Latitude: "44.6",
    Longitude: "-63.6",
  });
  assertEquals(row.status_id, 6);
  assertEquals(row.sold_price, null);
  assertEquals(row.sold_dt, null); // not "Closed" → no sold_dt
});

Deno.test("parseEvListing — closed sold with ClosedPrice null (logged-out)", () => {
  const row = parseEvListing({
    id: "abc-4",
    MlsStatus: "SOLD",
    StandardStatus: "Closed",
    ListPrice: "300000",
    ClosedPrice: null, // auth-gated; null when logged out
    ListingContractDate: "2025-05-09",
    ModificationTimestamp: "2026-06-12T00:00:00.000Z",
    BuildingAreaTotal: "1500",
    Latitude: "44.6",
    Longitude: "-63.6",
  });
  assertEquals(row.status_id, 2);
  assertEquals(row.sold_price, null);
  assertEquals(row.sold_dt, "2026-06-12T00:00:00.000Z"); // still populated
});

Deno.test("parseEvListing — empty-string and null fields coerce to null", () => {
  const row = parseEvListing({
    id: "abc-5",
    MlsStatus: "ACTIVE",
    StandardStatus: "Active",
    ListPrice: "",
    ClosedPrice: "",
    ListingContractDate: null,
    ModificationTimestamp: null,
    BuildingAreaTotal: "",
    Latitude: "",
    Longitude: "",
  });
  assertEquals(row.list_price, null);
  assertEquals(row.sold_price, null);
  assertEquals(row.list_dt, null);
  assertEquals(row.sold_dt, null);
  assertEquals(row.tla, null);
  assertEquals(row.lat, null);
  assertEquals(row.lng, null);
});

Deno.test("parseEvListing — server-tacked ListingId flows to listing_id", () => {
  const row = parseEvListing({
    id: "abc-6",
    ListingId: "202612414",
    MlsStatus: "ACTIVE",
    StandardStatus: "Active",
    ListPrice: "500000",
    ClosedPrice: null,
    ListingContractDate: "2026-01-01",
    ModificationTimestamp: "2026-01-01T00:00:00.000Z",
    BuildingAreaTotal: "1800",
    Latitude: "44",
    Longitude: "-63",
  });
  assertEquals(row.listing_id, "202612414");
});

Deno.test("parseEvListing — pid is always null on EV", () => {
  const row = parseEvListing({
    id: "abc-7",
    MlsStatus: "ACTIVE",
    StandardStatus: "Active",
    ListPrice: "500000",
    ClosedPrice: null,
    ListingContractDate: "2026-01-01",
    ModificationTimestamp: "2026-01-01T00:00:00.000Z",
    BuildingAreaTotal: "1800",
    Latitude: "44",
    Longitude: "-63",
  });
  assertEquals(row.pid, null);
});
