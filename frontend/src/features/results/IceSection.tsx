import { decimal } from "./format";
import { depthLabel, kelvin, MODEL_DEPTH_M, share, shallowestIceLabel } from "./iceFormat";
import type { IceState } from "./useSiteIce";

const unavailableNote = {
  idle: "Ice numbers are available from 60°S to the pole.",
  loading: "Reading NASA's Diviner model…",
  unavailable: "These numbers need the Diviner table. Run lunascout-science fetch-data on the server.",
  outside: "Diviner's ice model covers the area from 80°S to the pole. This site is outside it.",
} as const;

/** Modelled temperatures and ice-stability depth for the site, from NASA's Diviner instrument. */
export function IceSection({ state }: { state: IceState }) {
  if (state.status !== "ready") return <p className="result-note" role="status">{unavailableNote[state.status]}</p>;

  const ice = state.ice;
  const cells = ice.nearest_triangle_only
    ? "The site is smaller than one model cell, so the nearest cell stands for it."
    : `Averaged over ${ice.triangle_count} model ${ice.triangle_count === 1 ? "cell" : "cells"} inside the site.`;

  return <>
    <dl className="metrics">
      <div><dt>Annual mean temperature</dt><dd>{kelvin(ice.mean_temperature_k)}</dd></div>
      <div><dt>Annual maximum · coldest spot</dt><dd>{kelvin(ice.max_temperature_k)} · {kelvin(ice.coldest_max_temperature_k)}</dd></div>
      <div><dt>Area with stable ice</dt><dd>{share(ice.stable_ice_share)}</dd></div>
      <div><dt>Ice stable at the surface</dt><dd>{share(ice.surface_ice_share)}</dd></div>
      <div><dt>Shallowest ice</dt><dd>{shallowestIceLabel(ice)}</dd></div>
      <div><dt>Mean depth of buried ice</dt><dd>{depthLabel(ice.mean_buried_ice_depth_m)}</dd></div>
    </dl>
    <p className="result-note">
      Modelled from Diviner's first year of observations at about {decimal.format(ice.resolution_m)} m: where ice would survive within {MODEL_DEPTH_M} m of the surface, not ice that was detected. {cells} Measured hydrogen is mapped too coarsely to give a number for one site.
    </p>
  </>;
}
