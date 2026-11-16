import type { RunStatus, SimulationOptions, Site } from "../../api/types";
import { useRunOutput, useRunSeries } from "./useScience";
import { useSiteContext } from "./useSiteContext";
import { useSiteIce } from "./useSiteIce";
import { useSiteInsight } from "./useSiteInsight";
import { useSiteMap } from "./useSiteMap";

/**
 * Everything shown about one site beside its run: the snapshot at the playhead, the run's series,
 * the terrain insight, NASA's long-term maps, Diviner's modelled ice numbers and how each point fared over the whole run. Nothing is requested while `active` is false.
 */
export function useSiteData(site: Site | null, run: RunStatus | null, timeIndex: number, options: SimulationOptions, active: boolean) {
  return {
    output: useRunOutput(active ? run : null, timeIndex),
    series: useRunSeries(active ? run : null),
    insight: useSiteInsight(active ? site : null, options),
    context: useSiteContext(active ? site : null, options),
    siteMap: useSiteMap(active ? run : null),
    ice: useSiteIce(active ? site : null),
  };
}
