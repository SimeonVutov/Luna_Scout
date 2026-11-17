import { useRef, useState } from "react";
import { errorText } from "../../api/errorText";
import { lookupRun } from "../../api/client";
import type { RunLookup, SimulationOptions, Site, TimeRange } from "../../api/types";
import { snapshotAt } from "./time";

/** A saved site whose results do not yet cover a range the user asked for. */
export type MissingResults = {
  site: Site;
  /** Whole days still to compute. */
  days: number;
  /** Seconds the missing part should take on the server. */
  seconds: number;
};

export type PendingRange = { range: TimeRange; missing: MissingResults[] };

type Inputs = {
  sites: Site[];
  options: SimulationOptions;
  /** Show this range on the timeline. */
  apply: (range: TimeRange) => void;
  /** Start a site's simulation for a range, resolving once the server has accepted it. */
  run: (site: Site, range: TimeRange, priorityAt: string) => Promise<void>;
  /** Called with the sites whose simulations were just started, and with any problems. */
  onStarted: (sites: Site[]) => void;
  onProblems: (message: string | null) => void;
};

/** Samples a run that has not been computed yet still needs; none while someone is already on it. */
function missingSamples(found: RunLookup) {
  const stage = found.run?.stage;
  if (stage === "complete" || stage === "queued" || stage === "running" || stage === "paused") return 0;
  return Math.max(0, found.total_samples - found.reusable_samples);
}

/**
 * Changing the timeline's dates never starts work by itself. The server is asked what each saved
 * site already has for the new dates: when everything is there, the dates are shown at once; when
 * something is missing, the user is asked first and can keep the previous dates instead.
 */
export function useRangeChange({ sites, options, apply, run, onStarted, onProblems }: Inputs) {
  const [pending, setPending] = useState<PendingRange | null>(null);
  // Only the latest request counts, so a slow answer cannot replace a newer choice.
  const latest = useRef(0);

  async function request(next: TimeRange) {
    const ticket = ++latest.current;
    const first = snapshotAt(next, 0).toISOString();
    const supported = sites.filter((site) => site.latitude_deg <= -60);
    const samplesPerDay = 1440 / options.integration_minutes;

    const answers = await Promise.allSettled(supported.map((site) =>
      lookupRun({ ...next, ...options, site, priority_utc: first }, new AbortController().signal)));
    if (ticket !== latest.current) return;

    // A site that could not be asked about is left out: it behaves as it always did.
    const missing = answers.flatMap((answer, index): MissingResults[] => {
      if (answer.status !== "fulfilled") return [];

      const samples = missingSamples(answer.value);
      if (!samples) return [];
      return [{ site: supported[index], days: Math.max(1, Math.ceil(samples / samplesPerDay)), seconds: answer.value.estimated_seconds }];
    });

    if (missing.length) setPending({ range: next, missing });
    else apply(next);
  }

  /** Show the new dates and start computing what they lack. */
  async function confirm() {
    if (!pending) return;

    const { range, missing } = pending;
    setPending(null);
    apply(range);

    const first = snapshotAt(range, 0).toISOString();
    const results = await Promise.allSettled(missing.map((item) => run(item.site, range, first)));
    const problems = results.flatMap((result, index) =>
      result.status === "rejected" ? [`${missing[index].site.name} · ${errorText(result.reason)}`] : []);
    const started = missing.filter((_, index) => results[index].status === "fulfilled").map((item) => item.site);

    onProblems(problems.length ? problems.join(" ") : null);
    if (started.length) onStarted(started);
  }

  /** Leave the timeline as it was. */
  function keepPrevious() {
    latest.current++;
    setPending(null);
  }

  return { pending, request, confirm, keepPrevious };
}
