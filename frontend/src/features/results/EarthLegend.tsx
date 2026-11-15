import { earthColor } from "./sunlightColors";

export function EarthLegend() {
  return <div className="sunlight-legend" aria-label="Earth line of sight legend">
    <span><i style={{ background: earthColor("full") }} />Whole Earth in view</span>
    <span><i style={{ background: earthColor("partial") }} />Part of Earth in view</span>
    <span><i style={{ background: earthColor("blocked") }} />Earth hidden</span>
    <span><i style={{ background: earthColor("unknown") }} />Unresolved</span>
  </div>;
}
