import type { RunProgress, RunStatus, StageKey, StageProgress } from "../../api/types";

/** A stage as drawn: its share of the bar and how much of it is filled. */
export type Segment = {
  key: StageKey;
  state: StageProgress["state"];
  /** Share of the bar's width, between 0 and 1. */
  width: number;
  /** Share of the segment that is filled, between 0 and 1. */
  fill: number;
};

/** The smallest share of the bar a stage gets, so a quick stage is still visible. */
const MIN_WIDTH = 0.07;
/** Between server updates the bar moves on its own, but never fills a stage the server has not finished. */
const STAGE_CAP = 0.97;

export const stageLabel: Record<StageKey, string> = {
  preparing: "Loading terrain",
  horizons: "Building terrain horizons",
  snapshots: "Tracing sunlight and Earth visibility",
  windows: "Finding sunrise, sunset and Earth contact times",
};

/**
 * The stages at `elapsedS` seconds after `progress` arrived. The active stage keeps moving at
 * its estimated rate, so the bar stays alive between updates, but stops just short of its end.
 */
export function advance(progress: RunProgress, elapsedS: number, moving: boolean): StageProgress[] {
  return progress.stages.map((stage) => {
    if (!moving || stage.state !== "active" || stage.seconds <= 0) return stage;

    // Extrapolated fill: f = min(f₀ + Δt/T, max(f₀, cap))
    //   f₀ - Fill the server reported; Δt (elapsedS) - seconds since; T - estimated stage seconds.
    //   cap (STAGE_CAP) - Stop short of the stage's end until the server confirms it.
    const cap = Math.max(stage.fraction, STAGE_CAP);
    return { ...stage, fraction: Math.min(stage.fraction + elapsedS / stage.seconds, cap) };
  });
}

/** The bar's segments. Stages with nothing to do are left out of the bar. */
export function segments(stages: StageProgress[]): Segment[] {
  const shown = stages.filter((stage) => stage.state !== "skipped");
  const total = shown.reduce((sum, stage) => sum + stage.seconds, 0);
  if (!shown.length) return [];

  // Width share: w = max(T/ΣT, w_min), then rescaled so the shares add up to 1.
  //   T - Stage seconds; w_min (MIN_WIDTH) - smallest share, so short stages stay visible.
  const raw = shown.map((stage) => Math.max(total > 0 ? stage.seconds / total : 1 / shown.length, MIN_WIDTH));
  const sum = raw.reduce((a, b) => a + b, 0);
  return shown.map((stage, index) => ({ key: stage.key, state: stage.state, width: raw[index] / sum, fill: stage.fraction }));
}

/** Share of the whole bar that is filled. */
export function overall(parts: Segment[]) {
  return parts.reduce((sum, part) => sum + part.width * part.fill, 0);
}

/**
 * How far a run is, as one share between 0 and 1: weighted by time, as the progress bar shows
 * it, so every percentage on the page agrees. Older servers without stages count samples.
 */
export function runShare(run: RunStatus) {
  if (run.stage === "complete") return 1;
  if (run.progress) return overall(segments(run.progress.stages));
  return run.total_samples ? run.completed_samples / run.total_samples : 0;
}

/**
 * Time left in words, rounded so it does not flicker: "a few seconds", "about 35 s",
 * "about 2 min", "about 1 h 10 min".
 */
export function timeLeft(seconds: number) {
  if (seconds < 10) return "a few seconds";
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const number = new Intl.NumberFormat("en-GB");

/** How far a stage is in its own units, or null where there is nothing to count. */
export function stageDetail(stage: StageProgress) {
  if (stage.key === "horizons") {
    if (stage.state === "skipped") return "Already built for this site";
    if (!stage.total_units) return null;
    return `${number.format(stage.done_units ?? 0)} of ${number.format(stage.total_units)} points`;
  }
  if (stage.key === "snapshots") {
    const reused = stage.reused_units ? ` · ${number.format(stage.reused_units)} reused from earlier runs` : "";
    if (stage.state === "skipped") return "Every sample was already computed";
    return `${number.format(stage.done_units ?? 0)} of ${number.format(stage.total_units ?? 0)} samples${reused}`;
  }
  return null;
}
