import { assertEquals } from "jsr:@std/assert@1";
import { roundCoord, simplifyRing } from "./simplify.ts";

type Pt = [number, number];

Deno.test("simplifyRing - collinear interior points are removed", () => {
  const ring: Pt[] = [[0, 0], [0, 1], [0, 2], [0, 3]];
  assertEquals(simplifyRing(ring, 0.0001), [[0, 0], [0, 3]]);
});

Deno.test("simplifyRing - endpoints are always preserved", () => {
  const ring: Pt[] = [[0, 0], [0.00001, 0.5], [0, 1]];
  const out = simplifyRing(ring, 0.001);
  assertEquals(out[0], [0, 0]);
  assertEquals(out[out.length - 1], [0, 1]);
});

Deno.test("simplifyRing - a real bend survives a small tolerance", () => {
  const ring: Pt[] = [[0, 0], [1, 1], [0, 2]];
  assertEquals(simplifyRing(ring, 0.5), [[0, 0], [1, 1], [0, 2]]);
});

Deno.test("simplifyRing - larger tolerance never yields more points", () => {
  const ring: Pt[] = [[0, 0], [0.4, 1], [0, 2], [-0.4, 3], [0, 4]];
  const fine = simplifyRing(ring, 0.1);
  const coarse = simplifyRing(ring, 0.5);
  assertEquals(coarse.length <= fine.length, true);
});

Deno.test("simplifyRing - degenerate (<=2 points) returned as-is", () => {
  assertEquals(simplifyRing([[0, 0], [1, 1]], 0.1), [[0, 0], [1, 1]]);
  assertEquals(simplifyRing([[0, 0]], 0.1), [[0, 0]]);
});

Deno.test("roundCoord - rounds to 5 decimals", () => {
  assertEquals(roundCoord([44.123456789, -63.987654321]), [
    44.12346,
    -63.98765,
  ]);
});
