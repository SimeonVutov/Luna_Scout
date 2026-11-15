import { useEffect, useRef, useState } from "react";
import Feature from "ol/Feature";
import Map from "ol/Map";
import View from "ol/View";
import { Circle, Point, Polygon } from "ol/geom";
import { fromExtent } from "ol/geom/Polygon";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import { get as getProjection } from "ol/proj";
import VectorSource from "ol/source/Vector";
import { getRenderPixel } from "ol/render";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";
import proj4 from "proj4";
import type { Coordinate, Site, SiteSpec } from "../../api/types";
import { MapCompass } from "./MapCompass";
import type { Orientation } from "./MapCompass";
import { detailExtent, detailLayer, edge, geographic, polar, polarCoverages, polarImagery, polarRadius, shackletonExtent, shackletonImagery, shackletonSourcePage } from "./polarImagery";
import "ol/ol.css";

const projection = getProjection(polar)!;

function coverageFeature(geometry: Circle | Polygon, color: string) {
  const edge = new Feature(geometry);
  edge.setStyle([
    new Style({ stroke: new Stroke({ color: "#131820", width: 3 }) }),
    new Style({ stroke: new Stroke({ color, width: 1.5, lineDash: [6, 5] }) }),
  ]);
  return edge;
}

type Props = {
  sites: Site[];
  selectedId: string | null;
  draft: SiteSpec | null;
  picking: boolean;
  onPick: (coordinate: Coordinate) => void;
  onSelect: (id: string) => void;
  cameraTarget: Site | null;
  demoLightFraction: number | null;
};

export function SouthPoleMap(props: Props) {
  const target = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const [source] = useState(() => new VectorSource());
  const actions = useRef(props);
  const [scale, setScale] = useState(0);
  const [orientation, setOrientation] = useState<Orientation | null>(null);
  const [tileError, setTileError] = useState(false);
  actions.current = props;

  useEffect(() => {
    if (!target.current) return;
    const base = new TileLayer({ source: polarImagery("LRO_WAC_Mosaic_SPole60_100m_v02", 6) });
    const detail = new TileLayer({ extent: detailExtent, source: polarImagery(detailLayer, 12, detailExtent) });
    detail.setMaxResolution(460);
    const shackleton = new TileLayer({ extent: shackletonExtent, source: shackletonImagery(), maxResolution: 45 });
    const coverage = new VectorLayer({ source: new VectorSource({
      features: [
        ...polarCoverages.map(({ latitude, color }) => coverageFeature(new Circle([0, 0], polarRadius(latitude)), color)),
        coverageFeature(fromExtent(shackletonExtent), "#d9ebf6"),
      ],
    }) });
    const view = new View({
      projection, center: [0, 0], resolution: 2300,
      minResolution: 0.5,
      maxResolution: 3600,
      extent: [-edge, -edge, edge, edge],
      constrainOnlyCenter: true,
      enableRotation: false,
    });
    const current = new Map({
      target: target.current, view,
      layers: [base, detail, shackleton, coverage, new VectorLayer({ source })],
    });
    detail.on("prerender", (event) => {
      const context = event.context as CanvasRenderingContext2D;
      const center = getRenderPixel(event, current.getPixelFromCoordinate([0, 0]));
      const outside = getRenderPixel(event, current.getPixelFromCoordinate([polarRadius(polarCoverages[0].latitude), 0]));
      context.save();
      context.beginPath();
      context.arc(center[0], center[1], Math.hypot(outside[0] - center[0], outside[1] - center[1]), 0, 2 * Math.PI);
      context.clip();
    });
    detail.on("postrender", (event) => (event.context as CanvasRenderingContext2D).restore());
    map.current = current;
    function updateView() {
      const meters = view.getResolution() ?? 0;
      const center = view.getCenter();
      if (!center) return;
      const [x, y] = center;
      const [longitude, latitude] = proj4(polar, geographic, center);
      const atPole = Math.hypot(x, y) <= Math.max(1, meters * 2);
      setScale(meters);
      setOrientation({ longitude, latitude, northAngle: atPole ? null : Math.atan2(x, y) * 180 / Math.PI });
      const blend = Math.max(0, Math.min(1, (460 - meters) / 300));
      detail.setOpacity(blend);
      shackleton.setOpacity(Math.max(0, Math.min(1, (45 - meters) / 35)));
    }
    updateView();
    detail.getSource()?.on("tileloaderror", () => setTileError(true));
    view.on(["change:resolution", "change:center"], updateView);
    current.on("singleclick", (event) => {
      const state = actions.current;
      if (state.picking) {
        if (Math.hypot(...event.coordinate) > edge) return;
        const [longitude_deg, latitude_deg] = proj4(polar, geographic, event.coordinate);
        state.onPick({ longitude_deg: Number(longitude_deg.toFixed(6)), latitude_deg: Number(latitude_deg.toFixed(6)) });
        return;
      }
      const id = current.forEachFeatureAtPixel(event.pixel, (feature) => feature.get("siteId"));
      if (typeof id === "string") state.onSelect(id);
    });
    return () => {
      current.dispose();
      map.current = null;
    };
  }, [source]);

  const { sites, selectedId, draft, demoLightFraction, cameraTarget } = props;
  useEffect(() => {
    source.clear();
    for (const site of [...sites, ...(draft ? [{ ...draft, id: null }] : [])]) {
      const center = proj4(geographic, polar, [site.longitude_deg, site.latitude_deg]);
      if (!center.every(Number.isFinite) || Math.hypot(...center) > edge) continue;
      const selected = site.id === selectedId || site.id === null;
      const color = selected ? "#a2e0d4" : "#dde4ea";
      const localScale = 2 / (1 - Math.sin(site.latitude_deg * Math.PI / 180));
      const area = new Feature({ geometry: new Circle(center, site.radius_m * localScale), siteId: site.id });
      const marker = new Feature({ geometry: new Point(center), siteId: site.id });
      area.setStyle(new Style({
        stroke: new Stroke({ color, width: selected ? 2 : 1 }),
        fill: new Fill({ color: `rgba(162,224,212,${selected ? 0.12 + 0.3 * (demoLightFraction ?? 0) : 0.08})` }),
      }));
      marker.setStyle(new Style({ image: new CircleStyle({
        radius: selected ? 5 : 4, fill: new Fill({ color }), stroke: new Stroke({ color: "#111", width: 1 }),
      }) }));
      source.addFeatures([area, marker]);
    }
  }, [source, sites, selectedId, draft, demoLightFraction]);

  useEffect(() => {
    if (!cameraTarget) return;
    const center = proj4(geographic, polar, [cameraTarget.longitude_deg, cameraTarget.latitude_deg]);
    if (!center.every(Number.isFinite) || Math.hypot(...center) > edge) return;
    map.current?.getView().animate({ center, resolution: Math.max(0.5, cameraTarget.radius_m / 95), duration: 350 });
  }, [cameraTarget]);

  return <section className={props.picking ? "viewport polar-map picking" : "viewport polar-map"} aria-label="Lunar south-polar map">
    <div className="map-mount" ref={target} />
    <div className="viewport-label">South pole · {scale.toLocaleString(undefined, { maximumFractionDigits: 2 })} m / screen px</div>
    <MapCompass orientation={orientation} />
    <div className="coverage-key" aria-label="Imagery coverage">
      {polarCoverages.map(({ label, color }) => <span key={label} style={{ color }}>{label}</span>)}
      <span style={{ color: "#d9ebf6" }}>Shackleton · 1 m imagery</span>
    </div>
    {props.picking && <p className="map-instruction">Click the map to place the site center</p>}
    {tileError && <p className="map-note" role="status">Some NASA imagery tiles could not load.</p>}
    <button type="button" className="button secondary pole-button" onClick={() =>
      map.current?.getView().animate({ center: [0, 0], resolution: 2300, duration: 350 })
    }>South pole</button>
    <div className="map-credits">
      <a className="map-credit" href={shackletonSourcePage} target="_blank" rel="noreferrer">Shackleton Rim · 1 m LROC</a>
      <a className="map-credit" href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer">NASA Moon Trek · LROC WAC / NAC</a>
    </div>
  </section>;
}
