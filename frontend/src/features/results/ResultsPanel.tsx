import type { Reading, RunStatus, ChosenOptions, Site, SiteInsight, TimeRange } from "../../api/types";
import { coordinatesLabel } from "../sites/referenceSites";
import { clockLabel, dateLabel } from "../timeline/time";
import { decimal } from "./format";
import { SkyChart } from "./SkyChart";
import { SkyCloseUp } from "./SkyCloseUp";
import { IceSection } from "./IceSection";
import { TerrainSection } from "./TerrainSection";
import { RunControls } from "./RunControls";
import { PeriodMetricsList, SelectedTimeMetrics } from "./SiteMetrics";
import { gridLabel } from "../settings/gridSpacing";
import { isActive } from "./useScience";
import type { IceState } from "./useSiteIce";
import "./results.css";

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
  options: ChosenOptions;
  insight: SiteInsight | null;
  insightLoading: boolean;
  insightError: string | null;
  ice: IceState;
  pausedForYou: boolean;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onShowProgress: () => void;
  onOpenSettings: () => void;
  canStart: boolean;
};

export function ResultsPanel(props: PanelProps) {
  const { site, at, range, index, run, reading, series } = props;
  const queued = run?.stage === "queued";
  const active = isActive(run);
  const completed = run?.stage === "complete";
  const retry = run?.stage === "failed";
  const paused = run?.stage === "paused";
  const supported = site !== null && site.latitude_deg <= -60;
  const title = runTitle({ supported, submitting: props.submitting, paused, canStart: props.canStart, retry, completed, queued });

  return <aside className="panel results-panel" aria-label="Site results">
    <div className="panel-title"><h2>Site results</h2></div>
    {!site ? <p className="sidebar-note">Add a landing site to explore its terrain and sunlight.</p> : <>
      <div className="result-site">
        <h3>{site.name}</h3>
        <p>{coordinatesLabel(site.latitude_deg, site.longitude_deg)} · {decimal.format(site.radius_m)} m radius</p>
      </div>

      <button className="button primary run-action" type="button" onClick={paused ? props.onResume : props.onRun} disabled={!paused && !props.canStart}>
        {title}
      </button>
      <RunControls run={run} pausedForYou={props.pausedForYou} showResume={false} onPause={props.onPause} onResume={props.onResume} onCancel={props.onCancel}
        onShowProgress={props.onShowProgress} />
      <button className="button quiet settings-link" type="button" onClick={props.onOpenSettings}>
        {settingsSummary(props.options, site)} · Change
      </button>
      {!supported && <p className="result-note" role="status">Sites can be saved anywhere on the Moon. Terrain previews and simulations currently support 90°S to 60°S.</p>}
      {active && run && <div className="run-progress">
        <progress aria-label="Simulation progress" max={run.total_samples} value={run.completed_samples} />
        <span>{queued ? "Queued for worker" : `${run.ready_indices.length} of ${run.total_frames} snapshots ready`}</span>
      </div>}
      {props.reconnecting && active && <p className="result-note" role="status">Reconnecting to run progress…</p>}
      {props.priorityError && <p className="result-note error-text" role="status">{props.priorityError}</p>}
      {run?.message && <p className="result-note error-text" role="alert">{run.message}</p>}

      <section className="result-section">
        <h4>Selected time</h4>
        <time dateTime={at.toISOString()}>{dateLabel(at)} · {clockLabel(at)} UTC</time>
        {props.frameError ? <p className="result-note error-text" role="alert">{props.frameError}</p> : reading ? <SelectedTimeMetrics reading={reading} run={run} at={at} /> : <p className="result-note" role="status">
          {run?.ready_indices.includes(index) ? "Loading snapshot…" : run ? "Waiting for this snapshot." : "Run the simulation to calculate this snapshot."}
        </p>}
      </section>

      <section className="result-section">
        <h4>At the skyline</h4>
        <SkyCloseUp label="Sun" view={reading?.sun_at_collector} skyline={props.insight?.collector_skyline_deg} step={props.insight?.skyline_azimuth_step_deg ?? 0.1} />
        <SkyCloseUp label="Earth" view={reading?.earth_at_mast} skyline={props.insight?.mast_skyline_deg} step={props.insight?.skyline_azimuth_step_deg ?? 0.1} />
      </section>

      <section className="result-section">
        <h4>Terrain</h4>
        <TerrainSection insight={props.insight} loading={props.insightLoading} error={props.insightError} />
      </section>

      <section className="result-section">
        <h4>Ice and temperature</h4>
        <IceSection state={props.ice} />
      </section>

      <SkyChart samples={series} at={at} range={range} />

      {run?.period && <section className="result-section">
        <h4>Over the selected period</h4>
        <PeriodMetricsList run={run} />
      </section>}
    </>}
  </aside>;
}

type TitleState = {
  supported: boolean;
  submitting: boolean;
  paused: boolean;
  canStart: boolean;
  retry: boolean;
  completed: boolean;
  queued: boolean;
};

/** The main button's label, which also tells the run's state. */
function runTitle(state: TitleState) {
  if (!state.supported) return "Outside terrain coverage";
  if (state.submitting) return "Submitting…";
  if (state.paused) return "Resume simulation";
  if (state.canStart) return state.retry ? "Retry simulation" : "Run simulation";
  if (state.completed) return "Simulation complete";
  return state.queued ? "Simulation queued" : "Simulation running";
}

const receiverShort = { vertical_tracking: "Vertical panel", terrain: "Ground", horizontal: "Flat plate" } as const;

function settingsSummary(options: ChosenOptions, site: { radius_m: number }) {
  const height = options.receiver === "terrain" ? "" : ` at ${options.collector_height_m} m`;
  return `${receiverShort[options.receiver]}${height} · ${gridLabel(options, site)}`;
}
