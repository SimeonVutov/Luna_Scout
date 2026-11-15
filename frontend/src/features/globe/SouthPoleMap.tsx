import { useEffect, useRef, useState } from "react";
import Feature from "ol/Feature";
import Map from "ol/Map";
import View from "ol/View";
import { Point } from "ol/geom";
import { siteFootprint } from "./mapCoordinates";
import ImageLayer from "ol/layer/Image";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import { getPointResolution } from "ol/proj";
import VectorSource from "ol/source/Vector";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";
import proj4 from "proj4";
import type { Coordinate, Site, SiteContext, SiteSpec, SlopeGrid, SunlightGrid } from "../../api/types";
import { LayerLegend } from "../results/LayerLegend";
import { LayerPicker } from "../results/LayerPicker";
import { isContextLayer, layerAvailability } from "../results/mapLayers";
import type { MapLayer } from "../results/mapLayers";
import { contextOverlay, earthOverlay, slopeOverlay, sunlightOverlay } from "./sunlightOverlay";
import { MapCompass } from "./MapCompass";
import type { Orientation } from "./MapCompass";
import { detailExtent, detailLayer, edge, geographic, globalExtent, globalImagery, polar, polarImagery } from "./polarImagery";
import "ol/ol.css";
import "../globe/map.css";

type MapMode = "south" | "global";
export type { MapLayer };

function createView(mode: MapMode) {
  if (mode === "global") {
    return new View({
      projection: geographic, center: [0, -30], resolution: 0.7,
      minResolution: 0.00001, maxResolution: 1.4,
      extent: globalExtent, constrainOnlyCenter: true, enableRotation: false,
    });
  }
  return new View({
    projection: polar, center: [0, 0], resolution: 2300,
    minResolution: 0.5, maxResolution: 3600,
    extent: [-edge, -edge, edge, edge], constrainOnlyCenter: true, enableRotation: false,
  });
}

function isOnMap(longitude: number, latitude: number) {
  return Number.isFinite(longitude) && Number.isFinite(latitude) &&
    longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
}

type Props = {
  sites: Site[];
  selectedId: string | null;
  draft: SiteSpec | null;
  picking: boolean;
  onPick: (coordinate: Coordinate) => void;
  onSelect: (id: string) => void;
  cameraTarget: Site | null;
  sunlight: SunlightGrid | null;
  slope: SlopeGrid | null;
  /** NASA's long-term maps over the selected site. */
  context: SiteContext | null;
  layer: MapLayer;
  onLayerChange: (layer: MapLayer) => void;
  /** Keep the map on the south-polar view only, with no Whole Moon option. */
  southOnly?: boolean;
};

export function SouthPoleMap(props: Props) {
  const target = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const [source] = useState(() => new VectorSource());
  const [overlay] = useState(() => new ImageLayer());
  const actions = useRef(props);
  const lastCameraTarget = useRef<Site | null>(null);
  const [mode, setMode] = useState<MapMode>("south");
  const [scale, setScale] = useState(0);
  const [orientation, setOrientation] = useState<Orientation | null>(null);
  const [tileError, setTileError] = useState(false);
  actions.current = props;

  useEffect(() => {
    if (!target.current) return;
    const base = new TileLayer({
      source: mode === "global" ? globalImagery() : polarImagery("LRO_WAC_Mosaic_SPole60_100m_v02", 6),
    });
    const detail = new TileLayer({ extent: detailExtent, source: polarImagery(detailLayer, 12, detailExtent, true) });
    detail.setMaxResolution(460);
    const view = createView(mode);
    const layers = mode === "south" ? [base, detail] : [base];
    const current = new Map({
      target: target.current, view,
      layers: [...layers, overlay, new VectorLayer({ source })],
    });
    map.current = current;
    function updateView() {
      const meters = view.getResolution() ?? 0;
      const center = view.getCenter();
      if (!center) return;
      const [x, y] = center;
      const [longitude, latitude] = mode === "south" ? proj4(polar, geographic, center) : center;
      const atPole = mode === "south" ? Math.hypot(x, y) <= Math.max(1, meters * 2) : Math.abs(latitude) === 90;
      setScale(getPointResolution(view.getProjection(), meters, center, "m"));
      setOrientation({ longitude, latitude, northAngle: atPole ? null : mode === "south" ? Math.atan2(x, y) * 180 / Math.PI : 0 });
      const blend = Math.max(0, Math.min(1, (460 - meters) / 300));
      detail.setOpacity(blend);
    }
    updateView();
    setTileError(false);
    base.getSource()?.on("tileloaderror", () => setTileError(true));
    detail.getSource()?.on("tileloaderror", () => setTileError(true));
    view.on(["change:resolution", "change:center"], updateView);
    current.on("singleclick", (event) => {
      const state = actions.current;
      if (state.picking) {
        const [longitude_deg, latitude_deg] = mode === "south" ?
          proj4(polar, geographic, event.coordinate) : event.coordinate;
        if (!isOnMap(longitude_deg, latitude_deg)) return;
        state.onPick({ longitude_deg: Number(longitude_deg.toFixed(6)), latitude_deg: Number(latitude_deg.toFixed(6)) });
        return;
      }
      const id = current.forEachFeatureAtPixel(event.pixel, (feature) => feature.get("siteId"));
      if (typeof id === "string") state.onSelect(id);
    });
    return () => {
      // Sources and the result layer survive projection switches.
      current.getLayers().clear();
      current.dispose();
      map.current = null;
    };
  }, [mode, overlay, source]);

  const { sites, selectedId, draft, sunlight, slope, layer, cameraTarget } = props;
  const selectedSite = sites.find((site) => site.id === selectedId);
  const hasEarth = sunlight?.earth_visible_fraction_lower != null;
  const { context } = props;
  const overlayShown = layer === "sunlight" ? sunlight !== null : layer === "earth" ? hasEarth : layer === "slope" ? slope !== null : isContextLayer(layer) ? context !== null : false;
  useEffect(() => {
    let image = null;
    if (selectedSite && layer === "sunlight" && sunlight) image = sunlightOverlay(selectedSite, sunlight);
    if (selectedSite && layer === "earth" && sunlight && hasEarth) image = earthOverlay(selectedSite, sunlight);
    if (selectedSite && layer === "slope" && slope) image = slopeOverlay(selectedSite, slope);
    if (selectedSite && isContextLayer(layer) && context) image = contextOverlay(selectedSite, context, layer);
    overlay.setSource(image);
  }, [overlay, selectedSite, sunlight, slope, layer, hasEarth, context]);
  useEffect(() => {
    source.clear();
    for (const site of [...sites, ...(draft ? [{ ...draft, id: null }] : [])]) {
      if (!isOnMap(site.longitude_deg, site.latitude_deg)) continue;
      if (mode === "south" && site.latitude_deg > -60) continue;
      const coordinates = [site.longitude_deg, site.latitude_deg];
      const center = mode === "south" ? proj4(geographic, polar, coordinates) : coordinates;
      const selected = site.id === selectedId || site.id === null;
      const color = selected ? "#a2e0d4" : "#dde4ea";
      const footprint = siteFootprint(site, mode === "south");
      const area = new Feature({ geometry: footprint, siteId: site.id });
      const marker = new Feature({ geometry: new Point(center), siteId: site.id });
      area.setStyle(new Style({
        stroke: new Stroke({ color, width: selected ? 2 : 1 }),
        fill: new Fill({ color: selected && overlayShown ? "transparent" : "rgba(162,224,212,0.08)" }),
      }));
      marker.setStyle(new Style({ image: new CircleStyle({
        radius: selected ? 5 : 4, fill: new Fill({ color }), stroke: new Stroke({ color: "#111", width: 1 }),
      }) }));
      source.addFeatures([area, marker]);
    }
  }, [mode, source, sites, selectedId, draft, overlayShown]);

  useEffect(() => {
    if (!cameraTarget || cameraTarget === lastCameraTarget.current) return;
    if (mode === "south" && cameraTarget.latitude_deg > -60) {
      if (!props.southOnly) setMode("global");
      return;
    }
    const coordinates = [cameraTarget.longitude_deg, cameraTarget.latitude_deg];
    if (!isOnMap(cameraTarget.longitude_deg, cameraTarget.latitude_deg)) return;
    const center = mode === "south" ? proj4(geographic, polar, coordinates) : coordinates;
    const view = map.current?.getView();
    if (!view) return;
    // Pixel scale conversion: δ = m / k.
    // δ - View units per pixel; m - Desired metres per pixel; k - Metres per view unit.
    const metresPerUnit = getPointResolution(view.getProjection(), 1, center, "m");
    const resolution = Math.max(0.5, cameraTarget.radius_m / 95) / metresPerUnit;
    lastCameraTarget.current = cameraTarget;
    view.animate({ center, resolution, duration: 350 });
  }, [mode, cameraTarget]);

  return <section className={props.picking ? "viewport polar-map picking" : "viewport polar-map"} aria-label={mode === "south" ? "Lunar south-polar map" : "Whole Moon map"}>
    <div className="map-mount" ref={target} />
    <div className="viewport-label">{mode === "south" ? "South pole" : "Whole Moon"} · {scale.toLocaleString(undefined, { maximumFractionDigits: 2 })} m / screen px</div>
    <MapCompass orientation={orientation} />
    {!props.picking && (sunlight || slope || context) && <div className="map-simulation-key">
      <LayerPicker value={layer} onChange={props.onLayerChange}
        unavailable={layerAvailability({ sunlight: sunlight !== null, earth: hasEarth, slope: slope !== null, context: context !== null, slopeSupported: true })} />
      <LayerLegend layer={layer} />
    </div>}
    {props.picking && <p className="map-instruction">Click the map to place the site center</p>}
    {tileError && <p className="map-note" role="status">Some NASA imagery tiles could not load.</p>}
    {!props.southOnly && <div className="map-navigation" role="group" aria-label="Map coverage">
      <button type="button" className="button secondary" aria-pressed={mode === "global"} onClick={() => {
        if (mode === "global") map.current?.getView().fit(globalExtent, { padding: [40, 40, 40, 40], duration: 350 });
        else setMode("global");
      }}>Whole Moon</button>
      <button type="button" className="button secondary" aria-pressed={mode === "south"} onClick={() => {
        if (mode === "south") map.current?.getView().animate({ center: [0, 0], resolution: 2300, duration: 350 });
        else setMode("south");
      }}>South pole</button>
    </div>}
    <div className="map-credits">
      <a className="map-credit" href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer">NASA Moon Trek · LROC WAC / NAC</a>
    </div>
  </section>;
}
