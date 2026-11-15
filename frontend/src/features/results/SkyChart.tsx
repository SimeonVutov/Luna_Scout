import type { DemoSnapshot } from "./demoResults";

const plotWidth = 236;
const plotHeight = 64;
const top = 9;
const left = 14;
const y = (elevation: number) => top + (6 - elevation) * plotHeight / 12;

function path(samples: DemoSnapshot[], field: "sunElevationDeg" | "earthElevationDeg") {
  return samples.map((sample, idx) => {
    const x = left + plotWidth * idx / Math.max(1, samples.length - 1);
    return `${idx ? "L" : "M"}${x.toFixed(1)},${y(sample[field]).toFixed(1)}`;
  }).join(" ");
}

export function SkyChart({ samples, position, current }: {
  samples: DemoSnapshot[];
  position: number;
  current: DemoSnapshot;
}) {
  const x = left + plotWidth * position;
  return (
    <figure className="sky-chart">
      <figcaption>Elevation over time</figcaption>
      <svg viewBox="0 0 254 82" role="img" aria-label="Synthetic Sun and Earth elevations over the selected UTC range, with the current time marked">
        <text x="0" y={y(0) + 3}>0°</text>
        <line className="chart-guide" x1={left} x2={left + plotWidth} y1={y(0)} y2={y(0)} />
        <line className="chart-guide horizon" x1={left} x2={left + plotWidth} y1={y(current.horizonDeg)} y2={y(current.horizonDeg)} />
        <line className="chart-guide playhead" x1={x} x2={x} y1={top} y2={top + plotHeight} />
        <path className="chart-sun" d={path(samples, "sunElevationDeg")} />
        <path className="chart-earth" d={path(samples, "earthElevationDeg")} />
        <circle className="chart-dot sun" cx={x} cy={y(current.sunElevationDeg)} r="2.6" />
        <circle className="chart-dot earth" cx={x} cy={y(current.earthElevationDeg)} r="2.6" />
      </svg>
      <div className="chart-legend"><span className="sun">Sun</span><span className="earth">Earth</span><span className="horizon">Demo horizon</span></div>
    </figure>
  );
}
