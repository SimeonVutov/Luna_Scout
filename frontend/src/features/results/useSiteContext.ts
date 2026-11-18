import { useEffect, useState } from "react";
import { siteContext } from "../../api/client";
import type { ChosenOptions, SiteContext, SiteSpec } from "../../api/types";
import { resolveOptions } from "../settings/gridSpacing";

// NASA's long-term maps never change, so every hook instance shares one memory.
const remembered = new Map<string, SiteContext | "missing">();

/** NASA's long-term illumination, Earth visibility, shadow and sky maps over a site. */
export function useSiteContext(site: SiteSpec | null, options: ChosenOptions) {
  const supported = site !== null && site.latitude_deg <= -60;
  const key = supported ? JSON.stringify([site.latitude_deg, site.longitude_deg, site.radius_m, resolveOptions(options, site).grid_spacing_m]) : null;
  const [entry, setEntry] = useState<SiteContext | "missing" | undefined>(key ? remembered.get(key) : undefined);

  useEffect(() => {
    if (!key || !site) { setEntry(undefined); return; }
    const known = remembered.get(key);
    setEntry(known);
    if (known) return;

    const controller = new AbortController();
    void siteContext(site, resolveOptions(options, site).grid_spacing_m, controller.signal)
      .then((value) => { remembered.set(key, value); setEntry(value); })
      .catch(() => {
        // An API or data set that predates these maps simply leaves the layers out.
        if (!controller.signal.aborted) setEntry("missing");
      });
    return () => controller.abort();
  // The key already captures everything the request depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return entry === undefined || entry === "missing" ? null : entry;
}
