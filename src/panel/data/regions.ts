import data from "./ns-municipalities.json" with { type: "json" };
import type { RegionRecord } from "../../types.ts";

export const NS_REGIONS = data as unknown as RegionRecord[];
