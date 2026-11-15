import { useEffect, useRef, useState } from "react";
import type { RunList, RunStatus, Site } from "../../api/types";
import { Icon } from "../../Icon";
import { ago, rangeLabel } from "../results/format";
import { coordinatesLabel } from "../sites/referenceSites";
import { RunProgress } from "./RunProgress";
import type { ApiProblem } from "./useActivity";

const receiverShort = { vertical_tracking: "Vertical panel", terrain: "Ground", horizontal: "Flat plate", fixed: "Fixed plane" } as const;

function siteName(run: RunStatus, sites: Site[]) {
  const { latitude_deg, longitude_deg, radius_m } = run.plan.site;
  const saved = sites.find((site) => site.latitude_deg === latitude_deg && site.longitude_deg === longitude_deg && site.radius_m === radius_m);
  return saved?.name ?? coordinatesLabel(latitude_deg, longitude_deg);
}

function description(run: RunStatus) {
  const settings = run.plan.settings;
  const receiver = settings ? `${receiverShort[settings.receiver]}${settings.receiver === "terrain" ? "" : ` ${settings.collector_height_m} m`}` : "";
  return [rangeLabel(run.plan.start_utc, run.plan.end_utc), receiver].filter(Boolean).join(" · ");
}

const stageLabel = { queued: "Queued", running: "Running", complete: "Done", failed: "Failed" } as const;

export function ActivityMenu({ list, problem, sites, onOpen }: { list: RunList | null; problem: ApiProblem; sites: Site[]; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = list?.runs.filter((run) => run.stage === "queued" || run.stage === "running").length ?? 0;
  const workerRunning = list ? list.worker.running : null;
  const unreachable = problem === "unreachable";
  const outdated = problem === "outdated";
  const attention = problem !== null || (workerRunning === false && active > 0);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape); };
  }, [open]);

  return <div className="activity" ref={root}>
    <button type="button" className="button secondary" aria-expanded={open} onClick={() => { if (!open) onOpen(); setOpen(!open); }}>
      <Icon name="activity" size={16} /> Activity
      {(active > 0 || attention) && <span className={attention ? "badge warn" : "badge"} aria-label={attention ? "Needs attention" : `${active} running`}>{attention ? "!" : active}</span>}
    </button>

    {open && <div className="activity-panel" role="dialog" aria-label="Running processes">
      <section className="worker-row">
        <span className={`dot ${problem ? "off" : workerRunning === null ? "unknown" : workerRunning ? "on" : "off"}`} aria-hidden="true" />
        <div>
          <strong>{unreachable ? "Cannot reach the API" : outdated ? "The API needs a restart" : workerRunning === null ? "Checking the worker…" : workerRunning ? "Worker running" : "Worker not running"}</strong>
          {!problem && workerRunning && <small>{list?.worker.activity ?? "Idle, waiting for work"}</small>}
          {unreachable && <small>Start the API from the backend folder:</small>}
          {outdated && <small>It is running, but from before this menu existed. Stop it and start it again:</small>}
          {!problem && workerRunning === false && <small>Start it from the backend folder. If it is already running, it started before the last update, so restart it:</small>}
        </div>
      </section>
      {(problem || workerRunning === false) && <pre className="command">{problem ? "uv run --locked uvicorn lunascout.api.main:app --port 8000" : "uv run --locked lunascout-worker"}</pre>}

      <h3>Simulations</h3>
      {!list?.runs.length && <p className="result-note">{problem ? "Nothing to show until the API is running the latest version." : "No simulations yet. Run one from a site."}</p>}
      <ul className="activity-runs">
        {list?.runs.map((run) => <li key={run.run_id} className={`activity-run ${run.stage}`}>
          <div className="activity-run-head">
            <strong>{siteName(run, sites)}</strong>
            <span className={`stage-chip ${run.stage}`}>{stageLabel[run.stage]}</span>
          </div>
          <small>{description(run)} · {ago(run.submitted_utc)}</small>
          <RunProgress run={run} workerRunning={workerRunning} phase={list.worker.run_id === run.run_id ? list.worker.activity : null} />
          {run.stage === "complete" && <small>{run.total_frames} snapshots</small>}
        </li>)}
      </ul>
    </div>}
  </div>;
}
