import type { RunStatus, Site } from "../../api/types";
import { RunControls } from "../results/RunControls";
import { slotColor, slotLabel } from "../compare/slots";
import type { Slot } from "../compare/slots";
import { Icon } from "../../Icon";
import { stageLabel, timeLeft } from "./progressModel";
import { StageBar } from "./StageBar";
import { StageList } from "./StageList";
import { useLiveProgress } from "./useLiveProgress";

export type CardEntry = {
  site: Site;
  slot: Slot | null;
  run: RunStatus | null;
  pausedForYou: boolean;
};

type CardProps = CardEntry & {
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
};

/** One site's simulation: its bar, what it is doing, the time left, and its controls. */
export function RunCard({ site, slot, run, pausedForYou, onPause, onResume, onCancel }: CardProps) {
  const live = useLiveProgress(run);
  const paused = run?.stage === "paused";
  const complete = run?.stage === "complete";
  const active = live?.stages.find((stage) => stage.state === "active");
  const status = statusLine(run, live?.remainingS ?? 0);

  return <section className={complete ? "run-card complete" : "run-card"} aria-label={`Simulation of ${site.name}`}>
    <header>
      <span className="run-card-name">
        {slot && <span className="site-chip small" style={{ background: slotColor[slot] }}>{slotLabel[slot]}</span>}
        {site.name}
      </span>
      <span className="run-card-percent">
        {complete ? <><Icon name="check" size={18} /> Ready</> : `${shownPercent(live?.overall ?? 0)}%`}
      </span>
    </header>

    {live && <StageBar segments={live.segments} overall={live.overall} paused={paused}
      description={active ? `${stageLabel[active.key]}, ${status.text}` : status.text} />}
    {!complete && <p className={`run-card-status ${status.tone}`} role="status">{status.text}</p>}
    {sharing(run) && <p className="run-card-note">{sharing(run)}</p>}
    {run?.stage === "failed" && run.message && <p className="run-card-note error-text" role="alert">{run.message}</p>}

    {live && !complete && live.stages.length > 0 && <StageList stages={live.stages} paused={paused} />}
    <RunControls run={run} pausedForYou={pausedForYou} showPausedNote={false} onPause={onPause} onResume={onResume} onCancel={onCancel} />
  </section>;
}

type Tone = "normal" | "waiting" | "done" | "stopped";

function statusLine(run: RunStatus | null, remainingS: number): { text: string; tone: Tone } {
  if (!run) return { text: "Stopped", tone: "stopped" };
  if (run.stage === "complete") return { text: "Ready", tone: "done" };
  if (run.stage === "failed") return { text: "Stopped with an error", tone: "stopped" };
  if (run.stage === "paused") return { text: "Paused", tone: "waiting" };
  if (run.progress?.waiting) return { text: `Waiting for the server · ${timeLeft(remainingS)} left`, tone: "waiting" };
  return { text: `${capitalise(timeLeft(remainingS))} left`, tone: "normal" };
}

/** Why the time left is longer than this run alone needs, or null. */
function sharing(run: RunStatus | null) {
  const others = run?.progress?.sharing_with ?? 0;
  if (!others || run?.stage === "complete") return null;
  return `Sharing the server with ${others} other simulation${others === 1 ? "" : "s"}`;
}

/** Whole percent, never 100 before the run is complete, so "100%" always means done. */
function shownPercent(share: number) {
  return Math.min(99, Math.round(share * 100));
}

function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
