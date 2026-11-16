import { useEffect, useState } from "react";
import { precomputedCoverage } from "../../api/client";
import type { Coverage, SimulationOptions, SiteSpec } from "../../api/types";
import { defaultOptions } from "../results/useScience";

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

function sameOptions(options: SimulationOptions) {
  return (Object.keys(defaultOptions) as (keyof SimulationOptions)[]).every((key) => options[key] === defaultOptions[key]);
}

/**
 * "Ready to 31 Dec" for a reference site whose results the server finished precomputing, so
 * adding it shows results at once. Null with non-default settings, which the precompute does
 * not cover.
 */
export function readyLabel(coverage: Coverage[], site: SiteSpec, options: SimulationOptions) {
  if (!sameOptions(options)) return null;

  const match = coverage.find((item) =>
    item.complete && item.latitude_deg === site.latitude_deg && item.longitude_deg === site.longitude_deg);
  if (!match) return null;

  // The range ends at the start of the day after the last one covered.
  const lastDay = new Date(Date.parse(match.end_utc) - dayMs);
  return `Ready to ${dayFormat.format(lastDay)}`;
}
