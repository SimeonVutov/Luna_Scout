import { useEffect, useState } from "react";
import { siteInsight } from "../../api/client";
import type { SimulationOptions, SiteInsight, SiteSpec } from "../../api/types";

type Entry = { value?: SiteInsight; error?: string };

// Insights are static for a site and its heights, so every hook instance shares one memory.
const remembered = new Map<string, Entry>();

function insightKey(site: SiteSpec, options: SimulationOptions) {
  const collectorHeight = options.receiver === "terrain" ? 0 : options.collector_height_m;
  return JSON.stringify([site.latitude_deg, site.longitude_deg, site.radius_m, options.grid_spacing_m, collectorHeight, options.mast_height_m]);
}

/** Terrain detail, slope and skyline for a site. They never change with time. */
export function useSiteInsight(site: SiteSpec | null, options: SimulationOptions) {
  const supported = site !== null && site.latitude_deg <= -60;
  const key = supported ? insightKey(site, options) : null;
  const [entry, setEntry] = useState<Entry | undefined>(key ? remembered.get(key) : undefined);

  useEffect(() => {
    if (!key || !site) { setEntry(undefined); return; }
    const known = remembered.get(key);
    setEntry(known);
    if (known?.value) return;

    const controller = new AbortController();
    const collectorHeight = options.receiver === "terrain" ? 0 : options.collector_height_m;
    void siteInsight(site, { grid_spacing_m: options.grid_spacing_m, collector_height_m: collectorHeight, mast_height_m: options.mast_height_m }, controller.signal)
      .then((value) => { remembered.set(key, { value }); setEntry({ value }); })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setEntry({ error: failure instanceof Error ? failure.message : "Could not read the terrain." });
      });
    return () => controller.abort();
  // The key already captures everything the request depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { insight: entry?.value ?? null, error: entry?.error ?? null, loading: key !== null && entry === undefined };
}
