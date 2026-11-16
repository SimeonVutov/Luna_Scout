import type { CSSProperties } from "react";
import { Icon } from "../../Icon";
import type { CardEntry } from "./RunCard";
import { runShare, timeLeft } from "./progressModel";
import "./progressMotion.css";
import "./runPill.css";

/**
 * The hidden dialog, shrunk to one line above the timeline: how far the simulations are and how
 * long they have left. Clicking it brings the dialog back.
 */
export function RunPill({ entries, onOpen }: { entries: CardEntry[]; onOpen: () => void }) {
  const runs = entries.flatMap((entry) => entry.run ? [entry.run] : []);
  const ready = runs.length > 0 && runs.every((run) => run.stage === "complete");
  const paused = runs.some((run) => run.stage === "paused");

  // Share done: the mean of each run's time-weighted share, the same measure the dialog shows.
  const shares = runs.map(runShare);
  const share = ready ? 1 : shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;
  const remaining = Math.max(0, ...runs.map((run) => run.progress?.remaining_s ?? 0));
  const name = entries.length === 1 ? entries[0].site.name : `${entries.length} sites`;

  const percent = Math.min(99, Math.round(share * 100));
  let detail = `${percent}% · ${timeLeft(remaining)} left`;
  if (ready) detail = "Results ready";
  else if (paused) detail = `${percent}% · paused`;

  return <button className={ready ? "run-pill ready" : "run-pill"} type="button" onClick={onOpen}
    style={{ "--fill": share } as CSSProperties} aria-label={`${name}: ${detail}. Show progress`}>
    <span className={ready ? "run-pill-icon ready" : "run-pill-icon"}>{ready ? <Icon name="check" size={13} /> : null}</span>
    <strong>{name}</strong>
    <span>{detail}</span>
    <span className="run-pill-line" aria-hidden="true" />
  </button>;
}
