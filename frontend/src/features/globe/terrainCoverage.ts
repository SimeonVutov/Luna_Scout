import Feature from "ol/Feature";
import { Circle, Point, Polygon } from "ol/geom";
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from "ol/style";

/**
 * Footprints of NASA's 5 m LOLA elevation grids, in south-polar stereographic metres
 * (west, south, east, north). Everything inside 80°S has 80 m data and the rest to 60°S has 240 m.
 */
export const footprints5m = [
  { name: "Connecting Ridge", bounds: [-19000, -20000, -3000, -4000] },
  { name: "Shackleton Rim", bounds: [-9000, -15000, 7000, 1000] },
  { name: "Nobile Rim 1", bounds: [74000, 100000, 94000, 120000] },
  { name: "Peak near Shackleton", bounds: [22000, -28000, 38000, -12000] },
  { name: "de Gerlache Rim 1", bounds: [-45000, 7000, -29000, 23000] },
  { name: "Leibnitz Beta Plateau", bounds: [65000, 110000, 81000, 126000] },
  { name: "Malapert Massif", bounds: [-11000, 111000, 10000, 132000] },
  { name: "Haworth", bounds: [-52900, 75600, -23100, 105400] },
  { name: "Shoemaker", bounds: [66000, 29000, 86000, 49000] },
  { name: "Nobile Rim 2", bounds: [147000, 85000, 167000, 105000] },
] as const;

// Polar-stereographic radius of 80°S: 2R·tan(5°) on the 1,737,400 m sphere.
const regional80Radius = 303_990;
const gold = "#e4c48c";

const label = (text: string) => new Text({
  text, font: "600 11px 'Inter Variable', Inter, sans-serif", fill: new Fill({ color: "#f3e6c8" }),
  stroke: new Stroke({ color: "#10151a", width: 3 }), overflow: true,
});

// Zoomed out, a 16 km square is a few pixels wide: draw a marker instead, and names only when readable.
const markersBelow = 500;
const namesBelow = 300;

export function coverageFeatures() {
  const squares = footprints5m.map(({ name, bounds: [west, south, east, north] }) => {
    const feature = new Feature(new Polygon([[[west, south], [east, south], [east, north], [west, north], [west, south]]]));
    const centre = new Point([(west + east) / 2, (south + north) / 2]);
    feature.setStyle((_feature, resolution) => [
      new Style({
        stroke: new Stroke({ color: gold, width: 1.5 }), fill: new Fill({ color: "rgba(228,196,140,0.12)" }),
        text: resolution < namesBelow ? label(name) : undefined,
      }),
      ...(resolution > markersBelow ? [new Style({
        geometry: centre,
        image: new CircleStyle({ radius: 4, fill: new Fill({ color: gold }), stroke: new Stroke({ color: "#10151a", width: 1 }) }),
      })] : []),
    ]);
    return feature;
  });
  const regional = new Feature(new Circle([0, 0], regional80Radius));
  regional.setStyle(new Style({ stroke: new Stroke({ color: "#9aa7b4", width: 1.2, lineDash: [6, 5] }) }));
  return [regional, ...squares];
}
