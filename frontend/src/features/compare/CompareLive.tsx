import { lazy, Suspense, useState } from "react";
import type { Reading, RunStatus, SimulationOptions, Site, SiteInsight, SunlightGrid, TimeRange } from "../../api/types";
import { Icon } from "../../Icon";
import { SouthPoleMap } from "../globe/SouthPoleMap";
import type { MapLayer } from "../globe/SouthPoleMap";
import { SkyCloseUp } from "../results/SkyCloseUp";
import { StatTiles } from "../results/SiteMetrics";
import { coordinatesLabel } from "../sites/referenceSites";
import type { SpaceLayers } from "../space/layers";
import { slotColor, slotLabel, slots } from "./slots";

const SpaceView = lazy(() => import("../space/SpaceView").then((module) => ({ default: module.SpaceView })));
import type { Slot } from "./slots";

type PaneData = {
  site: Site | null;
  run: RunStatus | null;
  reading: Reading | null;
  sunlight: SunlightGrid | null;
  insight: SiteInsight | null;
};

type LiveProps = {
  panes: Record<Slot, PaneData>;
  at: Date;
  layer: MapLayer;
  onLayerChange: (layer: MapLayer) => void;
  view: "3d" | "2d";
  range: TimeRange;
  timeIndex: number;
  options: SimulationOptions;
  /** 3D layer settings shared by both panes. */
  spaceLayers: SpaceLayers;
  onSpaceLayers: (layers: SpaceLayers) => void;
};

type Body = "Sun" | "Earth";

/** Two independent 2D maps, one per site, driven by the shared timeline. */
export function CompareLive({ panes, at, layer, onLayerChange, view, range, timeIndex, options, spaceLayers, onSpaceLayers }: LiveProps) {
  // Map layers and the skyline body are shared, so both sites always show the same thing.
  const [body, setBody] = useState<Body>("Sun");
  return <div className="compare-live">
    {slots.map((slot) => <Pane key={`${slot}-${panes[slot].site?.id ?? "none"}`} slot={slot} data={panes[slot]} at={at}
      layer={layer} onLayerChange={onLayerChange} view={view} range={range} timeIndex={timeIndex} options={options}
      spaceLayers={spaceLayers} onSpaceLayers={onSpaceLayers} body={body} onBodyChange={setBody} />)}
  </div>;
}

function Pane({ slot, data, at, layer, onLayerChange, view, range, timeIndex, options, spaceLayers, onSpaceLayers, body, onBodyChange }: {
  slot: Slot;
  data: PaneData;
  at: Date;
  layer: MapLayer;
  onLayerChange: (layer: MapLayer) => void;
  view: "3d" | "2d";
  range: TimeRange;
  timeIndex: number;
  options: SimulationOptions;
  spaceLayers: SpaceLayers;
  onSpaceLayers: (layers: SpaceLayers) => void;
  body: Body;
  onBodyChange: (body: Body) => void;
}) {
  const { site } = data;
  const [cameraTarget, setCameraTarget] = useState<Site | null>(site ? { ...site } : null);

  if (!site) {
    return <section className="compare-pane empty">
      <p className="sidebar-note">Choose site {slotLabel[slot]} in the left panel.</p>
    </section>;
  }

  return <section className="compare-pane" aria-label={`Site ${slotLabel[slot]}: ${site.name}`}>
    <header className="pane-card" style={{ borderTopColor: slotColor[slot] }}>
      <div className="pane-title">
        <span className="site-chip" style={{ background: slotColor[slot] }}>{slotLabel[slot]}</span>
        <div className="pane-name">
          <strong>{site.name}</strong>
          <small>{coordinatesLabel(site.latitude_deg, site.longitude_deg)} · {site.radius_m.toLocaleString("en-GB")} m</small>
        </div>
        <button type="button" className="button quiet" onClick={() => setCameraTarget({ ...site })}><Icon name="target" size={15} /> Recentre</button>
      </div>
      <div className="pane-body">
        <StatTiles reading={data.reading} run={data.run} at={at} insight={data.insight} />
        <div className="pane-sky">
          <div className="segmented compact" role="radiogroup" aria-label="Body at the skyline">
            {(["Sun", "Earth"] as const).map((name) => <button key={name} type="button" role="radio" aria-checked={body === name}
              className={body === name ? "selected" : ""} onClick={() => onBodyChange(name)}>{name}</button>)}
          </div>
          <SkyCloseUp compact label={body} step={data.insight?.skyline_azimuth_step_deg ?? 0.1}
            view={body === "Sun" ? data.reading?.sun_at_collector : data.reading?.earth_at_mast}
            skyline={body === "Sun" ? data.insight?.collector_skyline_deg : data.insight?.mast_skyline_deg} />
        </div>
      </div>
    </header>
    <div className="pane-map">
      {view === "3d" ? <Suspense fallback={<p className="terrain-status" role="status">Opening the 3D view…</p>}>
        <SpaceView compact active sites={[site]} selected={site} focus={cameraTarget} run={data.run}
          range={range} timeIndex={timeIndex} options={options} sunlight={data.sunlight}
          layerState={spaceLayers} onLayers={onSpaceLayers} onSelect={() => undefined} />
      </Suspense> : <SouthPoleMap southOnly sites={[site]} selectedId={site.id} draft={null} picking={false}
        onPick={() => undefined} onSelect={() => undefined} cameraTarget={cameraTarget}
        sunlight={data.sunlight} slope={data.insight?.slope_grid ?? null} layer={layer} onLayerChange={onLayerChange} />}
    </div>
  </section>;
}
