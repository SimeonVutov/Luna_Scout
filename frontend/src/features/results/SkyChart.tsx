import type { Reading, TimeRange } from "../../api/types";

const left = 22;
const top = 8;
const width = 228;
const height = 68;

export function SkyChart({ samples, at, range }: { samples: Reading[]; at: Date; range: TimeRange }) {
  const points = samples.flatMap((sample) => [
    sample.sun_at_collector?.elevation_deg, sample.earth_at_mast?.elevation_deg,
  ]).filter((value): value is number => value !== undefined);
  if (!points.length) return null;

  const start = Date.parse(range.start_utc);
  const duration = Date.parse(range.end_utc) - start;
  const high = Math.max(1, ...points) + 0.3;
  const low = Math.min(-1, ...points) - 0.3;
  const x = (time: number) => left + width * (time - start) / duration;
  const y = (elevation: number) => top + height * (high - elevation) / (high - low);

  function path(field: "sun_at_collector" | "earth_at_mast") {
    let last = -Infinity;
    return samples.map((sample) => {
      const time = Date.parse(sample.at_utc);
      const position = sample[field];
      if (!position) { last = -Infinity; return ""; }
      const contiguous = time - last <= range.snapshot_minutes * 60_000;
      last = time;
      return `${contiguous ? "L" : "M"}${x(time).toFixed(1)},${y(position.elevation_deg).toFixed(1)}`;
    }).join(" ");
  }

  const current = samples.find((sample) => Date.parse(sample.at_utc) === at.valueOf());
  const cursor = x(at.valueOf());
  return <figure className="sky-chart">
    <figcaption>Elevation above local horizontal</figcaption>
    <svg viewBox="0 0 256 84" role="img" aria-label="Sun and Earth elevation at completed timeline snapshots">
      <text x="2" y={y(0) + 3}>0°</text>
      <line className="chart-guide" x1={left} x2={left + width} y1={y(0)} y2={y(0)} />
      <line className="chart-guide playhead" x1={cursor} x2={cursor} y1={top} y2={top + height} />
      <path className="chart-sun" d={path("sun_at_collector")} />
      <path className="chart-earth" d={path("earth_at_mast")} />
      {current?.sun_at_collector && <circle className="chart-dot sun" cx={cursor} cy={y(current.sun_at_collector.elevation_deg)} r="2.6" />}
      {current?.earth_at_mast && <circle className="chart-dot earth" cx={cursor} cy={y(current.earth_at_mast.elevation_deg)} r="2.6" />}
    </svg>
    <div className="chart-legend"><span className="sun">Sun</span><span>Earth</span></div>
  </figure>;
}
