import { useEffect, useRef, useState } from "react";
import type { RayFan, RunStatus, SimulationOptions, Site, SiteContext, SunlightGrid, TimeRange } from "../../api/types";
import { contextCanvas, earthCanvas, sunlightCanvas } from "../globe/sunlightOverlay";
import { LayerLegend } from "../results/LayerLegend";
import { LayerPicker } from "../results/LayerPicker";
import { isContextLayer } from "../results/mapLayers";
import { wholePercent } from "../results/format";
import type { RigView } from "./cameraRig";
import { defaultSpaceLayers } from "./layers";
import type { SpaceLayers } from "./layers";
import { rayColours, spaceScene } from "./spaceScene";
import type { SpaceScene } from "./spaceScene";
import { useSiteRays } from "./useSiteRays";
import { useSky } from "./useSky";

const distance = new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 3 });

function coordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(2)}°${value < 0 ? negative : positive}`;
}

function viewText(view: RigView) {
  if (view.mode === "stand") {
    const bearing = view.bearingDeg === null ? "" : ` · looking ${Math.round(view.bearingDeg)}° from north`;
    return `Standing on the surface${bearing} · ${view.pitchDeg.toFixed(1)}° above level`;
  }
  const height = view.altitudeKm >= 1 ? `${distance.format(view.altitudeKm)} km` : `${distance.format(view.altitudeKm * 1000)} m`;
  return `Camera ${height} above the surface · ${coordinate(view.latitude, "N", "S")} ${coordinate(view.longitude, "E", "W")}`;
}

function RayCount({ name, colour, fans, where }: { name: string; colour: string; fans: RayFan[]; where: string }) {
  const total = fans.reduce((sum, fan) => sum + fan.statuses.length, 0);
  const clear = fans.reduce((sum, fan) => sum + fan.statuses.filter((status) => status === "clear").length, 0);
  return <span><i style={{ background: colour }} />{name} ({where}): {clear} of {total} rays clear ({wholePercent.format(clear / total)})</span>;
}

/**
 * The Moon as a globe with the Sun and Earth where JPL places them at the timeline's time.
 * The Moon stays still and the sky moves around it, so playing the timeline never spins the
 * ground. Zooming toward the south pole loads LOLA terrain in growing detail.
 */
export function SpaceView({ active, sites, selected, focus, run, range, timeIndex, options, sunlight, context, onSelect, layerState, onLayers, compact = false }: {
  /** Whether the view is on screen; data is only requested while it is. */
  active: boolean;
  sites: Site[];
  selected: Site | null;
  /** Fly to this site whenever it changes. */
  focus: Site | null;
  /** The selected site's simulation, whose saved rays follow the timeline. */
  run: RunStatus | null;
  range: TimeRange;
  timeIndex: number;
  options: SimulationOptions;
  /** The simulation's sunlight grid of the selected site at the timeline's time. */
  sunlight: SunlightGrid | null;
  /** NASA's long-term maps over the selected site. */
  context: SiteContext | null;
  onSelect: (id: string) => void;
  /** Layer settings owned by the parent, so two views can show the same thing. */
  layerState?: SpaceLayers;
  onLayers?: (layers: SpaceLayers) => void;
  /** A smaller version for a comparison pane: no title or credits. */
  compact?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLParagraphElement>(null);
  const compass = useRef<HTMLSpanElement>(null);
  const scene = useRef<SpaceScene | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;

  const [ready, setReady] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [standing, setStanding] = useState(false);
  const [ownLayers, setOwnLayers] = useState(defaultSpaceLayers);
  const layers = layerState ?? ownLayers;
  const { sunRays, earthRays, shading, resultLayer, exaggeration } = layers;
  const update = (change: Partial<SpaceLayers>) => (onLayers ?? setOwnLayers)({ ...layers, ...change });
  const setSunRays = (value: boolean) => update({ sunRays: value });
  const setEarthRays = (value: boolean) => update({ earthRays: value });
  const setShading = (value: boolean) => update({ shading: value });
  const setResultLayer = (value: SpaceLayers["resultLayer"]) => update({ resultLayer: value });
  const setExaggeration = (value: number) => update({ exaggeration: value });

  const sky = useSky(range, options.integration_minutes, timeIndex, active);
  const supported = selected !== null && selected.latitude_deg <= -60;
  const tracing = useSiteRays(selected, run, range, options, timeIndex, active && supported);

  useEffect(() => {
    if (!host.current || !labels.current) return;
    let mode: RigView["mode"] = "orbit";
    try {
      const view = spaceScene(host.current, labels.current, {
        onView: (current) => {
          if (readout.current) readout.current.textContent = viewText(current);
          compass.current?.style.setProperty("--north-rotation", `${current.northAngleDeg ?? 0}deg`);
          if (current.mode !== mode) {
            mode = current.mode;
            setStanding(mode === "stand");
          }
        },
        onSelect: (id) => select.current(id),
        onProblem: setProblem,
      });
      scene.current = view;
      setReady(true);
      return () => {
        view.dispose();
        scene.current = null;
        setReady(false);
      };
    } catch {
      setUnsupported(true);
    }
  }, []);

  useEffect(() => { scene.current?.setSites(sites, selected?.id ?? null); }, [ready, sites, selected]);
  useEffect(() => { if (active) scene.current?.invalidate(); }, [ready, active]);
  useEffect(() => { scene.current?.setSunShading(shading); }, [ready, shading]);
  useEffect(() => { scene.current?.setExaggeration(exaggeration); }, [ready, exaggeration]);
  useEffect(() => { if (focus) scene.current?.showSite(focus); }, [ready, focus]);

  const hasEarth = sunlight?.earth_visible_fraction_lower != null;
  const sample = sky.sample;
  useEffect(() => {
    scene.current?.setSky(sample && {
      sunKm: [sample.sun_m[0] / 1000, sample.sun_m[1] / 1000, sample.sun_m[2] / 1000],
      earthKm: [sample.earth_m[0] / 1000, sample.earth_m[1] / 1000, sample.earth_m[2] / 1000],
    });
  }, [ready, sample]);

  useEffect(() => {
    let painted = null;
    if (selected) {
      if (resultLayer === "sunlight" && sunlight) painted = sunlightCanvas(selected, sunlight);
      else if (resultLayer === "earth" && sunlight && hasEarth) painted = earthCanvas(selected, sunlight);
      else if (isContextLayer(resultLayer) && context) painted = contextCanvas(selected, context, resultLayer);
    }
    scene.current?.setResultGrid(painted && selected ? { site: selected, ...painted } : null);
  }, [ready, selected, sunlight, resultLayer, hasEarth, context]);

  const rays = supported ? tracing.rays : null;
  useEffect(() => {
    scene.current?.setRays(rays, { sun: sunRays, earth: earthRays });
  }, [ready, rays, sunRays, earthRays]);

  function stand() {
    if (!selected) return;
    // The view from the ground is only true to the simulation at real scale.
    setExaggeration(1);
    scene.current?.standAt(selected, options.mast_height_m);
  }

  const rayHint = !selected ? "Select a site to see its rays" : !supported ? "Rays are available for sites south of 60°S" : undefined;
  return <section className={compact ? "viewport terrain-viewport space-viewport space-compact" : "viewport terrain-viewport space-viewport"} aria-label="3D view of the Moon, the Sun and Earth">
    <div className="terrain-canvas" ref={host} />
    <div className="space-labels" ref={labels} />
    <div className="terrain-title">
      <h2>{standing && selected ? selected.name : "Moon, Sun and Earth"}</h2>
      <p ref={readout} />
    </div>

    {unsupported ? <div className="terrain-status" role="alert"><p>The 3D view needs WebGL 2. You can continue in the map view.</p></div> : <>
      <div className="terrain-controls">
        <span className="terrain-north" ref={compass} aria-label="North direction"><i aria-hidden="true">↑</i>N</span>
        <button className="button secondary" type="button" title="Back to the view of the south pole" onClick={() => scene.current?.showPole()}>Reset view</button>
        <button className="button secondary" type="button" disabled={!selected} onClick={() => selected && scene.current?.showSite(selected)}>Go to site</button>
        <button className="button secondary" type="button" aria-pressed={standing} disabled={!supported}
          title={supported ? "See the sky from the site centre, at mast height" : rayHint}
          onClick={() => standing ? scene.current?.leaveStand() : stand()}>
          {standing ? "Leave the surface" : "Stand at site"}
        </button>
      </div>

      <div className="space-layers">
        <LayerPicker value={resultLayer} onChange={setResultLayer}
          has={{ sunlight: sunlight !== null, earth: hasEarth, slope: false, context: context !== null }} />
        <div className="layer-buttons" role="group" aria-label="3D layers">
          <button className="button secondary" type="button" aria-pressed={sunRays} disabled={!supported} title={rayHint} onClick={() => setSunRays(!sunRays)}>Sun rays</button>
          <button className="button secondary" type="button" aria-pressed={earthRays} disabled={!supported} title={rayHint} onClick={() => setEarthRays(!earthRays)}>Earth rays</button>
          <button className="button secondary" type="button" aria-pressed={shading} title="Shade the relief from the Sun's direction. Shadows are not cast; the solar visibility layer shows the simulated result." onClick={() => setShading(!shading)}>Sun shading</button>
        </div>
        <label className="space-relief">
          <span>Relief ×{exaggeration.toFixed(1)}</span>
          <input type="range" min={1} max={3} step={0.5} value={exaggeration} disabled={standing}
            aria-label="Vertical exaggeration of the terrain" onChange={(event) => setExaggeration(Number(event.target.value))} />
        </label>
        {(sunRays || earthRays) && supported && <div className="sunlight-legend" aria-label="Rays at the site centre">
          {rays && sunRays && <RayCount name="Sun" colour={rayColours.sun} fans={rays.sun}
            where={rays.sun.length > 1 ? `${rays.sun.length} points across the site` : "site centre"} />}
          {rays && earthRays && <RayCount name="Earth" colour={rayColours.earth} fans={rays.earth}
            where={rays.earth.length > 1 ? `${rays.earth.length} points at mast height` : "mast at the site centre"} />}
          {sunRays && <span><i style={{ background: rayColours.sunBlocked }} />Sun blocked</span>}
          {earthRays && <span><i style={{ background: rayColours.earthBlocked }} />Earth blocked</span>}
          {!rays && tracing.loading && <span>Tracing rays…</span>}
          {tracing.error && <span>{tracing.error}</span>}
        </div>}
        <LayerLegend layer={resultLayer} />
      </div>

      <div className="terrain-bottom">
        {problem && <p role="alert">{problem}</p>}
        {!sample && <p role="status">{sky.error ?? "Loading the Sun and Earth positions from JPL Horizons…"}</p>}
        <p>{standing ? "Drag to look around · Scroll to zoom · Click Sun or Earth to face it"
          : "Drag to move · Right-drag to turn and tilt · Scroll to zoom · Double-click to centre"}</p>
      </div>
      <div className="map-credits">
        <a className="map-credit" href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer">NASA Moon Trek · LROC WAC / NAC</a>
        <a className="map-credit" href="https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/" target="_blank" rel="noreferrer">NASA LRO · LOLA</a>
        <a className="map-credit" href="https://ssd.jpl.nasa.gov/horizons/" target="_blank" rel="noreferrer">JPL Horizons</a>
      </div>
    </>}
  </section>;
}
