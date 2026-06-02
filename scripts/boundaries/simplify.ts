// Pure Ramer–Douglas–Peucker simplification for a single ring of [lat, lng]
// points. Planar distance in degrees is fine at municipal scale. No I/O.

type Pt = [number, number];

// Perpendicular distance from p to the line through a→b (planar, in degrees).
function perpDistance(p: Pt, a: Pt, b: Pt): number {
  const dy = b[0] - a[0];
  const dx = b[1] - a[1];
  const denom = Math.hypot(dy, dx);
  if (denom === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const cross = Math.abs(dx * (p[0] - a[0]) - dy * (p[1] - a[1]));
  return cross / denom;
}

// Classic recursive RDP. Endpoints are always kept.
export function simplifyRing(ring: Pt[], tolerance: number): Pt[] {
  if (ring.length <= 2) return ring;
  let maxDist = 0;
  let idx = 0;
  const end = ring.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDistance(ring[i], ring[0], ring[end]);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist <= tolerance) return [ring[0], ring[end]];
  const left = simplifyRing(ring.slice(0, idx + 1), tolerance);
  const right = simplifyRing(ring.slice(idx), tolerance);
  return left.slice(0, -1).concat(right);
}

export function roundCoord([lat, lng]: Pt): Pt {
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return [r(lat), r(lng)];
}
