import type { BodyView } from "../../api/types";
import "./skyCloseUp.css";

const width = 260;
const height = 130;
const diskSamples = 56;
const bodyColor = { Sun: "#f5b84a", Earth: "#6fb3ff" } as const;

type Skyline = { values: (number | null)[]; step: number };

/** Terrain horizon elevation at an azimuth, interpolated between bin centres; NaN where unknown. */
function horizonAt(skyline: Skyline, azimuth: number) {
  const count = skyline.values.length;
  const position = ((azimuth % 360) + 360) % 360 / skyline.step - 0.5;
  const lower = Math.floor(position);
  const weight = position - lower;
  const first = skyline.values[((lower % count) + count) % count];
  const second = skyline.values[(((lower + 1) % count) + count) % count];
  if (first === null || second === null) return Number.NaN;
  return first * (1 - weight) + second * weight;
}

/** Fraction of the apparent disk above the horizon: points spread evenly over its area. */
export function visibleDiskFraction(view: BodyView, skyline: Skyline) {
  if (view.azimuth_deg === null) return null;
  const radius = view.angular_radius_deg;
  const cosElevation = Math.max(0.05, Math.cos(view.elevation_deg * Math.PI / 180));
  let inside = 0;
  let visible = 0;
  for (let row = 0; row < diskSamples; row++) {
    for (let column = 0; column < diskSamples; column++) {
      const x = ((column + 0.5) / diskSamples * 2 - 1);
      const y = ((row + 0.5) / diskSamples * 2 - 1);
      if (x * x + y * y > 1) continue;
      inside++;
      const horizon = horizonAt(skyline, view.azimuth_deg + x * radius / cosElevation);
      if (view.elevation_deg + y * radius > horizon) visible++;
    }
  }
  return inside ? visible / inside : null;
}

/**
 * The Sun or Earth against the real terrain skyline at true angular scale. Both axes use the
 * same degrees per pixel, so the disk keeps its shape and a ridge hides what it really hides.
 */
export function SkyCloseUp({ label, view, skyline, step, compact = false }: {
  label: "Sun" | "Earth";
  view: BodyView | null | undefined;
  skyline: (number | null)[] | null | undefined;
  step: number;
  compact?: boolean;
}) {
  if (!view || view.azimuth_deg === null || !skyline) {
    return <figure className="sky-closeup empty"><figcaption><strong>{label}</strong><span>Run the simulation to see it.</span></figcaption></figure>;
  }

  const lines: Skyline = { values: skyline, step };
  const halfWidth = Math.max(1.2, 3.2 * view.angular_radius_deg);
  const degreesPerPixel = 2 * halfWidth / width;
  const cosElevation = Math.max(0.05, Math.cos(view.elevation_deg * Math.PI / 180));
  const y = (elevation: number) => height / 2 - (elevation - view.elevation_deg) / degreesPerPixel;

  const profile: string[] = [];
  for (let x = 0; x <= width; x += 2) {
    const azimuth = view.azimuth_deg + ((x / width) - 0.5) * 2 * halfWidth / cosElevation;
    const horizon = horizonAt(lines, azimuth);
    if (Number.isFinite(horizon)) profile.push(`${x},${Math.min(height + 4, Math.max(-4, y(horizon))).toFixed(1)}`);
  }

  const fraction = visibleDiskFraction(view, lines);
  const horizonAtBody = horizonAt(lines, view.azimuth_deg);
  const radiusPixels = view.angular_radius_deg / degreesPerPixel;
  const color = bodyColor[label];
  return <figure className={compact ? "sky-closeup compact" : "sky-closeup"}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`${label} against the terrain skyline: ${fraction === null ? "unknown" : Math.round(fraction * 100) + "% visible"}`}>
      <rect width={width} height={height} fill="#0b1424" />
      <line x1="0" x2={width} y1={y(0)} y2={y(0)} className="level-line" />
      <circle cx={width / 2} cy={height / 2} r={radiusPixels} fill={color} />
      {profile.length > 1 && <polygon className="skyline-fill" points={`0,${height + 4} ${profile.join(" ")} ${width},${height + 4}`} />}
      {profile.length > 1 && <polyline className="skyline-edge" points={profile.join(" ")} fill="none" />}
      {fraction === 0 && <>
        <text className="hidden-note" x={width / 2} y={height / 2 - 4} textAnchor="middle">{label} is behind the terrain</text>
        <text className="hidden-detail" x={width / 2} y={height / 2 + 12} textAnchor="middle">
          horizon {horizonAtBody.toFixed(1)}° · {label.toLowerCase()} {view.elevation_deg.toFixed(1)}°
        </text>
      </>}
      <text className="scale-note" x="6" y={height - 6}>true angular scale</text>
    </svg>
    <figcaption>
      <strong style={{ color }}>{label}</strong>
      <span>{fraction === null ? "—" : `${Math.round(fraction * 100)}% visible`}</span>
      <small>az {view.azimuth_deg.toFixed(0)}° · el {view.elevation_deg.toFixed(2)}°</small>
    </figcaption>
  </figure>;
}
