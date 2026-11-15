import { contextLayers, layerLabel } from "./mapLayers";
import type { MapLayer } from "./mapLayers";

/** Choose what is drawn on the ground. Layers without data yet are left out. */
export function LayerPicker({ value, onChange, has }: {
  value: MapLayer;
  onChange: (layer: MapLayer) => void;
  has: { sunlight: boolean; earth: boolean; slope: boolean; context: boolean };
}) {
  const option = (layer: MapLayer) => <option key={layer} value={layer}>{layerLabel[layer]}</option>;
  return <label className="layer-picker">
    <span>Layer</span>
    <select value={value} onChange={(event) => onChange(event.target.value as MapLayer)} aria-label="Map layer">
      {option("none")}
      {(has.sunlight || has.earth) && <optgroup label="Now (timeline)">
        {has.sunlight && option("sunlight")}
        {has.earth && option("earth")}
      </optgroup>}
      {has.context && <optgroup label="Long-term (NASA)">{contextLayers.map(option)}</optgroup>}
      {has.slope && <optgroup label="Terrain">{option("slope")}</optgroup>}
    </select>
  </label>;
}
