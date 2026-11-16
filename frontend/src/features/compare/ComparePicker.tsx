import type { RunStatus, SimulationOptions, Site } from "../../api/types";
import { Icon } from "../../Icon";
import { isActive } from "../results/useScience";
import { coordinatesLabel } from "../sites/referenceSites";
import { slotColor, slotLabel, slots } from "./slots";
import type { Slot } from "./slots";
import "./comparePicker.css";

type PickerProps = {
  sites: Site[];
  chosen: Record<Slot, Site | null>;
  runs: Record<Slot, RunStatus | null>;
  options: SimulationOptions;
  submitting: boolean;
  canStart: boolean;
  onAssign: (slot: Slot, id: string | null) => void;
  onSwap: () => void;
  onRun: () => void;
  onOpenSettings: () => void;
};

const receiverShort = { vertical_tracking: "Vertical panel", terrain: "Ground", horizontal: "Flat plate" } as const;

function progress(run: RunStatus | null) {
  if (!run) return null;
  if (run.stage === "failed") return { text: "Failed. Run again to resume.", value: null };
  if (run.stage === "paused") return { text: "Paused. Run both to resume.", value: run.completed_samples / Math.max(1, run.total_samples) };
  if (run.stage === "complete") return { text: "Complete", value: 1 };
  if (isActive(run)) {
    const text = run.stage === "queued" ? "Queued for worker" : `${run.ready_indices.length} of ${run.total_frames} snapshots ready`;
    return { text, value: run.completed_samples / Math.max(1, run.total_samples) };
  }
  return null;
}

export function ComparePicker(props: PickerProps) {
  const { sites, chosen, runs, options } = props;
  const outside = slots.some((slot) => chosen[slot] && chosen[slot]!.latitude_deg > -60);
  const bothChosen = chosen.a !== null && chosen.b !== null;
  const title = !bothChosen ? "Choose two sites" : outside ? "Outside terrain coverage" :
    props.submitting ? "Submitting…" : props.canStart ? "Run both" :
    slots.every((slot) => runs[slot]?.stage === "complete") ? "Comparison complete" : "Comparison running";
  const height = options.receiver === "terrain" ? "" : ` at ${options.collector_height_m} m`;

  return <aside className="panel site-panel compare-picker" aria-label="Sites to compare">
    <div className="panel-title"><h2>Compare sites</h2></div>

    <div className="slot-list">
      {slots.map((slot, position) => {
        const state = progress(runs[slot]);
        return <div key={slot} className="slot">
          {position === 1 && <button type="button" className="swap-button" onClick={props.onSwap} aria-label="Swap A and B" title="Swap A and B"><Icon name="swap" size={15} /></button>}
          <label className="slot-select">
            <span className="site-chip" style={{ background: slotColor[slot] }}>{slotLabel[slot]}</span>
            <select value={chosen[slot]?.id ?? ""} aria-label={`Site ${slotLabel[slot]}`} onChange={(event) => props.onAssign(slot, event.target.value || null)}>
              <option value="">Choose a site</option>
              {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
          </label>
          {chosen[slot] && <p className="slot-detail">{coordinatesLabel(chosen[slot]!.latitude_deg, chosen[slot]!.longitude_deg)} · {chosen[slot]!.radius_m.toLocaleString("en-GB")} m</p>}
          {state && <div className="run-progress">
            {state.value !== null && state.value < 1 && <progress aria-label={`Progress for site ${slotLabel[slot]}`} max={1} value={state.value} />}
            <span>{state.text}</span>
          </div>}
        </div>;
      })}
    </div>

    <button className="button primary run-action" type="button" onClick={props.onRun} disabled={!props.canStart}>{title}</button>
    <button className="button quiet settings-link" type="button" onClick={props.onOpenSettings}>
      {receiverShort[options.receiver]}{height} · {options.grid_spacing_m} m grid · Change
    </button>

    <div className="reference-sites">
      <h3>Assign from your sites</h3>
      {sites.length === 0 && <p className="sidebar-note">Add sites in Single site mode first.</p>}
      {sites.map((site) => <div key={site.id} className="assign-row">
        <span className="assign-name">{site.name}</span>
        {slots.map((slot) => <button key={slot} type="button" className="assign-button" aria-pressed={chosen[slot]?.id === site.id}
          style={chosen[slot]?.id === site.id ? { background: slotColor[slot], borderColor: slotColor[slot] } : undefined}
          aria-label={`Use ${site.name} as site ${slotLabel[slot]}`} onClick={() => props.onAssign(slot, site.id)}>{slotLabel[slot]}</button>)}
      </div>)}
    </div>
  </aside>;
}
