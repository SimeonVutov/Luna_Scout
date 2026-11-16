import type { StageProgress } from "../../api/types";
import { Icon } from "../../Icon";
import { stageDetail, stageLabel } from "./progressModel";
import "./stageBar.css";

/** The run's stages in order: done, in progress, still to come, or not needed. */
export function StageList({ stages, paused }: { stages: StageProgress[]; paused: boolean }) {
  return <ol className="stage-list">
    {stages.map((stage) => <li key={stage.key} className={`stage-row ${stage.state}`}>
      <StageIcon state={stage.state} paused={paused} />
      <span className="stage-text">
        <strong>{stageLabel[stage.key]}</strong>
        <small>{stageDetail(stage)}</small>
      </span>
      {stage.state === "active" && <span className="stage-percent">{Math.round(stage.fraction * 100)}%</span>}
    </li>)}
  </ol>;
}

function StageIcon({ state, paused }: { state: StageProgress["state"]; paused: boolean }) {
  if (state === "done" || state === "skipped") {
    return <span className={`stage-icon ${state}`} aria-label={state === "done" ? "Done" : "Not needed"}><Icon name="check" size={12} /></span>;
  }
  if (state === "active" && paused) return <span className="stage-icon paused" aria-label="Paused"><Icon name="pause" size={11} /></span>;
  if (state === "active") return <span className="stage-icon active" aria-label="In progress" />;
  return <span className="stage-icon pending" aria-label="Waiting" />;
}
