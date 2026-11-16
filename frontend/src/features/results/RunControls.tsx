import { useState } from "react";
import type { RunStatus } from "../../api/types";
import { wholePercent } from "./format";
import { isActive } from "./useScience";

type ControlProps = {
  run: RunStatus | null;
  onPause: () => void;
  onCancel: () => void;
};

/**
 * Pause and cancel for a site's simulation. Pausing keeps everything computed so far and the
 * main button resumes it; cancelling deletes the results, so it asks for confirmation first.
 */
export function RunControls({ run, onPause, onCancel }: ControlProps) {
  const [confirming, setConfirming] = useState(false);
  const paused = run?.stage === "paused";
  if (!run || !(isActive(run) || paused)) return null;

  if (confirming) {
    return <div className="run-controls" role="group" aria-label="Confirm cancelling the simulation">
      <span>Delete this simulation's results?</span>
      <button className="button quiet danger" type="button" onClick={() => { setConfirming(false); onCancel(); }}>Delete results</button>
      <button className="button quiet" type="button" onClick={() => setConfirming(false)}>Keep</button>
    </div>;
  }

  const done = run.total_samples ? run.completed_samples / run.total_samples : 0;
  return <div className="run-controls" role="group" aria-label="Simulation controls">
    {paused && <span>Paused at {wholePercent.format(done)}. Results so far stay available.</span>}
    {!paused && <button className="button quiet" type="button" onClick={onPause}>Pause</button>}
    <button className="button quiet" type="button" onClick={() => setConfirming(true)}>Cancel</button>
  </div>;
}
