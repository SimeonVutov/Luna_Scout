import { useEffect, useRef, useState } from "react";
import type { RunStatus, StageKey } from "../../api/types";
import { isActive } from "../results/useScience";
import { advance, overall, segments } from "./progressModel";
import type { Segment } from "./progressModel";

const TICK_MS = 250;

export type LiveProgress = {
  segments: Segment[];
  stages: ReturnType<typeof advance>;
  /** Share of the whole bar that is filled, between 0 and 1. */
  overall: number;
  remainingS: number;
};

/**
 * A run's progress as shown: the server's latest report, moved forward between reports at the
 * estimated rate. Stages never move backwards, even when a new report revises the estimate.
 */
export function useLiveProgress(run: RunStatus | null): LiveProgress | null {
  const [now, setNow] = useState(() => performance.now());
  const received = useRef<{ revision: number; at: number } | null>(null);
  const highest = useRef<{ runId: string; fills: Partial<Record<StageKey, number>>; last: Segment[] } | null>(null);
  const moving = isActive(run);

  if (run && received.current?.revision !== run.revision) received.current = { revision: run.revision, at: performance.now() };

  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(() => setNow(performance.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [moving]);

  if (!run) return null;
  if (highest.current?.runId !== run.run_id) highest.current = { runId: run.run_id, fills: {}, last: [] };

  const memory = highest.current;
  const fills = memory.fills;
  const complete = run.stage === "complete";
  const progress = run.progress;
  const elapsedS = received.current ? Math.max(0, (now - received.current.at) / 1000) : 0;

  const stages = progress
    ? advance(progress, elapsedS, moving).map((stage) => {
      const fraction = Math.max(stage.fraction, fills[stage.key] ?? 0);
      fills[stage.key] = fraction;
      return { ...stage, fraction };
    })
    : [];

  if (complete) {
    // A finished run has no progress report: the bar keeps its last layout, all of it done.
    const finished = memory.last.length ? memory.last : [{ key: "snapshots" as const, state: "done" as const, width: 1, fill: 1 }];
    const parts = finished.map((part) => ({ ...part, state: "done" as const, fill: 1 }));
    const done = parts.map((part) => ({ key: part.key, state: "done" as const, seconds: 0, fraction: 1 }));
    return { segments: parts, stages: done, overall: 1, remainingS: 0 };
  }

  const parts = segments(stages);
  memory.last = parts;
  const remainingS = progress ? Math.max(0, progress.remaining_s - (moving ? elapsedS : 0)) : 0;
  return { segments: parts, stages, overall: overall(parts), remainingS };
}
