import type { RunStatus } from "../../api/types";
import { wholePercent } from "./format";
import { isActive } from "./useScience";
import "./runControls.css";

type ControlProps = {
  run: RunStatus | null;
  /** This browser paused the run, but it keeps running because another browser still wants it. */
  pausedForYou: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  /** Whether to offer Resume here. Single site view resumes with its main button instead. */
  showResume?: boolean;
};

/**
 * Pause and cancel act on this browser's request only, so they never stop a simulation someone
 * else is waiting for. Nothing computed is deleted: cancelling stops showing the simulation here,
 * and its results are reused if anyone asks for these dates again.
 */
export function RunControls({ run, pausedForYou, onPause, onResume, onCancel, showResume = true }: ControlProps) {
  const paused = run?.stage === "paused";
  if (!run || !(isActive(run) || paused)) return null;

  const done = run.total_samples ? run.completed_samples / run.total_samples : 0;
  const cancel = <button className="button quiet" type="button" onClick={onCancel}>Cancel</button>;

  if (pausedForYou && !paused) {
    return <div className="run-controls" role="group" aria-label="Simulation controls">
      <span>Paused for you. Another visitor still needs this simulation, so it keeps running.</span>
      <button className="button quiet" type="button" onClick={onResume}>Resume</button>
      {cancel}
    </div>;
  }

  return <div className="run-controls" role="group" aria-label="Simulation controls">
    {paused && <span>Paused at {wholePercent.format(done)}. Results so far stay available.</span>}
    {paused && showResume && <button className="button quiet" type="button" onClick={onResume}>Resume</button>}
    {!paused && <button className="button quiet" type="button" onClick={onPause}>Pause</button>}
    {cancel}
  </div>;
}
