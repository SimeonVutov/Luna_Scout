import { useEffect, useRef, useState } from "react";
import { terrainPreview } from "../../api/client";
import type { Site, SunlightGrid, TerrainPreview } from "../../api/types";
import { SunlightLegend } from "../results/SunlightLegend";
import { terrainScene } from "./terrainScene";

const number = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

export function TerrainView({ site, sunlight, showSunlight, onToggleSunlight }: {
  site: Site;
  sunlight: SunlightGrid | null;
  showSunlight: boolean;
  onToggleSunlight: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const compass = useRef<HTMLSpanElement>(null);
  const scene = useRef<ReturnType<typeof terrainScene> | null>(null);
  const [data, setData] = useState<TerrainPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [scale, setScale] = useState<"site" | "region">("site");
  const { latitude_deg, longitude_deg, radius_m } = site;

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    void terrainPreview({ name: "Terrain preview", latitude_deg, longitude_deg, radius_m }, scale, controller.signal)
      .then((preview) => {
        if (!controller.signal.aborted) setData(preview);
      }).catch((error) => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load LOLA terrain.");
      });
    return () => controller.abort();
  }, [latitude_deg, longitude_deg, radius_m, scale, attempt]);

  useEffect(() => {
    if (!host.current || !data) return;
    try {
      const view = terrainScene(host.current, data, radius_m, (angle) => {
        compass.current?.style.setProperty("--north-rotation", `${angle}deg`);
      });
      scene.current = view;
      return () => {
        view.dispose();
        scene.current = null;
      };
    } catch {
      setError("3D terrain needs WebGL 2. You can continue in the map view.");
    }
  }, [data, radius_m]);

  useEffect(() => {
    scene.current?.paint(showSunlight ? sunlight : null);
  }, [data, sunlight, showSunlight]);

  const heights = data?.heights_m.filter((height): height is number => height !== null) ?? [];
  const span = data ? (data.offsets_m.at(-1)! - data.offsets_m[0]) / 1000 : 0;
  return <section className="viewport terrain-viewport" aria-label="3D elevation view">
    <div className="terrain-canvas" ref={host} />
    <div className="terrain-title">
      <h2>{site.name}</h2>
      <p>LOLA terrain{span > 0 && ` · ${span.toFixed(1)} km window · 1× scale`}</p>
    </div>
    {error ? <div className="terrain-status" role="alert">
      <p>{error}</p>
      <button className="button secondary" type="button" onClick={() => {
        setData(null);
        setAttempt((value) => value + 1);
      }}>Retry terrain</button>
    </div> : !data ? <p className="terrain-status" role="status">Loading LOLA elevations…</p> : <>
      <div className="terrain-controls">
        <span className="terrain-north" ref={compass} aria-label="North direction"><i aria-hidden="true">↑</i>N</span>
        <button className="button secondary" type="button" onClick={() => scene.current?.reset()}>Reset view</button>
        <button className="button secondary" type="button" aria-pressed={scale === "region"}
          onClick={() => setScale(scale === "site" ? "region" : "site")}>
          {scale === "site" ? "Regional view" : "Return to site"}
        </button>
        {sunlight && <button className="button secondary" type="button" aria-pressed={showSunlight} onClick={onToggleSunlight}>
          Solar visibility
        </button>}
      </div>
      <div className="terrain-bottom">
        {showSunlight && sunlight && <SunlightLegend />}
        <p>{number.format(Math.min(...heights))} to {number.format(Math.max(...heights))} m elevation</p>
        <p>Drag to orbit · Right-drag to pan · Scroll to zoom</p>
      </div>
      <a className="map-credit terrain-credit" href="https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/" target="_blank" rel="noreferrer">
        NASA LRO · LOLA
      </a>
    </>}
  </section>;
}
