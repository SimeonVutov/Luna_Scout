import { sunlightColor } from "./sunlightColors";

export function SunlightLegend() {
  return <div className="sunlight-legend" aria-label="Visible solar disk legend">
    <span><i style={{ background: sunlightColor("full") }} />Full sun</span>
    <span><i style={{ background: sunlightColor("partial") }} />Partial sun</span>
    <span><i style={{ background: sunlightColor("shadow") }} />Shadow</span>
    <span><i style={{ background: sunlightColor("unknown") }} />Unresolved</span>
  </div>;
}
