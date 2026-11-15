import type { FormEvent } from "react";
import type { Bounds, Reading, RunStatus, SimulationOptions, Site, TimeRange, Visibility } from "../../api/types";
import { coordinatesLabel } from "../sites/referenceSites";
import { clockLabel, dateLabel } from "../timeline/time";
import { SkyChart } from "./SkyChart";
import { isActive } from "./useScience";

const decimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const energy = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const ratio = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 });
const earthLabel: Record<Visibility, string> = { clear: "Visible", blocked: "Blocked", unknown: "Unresolved" };

function bound(value: Bounds | null | undefined, format: Intl.NumberFormat, unit = "") {
  if (!value) return "—";
  const lower = format.format(value.lower);
  const upper = format.format(value.upper);
  return lower === upper ? lower + unit : `${lower}–${upper}${unit}`;
}

function windowTime(iso: string) {
  const time = new Date(iso);
  return `${dateLabel(time)} ${clockLabel(time)}`;
}

type PanelProps = {
  site: Site | null;
  at: Date;
  range: TimeRange;
  index: number;
  run: RunStatus | null;
  reading: Reading | null;
  series: Reading[];
  frameError: string | null;
  submitting: boolean;
  reconnecting: boolean;
  priorityError: string | null;
  options: SimulationOptions;
  onOptions: (options: SimulationOptions) => void;
  onRun: () => void;
  sites: Site[];
  comparison: Site | null;
  compareRun: RunStatus | null;
  compareReading: Reading | null;
  onCompare: (id: string) => void;
  canStart: boolean;
};

function OptionForm({ options, onOptions }: { options: SimulationOptions; onOptions: (options: SimulationOptions) => void }) {
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onOptions({
      grid_spacing_m: Number(data.get("spacing")),
      solar_disk_samples: Number(data.get("rays")),
      integration_minutes: Number(data.get("cadence")),
      mast_height_m: Number(data.get("mast")),
    });
  }

  return <details className="science-details">
    <summary>Simulation settings</summary>
    <form className="science-form" onSubmit={apply}>
      <label>Grid spacing (m)<input required name="spacing" type="number" min="0.1" step="any" defaultValue={options.grid_spacing_m} /></label>
      <label>Solar disk rays<input required name="rays" type="number" min="1" step="1" defaultValue={options.solar_disk_samples} /></label>
      <label>Mast height (m)<input required name="mast" type="number" min="0" step="any" defaultValue={options.mast_height_m} /></label>
      <label>Sample every
        <select name="cadence" defaultValue={options.integration_minutes}>
          {[5, 10, 15, 20, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
        </select>
      </label>
      <button className="button secondary" type="submit">Apply settings</button>
    </form>
  </details>;
}

export function ResultsPanel(props: PanelProps) {
  const { site, at, range, index, run, reading, series, comparison, compareRun, compareReading } = props;
  const period = run?.period;
  const queued = run?.stage === "queued";
  const active = isActive(run);
  const completed = run?.stage === "complete";
  const comparisonActive = comparison && (active || isActive(compareRun));
  const retry = run?.stage === "failed" || compareRun?.stage === "failed";
  const supported = site !== null && site.latitude_deg <= -60 && (!comparison || comparison.latitude_deg <= -60);
  const title = !supported ? "Outside terrain coverage" : props.submitting ? "Submitting…" :
    props.canStart ? (retry ? "Retry simulation" : comparison ? "Run comparison" : "Run simulation") :
    comparison ? (comparisonActive ? "Comparison running" : "Comparison complete") :
    completed ? "Simulation complete" : queued ? "Simulation queued" : "Simulation running";

  return <aside className="panel results-panel" aria-label="Site results">
    <div className="panel-title"><h2>Site results</h2></div>
    {!site ? <p className="sidebar-note">Add a landing site to explore its terrain and sunlight.</p> : <>
      <div className="result-site">
        <h3>{site.name}</h3>
        <p>{coordinatesLabel(site.latitude_deg, site.longitude_deg)} · {decimal.format(site.radius_m)} m radius</p>
      </div>

      <button className="button primary run-action" type="button" onClick={props.onRun} disabled={!props.canStart}>
        {title}
      </button>
      {props.sites.length > 1 && <label className="compare-select">
        Compare with
        <select aria-label="Comparison site" value={comparison?.id ?? ""} onChange={(event) => props.onCompare(event.target.value)}>
          <option value="">Select a site</option>
          {props.sites.filter((other) => other.id !== site.id).map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
        </select>
      </label>}
      {!supported && <p className="result-note" role="status">Sites can be saved anywhere on the Moon. Terrain previews and simulations currently support 90°S to 60°S.</p>}
      <OptionForm key={JSON.stringify(props.options)} options={props.options} onOptions={props.onOptions} />
      {active && run && <div className="run-progress">
        <progress aria-label="Simulation progress" max={run.total_samples} value={run.completed_samples} />
        <span>{queued ? "Queued for worker" : `${run.ready_indices.length} of ${run.total_frames} snapshots ready`}</span>
      </div>}
      {props.reconnecting && active && <p className="result-note" role="status">Reconnecting to run progress…</p>}
      {props.priorityError && <p className="result-note error-text" role="status">{props.priorityError}</p>}
      {run?.message && <p className="result-note error-text" role="alert">{run.message}</p>}
      {compareRun?.message && <p className="result-note error-text" role="alert">{comparison?.name} · {compareRun.message}</p>}

      <section className="result-section">
        <h4>Selected time</h4>
        <time dateTime={at.toISOString()}>{dateLabel(at)} · {clockLabel(at)} UTC</time>
        {props.frameError ? <p className="result-note error-text" role="alert">{props.frameError}</p> : reading ? <dl className="metrics">
          <div><dt>Lit area · any Sun</dt><dd>{bound(reading.summary.lit_area_fraction, ratio)}</dd></div>
          <div><dt>Lit area · ≥ half the Sun</dt><dd>{bound(reading.summary.half_disk_lit_area_fraction, ratio)}</dd></div>
          <div><dt>Mean direct irradiance</dt><dd>{bound(reading.summary.mean_irradiance_on_known_ground_w_m2, decimal, " W/m²")}</dd></div>
          <div><dt>Earth at {props.options.mast_height_m} m mast</dt><dd className={reading.earth_center_visibility === "clear" ? "visible-value" : ""}>
            {earthLabel[reading.earth_center_visibility]}
          </dd></div>
          <div><dt>Sun elevation</dt><dd>{reading.sun_at_collector ? `${decimal.format(reading.sun_at_collector.elevation_deg)}°` : "—"}</dd></div>
          <div><dt>Earth elevation</dt><dd>{reading.earth_at_mast ? `${decimal.format(reading.earth_at_mast.elevation_deg)}°` : "—"}</dd></div>
          {reading.summary.sun_resolved_area_fraction < 0.999 && <div><dt>Resolved footprint</dt><dd>{ratio.format(reading.summary.sun_resolved_area_fraction)}</dd></div>}
        </dl> : <p className="result-note" role="status">
          {run?.ready_indices.includes(index) ? "Loading snapshot…" : run ? "Waiting for this snapshot." : "Run the simulation to calculate this snapshot."}
        </p>}
      </section>

      {comparison && <section className="result-section comparison">
        <h4>Site comparison</h4>
        <table>
          <thead><tr><th scope="col">Metric</th><th scope="col">{site.name}</th><th scope="col">{comparison.name}</th></tr></thead>
          <tbody>
            <tr><th scope="row">Lit area</th><td>{bound(reading?.summary.lit_area_fraction, ratio)}</td><td>{bound(compareReading?.summary.lit_area_fraction, ratio)}</td></tr>
            <tr><th scope="row">Irradiance (W/m²)</th><td>{bound(reading?.summary.mean_irradiance_on_known_ground_w_m2, decimal)}</td><td>{bound(compareReading?.summary.mean_irradiance_on_known_ground_w_m2, decimal)}</td></tr>
            <tr><th scope="row">Earth</th><td>{reading ? earthLabel[reading.earth_center_visibility] : "—"}</td><td>{compareReading ? earthLabel[compareReading.earth_center_visibility] : "—"}</td></tr>
            <tr><th scope="row">Energy (kWh/m²)</th><td>{bound(period?.incident_energy_kwh_m2, energy)}</td><td>{bound(compareRun?.period?.incident_energy_kwh_m2, energy)}</td></tr>
            <tr><th scope="row">Earth visible (h)</th><td>{bound(period?.earth_visible_hours, decimal)}</td><td>{bound(compareRun?.period?.earth_visible_hours, decimal)}</td></tr>
          </tbody>
        </table>
        {compareRun && isActive(compareRun) && <p className="result-note" role="status">{comparison.name} · {compareRun.ready_indices.length} of {compareRun.total_frames} snapshots ready</p>}
      </section>}

      <SkyChart samples={series} at={at} range={range} />

      {period && <section className="result-section">
        <h4>Over the selected period</h4>
        <dl className="metrics">
          <div><dt>Area-weighted sunlit time</dt><dd>{bound(period.sunlit_hours, decimal, " h")}</dd></div>
          <div><dt>Sunlit time · ≥ half the Sun</dt><dd>{bound(period.half_disk_sunlit_hours, decimal, " h")}</dd></div>
          <div><dt>Mean solar energy</dt><dd>{bound(period.incident_energy_kwh_m2, energy, " kWh/m²")}</dd></div>
          <div><dt>Earth visible time</dt><dd>{bound(period.earth_visible_hours, decimal, " h")}</dd></div>
        </dl>
        <p className="result-note">Estimated at {run.plan.integration_minutes} min intervals.</p>
        <details className="science-details">
          <summary>Earth visibility windows</summary>
          <ul className="window-list">
            {period.earth_windows.map((window) => <li key={window.start_utc}>
              <strong>{earthLabel[window.visibility]}</strong>
              <span>{windowTime(window.start_utc)} – {windowTime(window.end_utc)}</span>
            </li>)}
          </ul>
        </details>
        {period.days.length > 1 && <details className="science-details">
          <summary>Daily summary (UTC)</summary>
          <ul className="window-list">
            {period.days.map((day) => <li key={day.date_utc}>
              <strong>{day.date_utc}</strong><span>{bound(day.incident_energy_kwh_m2, energy, " kWh/m²")} · Earth {bound(day.earth_visible_hours, decimal, " h")}</span>
            </li>)}
          </ul>
        </details>}
      </section>}

    </>}
  </aside>;
}
