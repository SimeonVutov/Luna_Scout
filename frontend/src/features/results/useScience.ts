import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelRun, lookupRun, pauseRun, prioritizeRuns, resumeRun, runEvents, runSeries, runSnapshot, runStatus, submitRun } from "../../api/client";
import type { ChosenOptions, FramePayload, Reading, RunStatus, Site, TimeRange } from "../../api/types";
import { resolveOptions } from "../settings/gridSpacing";

const storageKey = "lunascout.runs.v1";

export const defaultOptions: ChosenOptions = {
  // Automatic: chosen from each site's size. A 500 m site gets 20 m, as the precomputed runs use.
  grid_spacing_m: null,
  solar_disk_samples: 37,
  integration_minutes: 15,
  mast_height_m: 2,
  collector_height_m: 2,
  receiver: "vertical_tracking",
  ray_method: "horizon",
};

/**
 * Version of the simulation's results. Saved results are matched by their request, so this is part
 * of it: when the results gain something new (match `MODEL_REVISION` in the backend's plan.py),
 * older saved results are no longer reused and the site is computed again.
 */
const MODEL_REVISION = 6;

function requestKey(site: Site, range: TimeRange, chosen: ChosenOptions) {
  const options = resolveOptions(chosen, site);
  return JSON.stringify([
    site.latitude_deg, site.longitude_deg, site.radius_m,
    range.start_utc, range.end_utc, range.snapshot_minutes,
    options.grid_spacing_m, options.solar_disk_samples, options.integration_minutes, options.mast_height_m,
    options.collector_height_m, options.receiver, options.ray_method, MODEL_REVISION,
  ]);
}

function readRunIds(): Record<string, string> {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(data).filter(([, value]) =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    )) as Record<string, string>;
  } catch {
    return {};
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Could not load simulation results.";
}

/** The server's note that a watched run no longer exists. */
function isRemoval(message: unknown): message is { run_id: string; removed: true } {
  return typeof message === "object" && message !== null && "removed" in message && "run_id" in message
    && typeof message.run_id === "string";
}

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

export function isActive(run: RunStatus | null | undefined) {
  return run?.stage === "queued" || run?.stage === "running";
}

export function useScience(sites: Site[], range: TimeRange, options: ChosenOptions, atUtc: string) {
  const [ids, setIds] = useState(readRunIds);
  const [statuses, setStatuses] = useState<Record<string, RunStatus>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [reconnecting, setReconnecting] = useState(false);
  const [priorityError, setPriorityError] = useState<string | null>(null);
  // Requests already asked about, so each is looked up once per page load.
  const lookedUp = useRef(new Set<string>());
  // Runs this browser paused that keep running because another browser still wants them.
  const [pausedForYou, setPausedForYou] = useState<ReadonlySet<string>>(new Set());

  const accept = useCallback((incoming: RunStatus) => {
    setStatuses((current) => {
      if (current[incoming.run_id]?.revision >= incoming.revision) return current;
      return { ...current, [incoming.run_id]: incoming };
    });
  }, []);
  const watched = useMemo(() => [...new Set(sites.map((site) =>
    ids[requestKey(site, range, options)],
  ).filter(Boolean))].sort(), [ids, sites, range, options]);
  const watchedKey = watched.join(",");
  const activeKey = watched.filter((id) => isActive(statuses[id])).join(",");

  useEffect(() => {
    if (!watchedKey) return;
    const controller = new AbortController();
    for (const id of watchedKey.split(",")) {
      void runStatus(id, controller.signal).then(accept).catch(() => {
        // A server data change can invalidate a saved ID. Submitting again resolves it.
      });
    }
    return () => controller.abort();
  }, [watchedKey, accept]);

  useEffect(() => {
    if (!activeKey) return;
    const stream = runEvents(activeKey.split(","));
    stream.onopen = () => setReconnecting(false);
    stream.onerror = () => setReconnecting(true);
    stream.onmessage = (event) => {
      const message: unknown = JSON.parse(event.data);
      if (isRemoval(message)) forget(message.run_id);
      else accept(message as RunStatus);
    };
    return () => { stream.close(); setReconnecting(false); };
  }, [activeKey, accept]);

  useEffect(() => {
    if (!activeKey) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void prioritizeRuns(activeKey.split(","), atUtc, controller.signal)
        .then(() => setPriorityError(null))
        .catch((error) => {
          if (!controller.signal.aborted) setPriorityError(message(error));
        });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [activeKey, atUtc]);

  /**
   * Start a simulation. Samples already computed for the same site and settings are reused by
   * the server, so a longer or shorter timeline only computes what is missing.
   */
  async function run(site: Site, target: TimeRange = range, priorityAt: string = atUtc) {
    const key = requestKey(site, target, options);
    setPending((current) => ({ ...current, [key]: true }));
    try {
      const status = await submitRun({ ...target, ...resolveOptions(options, site), site, priority_utc: priorityAt });
      accept(status);
      setIds((current) => ({ ...current, [key]: status.run_id }));
    } finally {
      setPending((current) => ({ ...current, [key]: false }));
    }
  }

  /**
   * For saved sites this browser has no run for, ask the server what it already has. An existing
   * run is shown straight away. When earlier runs of the same site and settings already hold every
   * sample of the dates, a run is made from them at once. Nothing is computed unasked.
   */
  useEffect(() => {
    for (const site of sites) {
      const key = requestKey(site, range, options);
      // A request being submitted right now, for example by a date change, needs no lookup.
      if (site.latitude_deg > -60 || ids[key] || pending[key] || lookedUp.current.has(key)) continue;

      lookedUp.current.add(key);
      const request = { ...range, ...resolveOptions(options, site), site, priority_utc: atUtc };
      void lookupRun(request, new AbortController().signal).then((found) => {
        const existing = found.run;
        if (existing) {
          // Only a finished run is shown without asking. An unfinished one is taken on when the
          // user presses Run or agrees to compute the missing dates.
          if (existing.stage === "complete") {
            accept(existing);
            setIds((current) => ({ ...current, [key]: existing.run_id }));
          }
        } else if (found.reusable_samples >= found.total_samples) {
          // Everything is already computed, so showing it costs nothing. Anything missing is
          // computed only when the user asks (Run) or agrees (new dates).
          void run(site, range, atUtc).catch(() => undefined);
        }
      }).catch(() => lookedUp.current.delete(key));
    }
  // `run` and `atUtc` change on every render and do not change what a lookup finds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites, range, options, ids, accept]);

  /** Whether this browser has asked for exactly this site and range. */
  function wanted(site: Site, target: TimeRange) {
    return Boolean(ids[requestKey(site, target, options)]);
  }

  /** Stop computing a site's run, keeping what is done. */
  async function pause(site: Site) {
    const id = ids[requestKey(site, range, options)];
    if (!id) return;

    const status = await pauseRun(id);
    accept(status);
    // Still running means another browser wants it; it carries on for them.
    if (isActive(status)) setPausedForYou((current) => new Set(current).add(id));
  }

  async function resume(site: Site) {
    const id = ids[requestKey(site, range, options)];
    if (!id) return;

    accept(await resumeRun(id));
    setPausedForYou((current) => without(current, id));
  }

  /**
   * Withdraw this browser's request and stop showing the run. Nothing is deleted: what it
   * computed is reused if anyone asks for these dates again. It is not restarted on this page.
   */
  async function cancel(site: Site) {
    const key = requestKey(site, range, options);
    const id = ids[key];
    if (!id) return;

    await cancelRun(id);
    lookedUp.current.add(key);
    forget(id);
  }

  /** Stop tracking a run: cancelled here, or no longer on the server. */
  function forget(id: string) {
    setIds((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value !== id)));
    setStatuses((current) => Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== id)));
    setPausedForYou((current) => without(current, id));
  }

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(ids)); }
    catch { /* Runs remain usable in this tab if browser storage is unavailable. */ }
  }, [ids]);

  return {
    run,
    wanted,
    pause,
    resume,
    cancel,
    pausedForYou: (site: Site | null) => {
      const id = site ? ids[requestKey(site, range, options)] : undefined;
      return id !== undefined && pausedForYou.has(id);
    },
    status: (site: Site | null) => site ? statuses[ids[requestKey(site, range, options)]] ?? null : null,
    submitting: (site: Site | null) => site ? Boolean(pending[requestKey(site, range, options)]) : false,
    reconnecting,
    priorityError: activeKey ? priorityError : null,
  };
}

export function useRunOutput(run: RunStatus | null, index: number) {
  const [frame, setFrame] = useState<{ key: string; runId: string; value: FramePayload } | null>(null);
  const [frameError, setFrameError] = useState<{ key: string; message: string } | null>(null);
  const id = run?.run_id;
  const ready = Boolean(run?.ready_indices.includes(index));
  const key = ready ? `${id}/${index}` : null;

  useEffect(() => {
    if (!id || !key) return;
    const controller = new AbortController();
    setFrameError(null);
    void runSnapshot(id, index, controller.signal).then((value) => {
      if (!controller.signal.aborted) setFrame({ key, runId: id, value });
    }).catch((error) => {
      if (!controller.signal.aborted) setFrameError({ key, message: message(error) });
    });
    return () => controller.abort();
  }, [id, index, key]);

  // While the next hour loads, keep showing the previous one from the same run. Dropping it
  // would blank the map and the numbers for a moment on every step of the timeline. An hour
  // that has not been computed yet still shows nothing, so old data is never passed off as new.
  const current = frame?.key === key ? frame : null;
  const retained = key !== null && frame?.runId === id ? frame : null;
  return {
    frame: (current ?? retained)?.value ?? null,
    error: frameError?.key === key ? frameError.message : null,
  };
}

export function useRunSeries(run: RunStatus | null) {
  const [series, setSeries] = useState<{ id: string; values: Reading[] } | null>(null);
  const id = run?.run_id;
  const frameCount = run?.ready_indices.length ?? 0;
  useEffect(() => {
    if (!id || !frameCount) return;
    const controller = new AbortController();
    void runSeries(id, controller.signal).then((values) => {
      if (!controller.signal.aborted) setSeries({ id, values });
    }).catch(() => {
      // The chart is optional while the selected frame still loads independently.
    });
    return () => controller.abort();
  }, [id, frameCount]);

  return series?.id === id ? series?.values ?? [] : [];
}
