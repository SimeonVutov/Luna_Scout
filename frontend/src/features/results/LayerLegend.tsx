import { bestSpotColors, bestSpotNames } from "./bestSpotColors";
import type { BestSpotClass } from "./bestSpotColors";
import { contextCss } from "./contextColors";
import { EarthLegend } from "./EarthLegend";
import { isBestSpotLayer, isContextLayer, layerHelp, layerLabel } from "./mapLayers";
import type { BestSpotLayer, ContextLayer, MapLayer } from "./mapLayers";
import { SlopeLegend } from "./SlopeLegend";
import { SunlightLegend } from "./SunlightLegend";
import "./layers.css";

/** The key for whichever layer is drawn, with a sentence saying what it means. */
export function LayerLegend({ layer }: { layer: MapLayer }) {
  if (layer === "none") return null;

  return <>
    <LegendKey layer={layer} />
    {layerHelp[layer] && <p className="layer-help">{layerHelp[layer]}</p>}
  </>;
}

function LegendKey({ layer }: { layer: Exclude<MapLayer, "none"> }) {
  if (layer === "sunlight") return <SunlightLegend />;
  if (layer === "earth") return <EarthLegend />;
  if (layer === "slope") return <SlopeLegend />;
  if (isBestSpotLayer(layer)) return <BestSpotLegend layer={layer} />;
  if (isContextLayer(layer)) return <RampLegend layer={layer} />;
  return null;
}

function BestSpotLegend({ layer }: { layer: BestSpotLayer }) {
  const names = Object.entries(bestSpotNames[layer]) as [BestSpotClass, string][];

  return <div className="sunlight-legend" aria-label={`${layerLabel[layer]} legend`}>
    {names.map(([spot, name]) => <span key={spot}>
      <i style={{ background: `rgb(${bestSpotColors[spot].join(" ")})` }} />{name}
    </span>)}
  </div>;
}

/** A dark-to-bright bar for the layers that show a value between 0% and 100%. */
function RampLegend({ layer }: { layer: ContextLayer }) {
  const shadow = layer === "permanentShadow";

  return <div className="sunlight-legend" aria-label={`${layerLabel[layer]} legend`}>
    <span className="ramp-label">{shadow ? "Not in shadow" : "0%"}</span>
    <i className="ramp" style={{ background: `linear-gradient(90deg, ${contextCss(layer, 0)}, ${contextCss(layer, 1)})` }} />
    <span className="ramp-label">{shadow ? "Always in shadow" : "100%"}</span>
  </div>;
}
