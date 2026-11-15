import { slopeClasses, slopeColor } from "./slopeColors";

export function SlopeLegend() {
  return <div className="sunlight-legend" aria-label="Ground slope legend">
    {slopeClasses.map((entry, index) => <span key={entry.label}><i style={{ background: slopeColor(index) }} />{entry.label}</span>)}
  </div>;
}
