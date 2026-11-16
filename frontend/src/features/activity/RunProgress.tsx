import type { RunStatus } from "../../api/types";
import { Icon } from "../../Icon";
import { runShare } from "../progress/progressModel";
import { wholePercent } from "../results/format";
import "./activity.css";

/**
 * One run's state: a live bar while it calculates, "Simulation done" when finished.
 * `workerRunning` is null while the worker's state is not known yet.
 */
export function RunProgress({ run, phase, workerRunning }: {
  run: RunStatus | null;
  phase?: string | null;
  workerRunning: boolean | null;
}) {
  if (!run) return null;

  if (run.stage === "complete") {
    return <p className="run-state done"><Icon name="check" size={13} /> Simulation done</p>;
  }
  if (run.stage === "paused") {
    const done = runShare(run);
    return <p className="run-state">Paused at {wholePercent.format(done)}</p>;
  }
  if (run.stage === "failed") {
    return <p className="run-state failed" role="alert">{run.message ?? "The simulation failed."}</p>;
  }

  const waiting = workerRunning === false;
  const fraction = runShare(run);
  return <div className="run-progress live" role="status">
    <progress aria-label="Simulation progress" max={1} value={run.stage === "queued" ? undefined : fraction} />
    <span className={waiting ? "warn-text" : undefined}>
      {waiting ? "Waiting for the worker, which is not running"
        : run.stage === "queued" ? "Queued"
        : `${wholePercent.format(fraction)}${phase ? ` · ${phase}` : ""}`}
    </span>
  </div>;
}
