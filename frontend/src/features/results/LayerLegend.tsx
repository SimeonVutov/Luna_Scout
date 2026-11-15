import { contextCss } from "./contextColors";
import { EarthLegend } from "./EarthLegend";
import { isContextLayer, layerHelp, layerLabel } from "./mapLayers";
import type { MapLayer } from "./mapLayers";
import { SlopeLegend } from "./SlopeLegend";
import { SunlightLegend } from "./SunlightLegend";

/** The key for whichever layer is drawn, with a sentence saying what it means. */
export function LayerLegend({ layer }: { layer: MapLayer }) {
  if (layer === "none") return null;
  const key = layer === "sunlight" ? <SunlightLegend />
    : layer === "earth" ? <EarthLegend />
      : layer === "slope" ? <SlopeLegend />
        : isContextLayer(layer) ? <div className="sunlight-legend" aria-label={`${layerLabel[layer]} legend`}>
          <span className="ramp-label">{layer === "permanentShadow" ? "Not in shadow" : "0%"}</span>
          <i className="ramp" style={{ background: `linear-gradient(90deg, ${contextCss(layer, 0)}, ${contextCss(layer, 1)})` }} />
          <span className="ramp-label">{layer === "permanentShadow" ? "Always in shadow" : "100%"}</span>
        </div> : null;
  return <>
    {key}
    {layerHelp[layer] && <p className="layer-help">{layerHelp[layer]}</p>}
  </>;
}
