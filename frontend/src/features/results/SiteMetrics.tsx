import type { Reading, RunStatus, SiteInsight, Visibility } from "../../api/types";
import { bound, countdown, decimal, earthLabel, energy, longestLabel, ratio, sunLabel, windowTime } from "./format";
import { detailLabel, terrainQuality } from "./TerrainSection";
import "./statTiles.css";

const receiverNoun = { vertical_tracking: "vertical panel", terrain: "ground", horizontal: "flat plate", fixed: "receiver" } as const;

function receiverLabel(run: RunStatus | null) {
  return receiverNoun[run?.plan.settings?.receiver ?? "vertical_tracking"];
}

function status(state: Visibility, labels: Record<Visibility, string>, text: string | null) {
  return text ? `${labels[state]} · ${text}` : labels[state];
}

/** Sun and Earth state at the playhead with exact countdowns, once the run is complete. */
function bodyStates(reading: Reading, run: RunStatus | null, at: Date) {
  const period = run?.period;
  const rangeEnd = run?.plan.end_utc ?? "";
  const sun = countdown(period?.sun_windows, at, rangeEnd, { ends: "sets", begins: "rises" });
  const earth = countdown(period?.earth_windows, at, rangeEnd, { ends: "sets", begins: "rises" });
  return {
    sun: sun ? status(sun.state, sunLabel, sun.text) : reading.sun_at_collector && reading.sun_at_collector.elevation_deg > 0 ? "Above the level horizon" : "Below the level horizon",
    sunState: sun?.state,
    earth: status(earth?.state ?? reading.earth_center_visibility, earthLabel, earth?.text ?? null),
    earthState: earth?.state ?? reading.earth_center_visibility,
  };
}

export function SelectedTimeMetrics({ reading, run, at }: { reading: Reading; run: RunStatus | null; at: Date }) {
  const states = bodyStates(reading, run, at);
  const summary = reading.summary;
  return <dl className="metrics">
    <div><dt>Lit area · any Sun</dt><dd>{bound(summary.lit_area_fraction, ratio)}</dd></div>
    <div><dt>Lit area · ≥ half the Sun</dt><dd>{bound(summary.half_disk_lit_area_fraction, ratio)}</dd></div>
    <div><dt>Lit and gentle (≤ 10°)</dt><dd>{bound(summary.usable_area_fraction, ratio)}</dd></div>
    <div><dt>Irradiance on {receiverLabel(run)}</dt><dd>{bound(summary.mean_irradiance_on_known_ground_w_m2, decimal, " W/m²")}</dd></div>
    <div><dt>Sun at centre</dt><dd className={states.sunState === "clear" ? "visible-value" : ""}>{states.sun}</dd></div>
    <div><dt>Earth at {run?.plan.settings?.mast_height_m ?? 2} m mast</dt><dd className={states.earthState === "clear" ? "visible-value" : ""}>{states.earth}</dd></div>
    <div><dt>Earth disk visible</dt><dd>{bound(reading.earth_disk_visible_fraction, ratio)}</dd></div>
    {summary.earth_visible_area_fraction && <div><dt>Area seeing ≥ half of Earth</dt><dd>{bound(summary.earth_visible_area_fraction, ratio)}</dd></div>}
    <div><dt>Sun elevation</dt><dd>{reading.sun_at_collector ? `${decimal.format(reading.sun_at_collector.elevation_deg)}°` : "—"}</dd></div>
    <div><dt>Earth elevation</dt><dd>{reading.earth_at_mast ? `${decimal.format(reading.earth_at_mast.elevation_deg)}°` : "—"}</dd></div>
    {summary.sun_resolved_area_fraction < 0.999 && <div><dt>Resolved footprint</dt><dd>{ratio.format(summary.sun_resolved_area_fraction)}</dd></div>}
  </dl>;
}

/** Headline numbers for one site, laid out as tiles for the compare panes. */
export function StatTiles({ reading, run, at, insight }: { reading: Reading | null; run: RunStatus | null; at: Date; insight?: SiteInsight | null }) {
  if (!reading) return <p className="result-note" role="status">{run ? "Waiting for this snapshot…" : "Run the simulation to calculate this snapshot."}</p>;

  const states = bodyStates(reading, run, at);
  const summary = reading.summary;
  type Tile = { label: string; value: string; tone?: "good" | "warn" };
  const headline: Tile[] = [
    { label: "Lit area · any Sun", value: bound(summary.lit_area_fraction, ratio) },
    { label: "Lit and gentle (≤ 10°)", value: bound(summary.usable_area_fraction, ratio) },
    { label: "Sun at centre", value: states.sun, tone: states.sunState === "clear" ? "good" : undefined },
    { label: "Earth at mast", value: states.earth, tone: states.earthState === "clear" ? "good" : undefined },
  ];
  const more: Tile[] = [
    { label: "Lit · at least half the Sun", value: bound(summary.half_disk_lit_area_fraction, ratio) },
    { label: `Irradiance on ${receiverLabel(run)}`, value: bound(summary.mean_irradiance_on_known_ground_w_m2, decimal, " W/m²") },
    { label: "Earth disk visible", value: bound(reading.earth_disk_visible_fraction, ratio) },
    ...(summary.earth_visible_area_fraction ? [{ label: "Area seeing Earth", value: bound(summary.earth_visible_area_fraction, ratio) }] : []),
    ...(insight ? [{ label: "Terrain detail", value: detailLabel(insight.summary), tone: terrainQuality(insight.summary) === "fine" ? undefined : "warn" as const }] : []),
  ];
  const render = (tiles: Tile[]) => tiles.map((tile) => <div key={tile.label}><dt>{tile.label}</dt><dd className={tile.tone === "good" ? "visible-value" : tile.tone === "warn" ? "warn-value" : ""}>{tile.value}</dd></div>);
  return <>
    <dl className="stat-tiles headline">{render(headline)}</dl>
    <details className="more-tiles">
      <summary>More details</summary>
      <dl className="stat-tiles">{render(more)}</dl>
    </details>
  </>;
}

export function PeriodMetricsList({ run }: { run: RunStatus }) {
  const period = run.period;
  if (!period) return null;

  const cadence = run.plan.integration_minutes;
  return <>
    <dl className="metrics">
      <div><dt>Area-weighted sunlit time</dt><dd>{bound(period.sunlit_hours, decimal, " h")}</dd></div>
      <div><dt>Sunlit time · ≥ half the Sun</dt><dd>{bound(period.half_disk_sunlit_hours, decimal, " h")}</dd></div>
      <div><dt>Mean solar energy</dt><dd>{bound(period.incident_energy_kwh_m2, energy, " kWh/m²")}</dd></div>
      <div><dt>Earth visible time</dt><dd>{bound(period.earth_visible_hours, decimal, " h")}</dd></div>
      <div><dt>Longest day · continuous sunlight</dt><dd>{longestLabel(period.longest_daylight)}</dd></div>
      <div><dt>Longest darkness at centre</dt><dd>{longestLabel(period.longest_darkness)}</dd></div>
      <div><dt>Longest Earth contact</dt><dd>{longestLabel(period.longest_earth_contact)}</dd></div>
      <div><dt>Longest Earth blackout</dt><dd>{longestLabel(period.longest_earth_blackout)}</dd></div>
    </dl>
    <p className="result-note">Site metrics every {cadence} min · centre Sun and Earth windows to about 1 s. “≥” means the period ends before the state does.</p>
    {period.sun_windows && <details className="science-details">
      <summary>Sun windows at the centre</summary>
      <WindowList windows={period.sun_windows} labels={sunLabel} />
    </details>}
    <details className="science-details">
      <summary>Earth visibility windows</summary>
      <WindowList windows={period.earth_windows} labels={earthLabel} />
    </details>
    {period.days.length > 1 && <details className="science-details">
      <summary>Daily summary (UTC)</summary>
      <ul className="window-list">
        {period.days.map((day) => <li key={day.date_utc}>
          <strong>{day.date_utc}</strong><span>{bound(day.incident_energy_kwh_m2, energy, " kWh/m²")} · Earth {bound(day.earth_visible_hours, decimal, " h")}</span>
        </li>)}
      </ul>
    </details>}
  </>;
}

function WindowList({ windows, labels }: { windows: { start_utc: string; end_utc: string; visibility: Visibility }[]; labels: Record<Visibility, string> }) {
  return <ul className="window-list">
    {windows.map((window) => <li key={window.start_utc}>
      <strong>{labels[window.visibility]}</strong>
      <span>{windowTime(window.start_utc)} – {windowTime(window.end_utc)}</span>
    </li>)}
  </ul>;
}
