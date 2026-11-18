import { useEffect, useState } from "react";
import { precomputedCoverage } from "../../api/client";
import type { ChosenOptions, Coverage, SimulationOptions, SiteSpec } from "../../api/types";
import { defaultOptions } from "../results/useScience";
import { resolveOptions } from "../settings/gridSpacing";

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayMs = 86_400_000;

/** How far the server has precomputed NASA's reference sites. Empty for a server without any. */
export function usePrecomputed() {
  const [coverage, setCoverage] = useState<Coverage[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void precomputedCoverage(controller.signal)
      .then(setCoverage)
      // The labels are a convenience; without them the sites work the same.
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return coverage;
}

/** Whether this site's request, once the grid spacing is chosen for its size, is the precomputed one. */
function sameOptions(options: ChosenOptions, site: SiteSpec) {
  const requested = resolveOptions(options, site);
  const precomputed = resolveOptions(defaultOptions, site);
  return (Object.keys(precomputed) as (keyof SimulationOptions)[]).every((key) => requested[key] === precomputed[key]);
}

/**
 * "Ready to 31 Dec" for a reference site whose results the server finished precomputing, so
 * adding it shows results at once. Null with non-default settings, which the precompute does
 * not cover.
 */
export function readyLabel(coverage: Coverage[], site: SiteSpec, options: ChosenOptions) {
  if (!sameOptions(options, site)) return null;

  const match = coverage.find((item) =>
    item.complete && item.latitude_deg === site.latitude_deg && item.longitude_deg === site.longitude_deg);
  if (!match) return null;

  // The range ends at the start of the day after the last one covered.
  const lastDay = new Date(Date.parse(match.end_utc) - dayMs);
  return `Ready to ${dayFormat.format(lastDay)}`;
}
