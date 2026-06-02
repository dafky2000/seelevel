// Build-time only. Fetches the Socrata "Municipality Boundaries" GeoJSON with
// the SOCRATA_API_KEY/SECRET from .env (HTTP Basic auth), transforms every
// feature to a RegionRecord, and writes src/panel/data/ns-municipalities.json.
// Never bundled into the extension; never runs in the shipped code.
import { join } from "@std/path";
import type { RegionRecord } from "../../src/types.ts";
import { featureToRegion } from "./transform.ts";

const VIEW = "7bqh-hssn";
const URL_GEOJSON =
  `https://data.novascotia.ca/api/v3/views/${VIEW}/query.geojson?$limit=200`;

// Simplification tolerance in degrees. ~0.002° ≈ 200 m — the size/fidelity knee
// for this dataset (~95 KB gzipped, boundaries still accurate at city/county
// zoom). The script prints the artifact size so this can be retuned.
const TOLERANCE = 0.002;

// Minimal .env reader (KEY=VALUE per line) — avoids a dependency just to read
// two keys. Quotes are stripped; blank/comment lines ignored.
async function readEnv(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

export async function buildBoundaries(repoDir: string): Promise<void> {
  const env = await readEnv(join(repoDir, ".env"));
  const key = env.SOCRATA_API_KEY ?? Deno.env.get("SOCRATA_API_KEY");
  const secret = env.SOCRATA_API_SECRET ?? Deno.env.get("SOCRATA_API_SECRET");
  if (!key || !secret) {
    throw new Error(
      "Missing SOCRATA_API_KEY / SOCRATA_API_SECRET (.env) — needed for --refresh-boundaries.",
    );
  }
  const auth = "Basic " + btoa(`${key}:${secret}`);
  console.log("Fetching NS municipality boundaries…");
  const res = await fetch(URL_GEOJSON, { headers: { authorization: auth } });
  if (!res.ok) {
    throw new Error(`Socrata fetch failed: ${res.status} ${res.statusText}`);
  }
  const geo = await res.json() as { features: unknown[] };
  const regions: RegionRecord[] = (geo.features ?? [])
    .map((f) => featureToRegion(f, TOLERANCE))
    .filter((r) => r.shape.length > 0)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const outPath = join(repoDir, "src/panel/data/ns-municipalities.json");
  await Deno.mkdir(join(repoDir, "src/panel/data"), { recursive: true });
  const json = JSON.stringify(regions);
  await Deno.writeTextFile(outPath, json + "\n");

  const bytes = new TextEncoder().encode(json).length;
  const gz = await gzipSize(json);
  console.log(
    `Wrote ${regions.length} regions → ${outPath} ` +
      `(${(bytes / 1024).toFixed(0)} KB raw, ${(gz / 1024).toFixed(0)} KB gz)`,
  );
}

async function gzipSize(text: string): Promise<number> {
  const stream = new Blob([text]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return buf.byteLength;
}

if (import.meta.main) {
  await buildBoundaries(new URL("../..", import.meta.url).pathname);
}
