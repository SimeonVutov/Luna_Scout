import { useEffect, useRef, useState } from "react";
import { runRays, siteRays } from "../../api/client";
import type { RayFan, RunStatus, SimulationOptions, Site, SiteRays, TimeRange } from "../../api/types";

/** What the 3D view draws: Sun and Earth fans from points across the site. */
export type ShownRays = { sun: RayFan[]; earth: RayFan[]; from: "simulation" | "on demand" };

/** Snapshots read ahead of the playhead while the timeline plays. */
const PREFETCH = 24;
const PARALLEL = 3;
const REMEMBERED = 160;
// Rays of a snapshot never change, so every hook instance shares one memory.
const remembered = new Map<string, ShownRays>();
// Snapshots known to be saved without rays (computed before they were stored).
const missing = new Set<string>();

function remember(key: string, rays: ShownRays) {
  remembered.set(key, rays);
  if (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value!);
}

function fromRun(rays: { sun_points: RayFan[]; earth_points: RayFan[] }): ShownRays {
  return { sun: rays.sun_points, earth: rays.earth_points, from: "simulation" };
}

/** Older servers leave out the fans from across the site; then the centre's fan is all there is. */
function fromOnDemand(rays: SiteRays): ShownRays {
  return {
    sun: rays.sun_points?.length ? rays.sun_points : [rays.sun],
    earth: rays.earth_points?.length ? rays.earth_points : [rays.earth],
    from: "on demand",
  };
}

/**
 * The Sun and Earth rays for the snapshot at `timeIndex`. They come from the simulation's own
 * saved frame when it is ready, which is fast and follows the timeline, and are traced on
 * demand otherwise. While the next time loads, the previous rays stay on screen.
 */
export function useSiteRays(
  site: Site | null, run: RunStatus | null, range: TimeRange, options: SimulationOptions,
  timeIndex: number, enabled: boolean,
) {
  const [shown, setShown] = useState<{ siteKey: string; key: string; rays: ShownRays } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const supported = enabled && site !== null && site.latitude_deg <= -60;
  const siteKey = site ? `${site.latitude_deg}/${site.longitude_deg}/${site.radius_m}` : "";
  const ahead = useRef<AbortController | null>(null);
  const lastIndex = Math.ceil((Date.parse(range.end_utc) - Date.parse(range.start_utc)) / (range.snapshot_minutes * 60_000)) - 1;

  /** Where the rays of timeline step `index` come from, and the name they are remembered by. */
  function sourceOf(index: number) {
    const sampleIndex = Math.round(index * range.snapshot_minutes / options.integration_minutes);
    const saved = run !== null && run.ready_indices.includes(index);
    const key = saved
      ? `run/${run.run_id}/${index}`
      : JSON.stringify([
        "demand", siteKey, range.start_utc, range.end_utc, options.integration_minutes, sampleIndex,
        options.solar_disk_samples, options.mast_height_m, options.collector_height_m, options.receiver, options.grid_spacing_m,
      ]);
    return { key, saved, sampleIndex };
  }

  /** Fetch the rays of step `index` into memory. */
  async function fetchStep(index: number, signal: AbortSignal) {
    if (!site) return;
    const { key, saved, sampleIndex } = sourceOf(index);
    if (remembered.has(key)) return;
    if (saved && run && !missing.has(key)) {
      try {
        remember(key, fromRun(await runRays(run.run_id, index, signal)));
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        // A frame computed before rays were saved is traced on demand instead.
        missing.add(key);
      }
    }
    remember(key, fromOnDemand(await siteRays(site, range, options, sampleIndex, true, signal)));
  }

  const { key } = sourceOf(timeIndex);
  const active = supported ? key : null;

  useEffect(() => {
    if (!active || !site) return;
    const cached = remembered.get(active);
    if (cached) {
      setShown({ siteKey, key: active, rays: cached });
      return;
    }

    const controller = new AbortController();
    const load = () => fetchStep(timeIndex, controller.signal).then(() => {
      // A frame without saved rays changes its key once traced on demand.
      const rays = remembered.get(sourceOf(timeIndex).key);
      if (rays && !controller.signal.aborted) setShown({ siteKey, key: active, rays });
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure({ key: active, message: error instanceof Error ? error.message : "Could not trace the rays." });
    });
    // Rays traced on demand wait a moment, which skips times the playhead only passes through.
    const timer = window.setTimeout(() => void load(), sourceOf(timeIndex).saved ? 0 : 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  // The key already captures everything the request depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Load the next steps ahead, a few at a time, so playing the timeline finds them in memory.
  useEffect(() => {
    ahead.current?.abort();
    if (!supported) return;
    const controller = new AbortController();
    ahead.current = controller;
    const queue: number[] = [];
    for (let index = timeIndex + 1; index <= Math.min(lastIndex, timeIndex + PREFETCH); index++) queue.push(index);
    const worker = async () => {
      for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
        if (controller.signal.aborted) return;
        // Only snapshots the simulation has already saved are read ahead. Tracing the rest on demand
        // is slow, and the run saves them soon anyway.
        if (!sourceOf(index).saved) continue;
        try {
          await fetchStep(index, controller.signal);
        } catch {
          if (controller.signal.aborted) return;
        }
      }
    };
    void Promise.all(Array.from({ length: PARALLEL }, worker));
    return () => controller.abort();
  // Steps ahead depend on the run's ready frames and the playhead only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, siteKey, run?.run_id, run?.ready_indices.length, timeIndex]);

  const usable = active !== null && shown?.siteKey === siteKey ? shown : null;
  return {
    rays: usable?.rays ?? null,
    loading: active !== null && usable?.key !== active && failure?.key !== active,
    error: failure?.key === active ? failure.message : null,
  };
}
