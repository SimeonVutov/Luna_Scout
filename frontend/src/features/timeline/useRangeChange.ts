import { useRef, useState } from "react";
import { errorText } from "../../api/errorText";
import { lookupRun } from "../../api/client";
import type { RunLookup, ChosenOptions, Site, TimeRange } from "../../api/types";
import { resolveOptions } from "../settings/gridSpacing";
import { snapshotAt } from "./time";

/** A saved site whose results do not yet cover a range the user asked for. */
export type MissingResults = {
  site: Site;
  /** Whole days still to compute. */
  days: number;
  /** Seconds the missing part should take on the server. */
  seconds: number;
};

/**
 * What the user is being asked. `changesDates` is true when the question comes with new dates for
 * the timeline, which can be kept as they were; false when it is about the dates already shown.
 */
export type PendingRange = { range: TimeRange; missing: MissingResults[]; changesDates: boolean };

type Inputs = {
  sites: Site[];
  options: ChosenOptions;
  /** Show this range on the timeline. */
  apply: (range: TimeRange) => void;
  /** Whether this browser has already asked for exactly this site and range, so it is on its way. */
  wanted: (site: Site, range: TimeRange) => boolean;
  /** Start a site's simulation for a range, resolving once the server has accepted it. */
  run: (site: Site, range: TimeRange, priorityAt: string) => Promise<void>;
  /** Called with the sites whose simulations were just started, and with any problems. */
  onStarted: (sites: Site[]) => void;
  onProblems: (message: string | null) => void;
};

/**
 * Samples the range still needs. Nothing is missing when the request is complete or already one
 * this browser asked for; an unfinished run that someone else started still needs its samples, and
 * the user is asked before this browser takes them on.
 */
function missingSamples(found: RunLookup, wantedHere: boolean) {
  if (wantedHere || found.run?.stage === "complete") return 0;
  return Math.max(0, found.total_samples - found.reusable_samples);
}

/** Samples of a partly computed run: some are known, and some are not. */
function partlyComputed(found: RunLookup, wantedHere: boolean) {
  return missingSamples(found, wantedHere) > 0 && found.reusable_samples > 0;
}

/**
 * Nothing is computed unasked. When the timeline's dates change, the server is asked what each
 * saved site already has for the new dates: if everything is there they are shown at once, and if
 * something is missing the user is asked first and can keep the previous dates. A newly added
 * site that is only partly computed for the dates shown, such as a reference site the server has
 * precomputed in part, gets the same question.
 */
export function useRangeChange({ sites, options, apply, wanted, run, onStarted, onProblems }: Inputs) {
  const [pending, setPending] = useState<PendingRange | null>(null);
  // Only the latest request counts, so a slow answer cannot replace a newer choice.
  const latest = useRef(0);

  /** What each of `targets` lacks for `range`; `include` says which kinds of gap are worth asking about. */
  async function lackOf(targets: Site[], range: TimeRange, include: (found: RunLookup, site: Site, range: TimeRange) => boolean) {
    const first = snapshotAt(range, 0).toISOString();
    const supported = targets.filter((site) => site.latitude_deg <= -60);
    const samplesPerDay = 1440 / options.integration_minutes;

    const answers = await Promise.allSettled(supported.map((site) =>
      lookupRun({ ...range, ...resolveOptions(options, site), site, priority_utc: first }, new AbortController().signal)));

    // A site that could not be asked about is left out: it behaves as it always did.
    return answers.flatMap((answer, index): MissingResults[] => {
      if (answer.status !== "fulfilled" || !include(answer.value, supported[index], range)) return [];

      const samples = missingSamples(answer.value, wanted(supported[index], range));
      return [{ site: supported[index], days: Math.max(1, Math.ceil(samples / samplesPerDay)), seconds: answer.value.estimated_seconds }];
    });
  }

  /** The timeline's dates are changing to `next`. */
  async function request(next: TimeRange) {
    const ticket = ++latest.current;
    const missing = await lackOf(sites, next, (found, site, when) => missingSamples(found, wanted(site, when)) > 0);
    if (ticket !== latest.current) return;

    if (missing.length) setPending({ range: next, missing, changesDates: true });
    else apply(next);
  }

  /** Sites were just added: ask about those the server holds only part of, for the dates shown. */
  async function offer(added: Site[], range: TimeRange) {
    const ticket = ++latest.current;
    const missing = await lackOf(added, range, (found, site, when) => partlyComputed(found, wanted(site, when)));
    if (ticket === latest.current && missing.length) setPending({ range, missing, changesDates: false });
  }

  /** Show the new dates and start computing what they lack. */
  async function confirm() {
    if (!pending) return;

    const { range, missing, changesDates } = pending;
    setPending(null);
    if (changesDates) apply(range);

    const first = snapshotAt(range, 0).toISOString();
    const results = await Promise.allSettled(missing.map((item) => run(item.site, range, first)));
    const problems = results.flatMap((result, index) =>
      result.status === "rejected" ? [`${missing[index].site.name} · ${errorText(result.reason)}`] : []);
    const started = missing.filter((_, index) => results[index].status === "fulfilled").map((item) => item.site);

    onProblems(problems.length ? problems.join(" ") : null);
    if (started.length) onStarted(started);
  }

  /** Leave things as they were: the previous dates stay, or the site simply waits for Run. */
  function keepPrevious() {
    latest.current++;
    setPending(null);
  }

  return { pending, request, offer, confirm, keepPrevious };
}
