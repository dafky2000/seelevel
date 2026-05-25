import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { parseInterceptedResponse } from "../parse.ts";

const SEARCH_URL =
  "https://www.viewpoint.ca/api/v2/listing/search?" +
  "parameters%5Bstatus%5D=active&" +
  "parameters%5Bsearch_area%5D=45.0%2C+-63.0%2C+14%2C+44.5%2C+-63.5%2C+45.5%2C+-62.5&" +
  "CLIENT_VER=123&nonce=abc";

const MOCK_BODY = JSON.stringify({
  status: "success",
  nonce: "xyz",
  listings: [
    {
      id: "L1", listing_id: "ML1", class_id: 1, status_id: 1,
      list_price: 350000, sold_price: null,
      list_dt: "2025-03-01", sold_dt: null, close_dt: null,
      tla: 1200, pid: "PID1",
    },
  ],
  properties: [
    { pid: "PID1", lat: 44.8, lng: -63.1 },
  ],
});

Deno.test("parseInterceptedResponse - happy path", () => {
  const result = parseInterceptedResponse(MOCK_BODY, SEARCH_URL);
  assertExists(result);
  assertEquals(result.status, "active");
  assertEquals(result.listings.length, 1);
  assertEquals(result.listings[0].list_price, 350000);
  assertExists(result.bbox);
  assertEquals(result.bbox!.sw_lat, 44.5);
  assertEquals(result.bbox!.ne_lat, 45.5);
  assertEquals(result.bbox!.sw_lng, -63.5);
  assertEquals(result.bbox!.ne_lng, -62.5);
  assertEquals(result.properties[0].lat, 44.8);
});

Deno.test("parseInterceptedResponse - maps ViewPoint 'forsale' status to active", () => {
  const url = SEARCH_URL.replace("status%5D=active", "status%5D=forsale");
  assertEquals(parseInterceptedResponse(MOCK_BODY, url)!.status, "active");
});

Deno.test("parseInterceptedResponse - 'sold' status preserved, unknown → any", () => {
  const sold = SEARCH_URL.replace("status%5D=active", "status%5D=sold");
  assertEquals(parseInterceptedResponse(MOCK_BODY, sold)!.status, "sold");
  const none = SEARCH_URL.replace("parameters%5Bstatus%5D=active&", "");
  assertEquals(parseInterceptedResponse(MOCK_BODY, none)!.status, "any");
});

Deno.test("parseInterceptedResponse - non-success body returns null", () => {
  const result = parseInterceptedResponse(
    JSON.stringify({ status: "error" }),
    SEARCH_URL,
  );
  assertEquals(result, null);
});

Deno.test("parseInterceptedResponse - malformed JSON returns null", () => {
  assertEquals(parseInterceptedResponse("not json", SEARCH_URL), null);
});
