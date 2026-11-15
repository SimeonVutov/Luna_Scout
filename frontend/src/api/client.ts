import type { FramePayload, Reading, RunList, RunRequest, RunStatus, RunRays, SimulationOptions, Site, SiteContext, SiteMap, SiteInsight, SiteRays, SiteSpec, SkyBatch, TimeRange } from "./types";

/** A failed API call. `status` is null when the server could not be reached at all. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

async function send<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError("Could not reach the LunaScout API. Check that the backend is running.", null);
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : payload?.detail?.[0]?.msg;
    throw new ApiError(detail ?? "The request could not be completed. Check the API and try again.", response.status);
  }
  if (payload === null) throw new Error("The API returned an empty or invalid response.");
  return payload as T;
}

export function listSites() {
  return send<Site[]>("/sites");
}
export function createSite(site: SiteSpec) {
  return send<Site>("/sites", "POST", site);
}
export function updateSite(id: string, site: SiteSpec) {
  return send<Site>(`/sites/${id}`, "PUT", site);
}
export function removeSite(id: string) {
  return send<void>(`/sites/${id}`, "DELETE");
}

export function submitRun(request: RunRequest) {
  return send<RunStatus>("/runs", "POST", request);
}

export function runStatus(id: string, signal?: AbortSignal) {
  return send<RunStatus>(`/runs/${id}`, "GET", undefined, signal);
}

export function prioritizeRuns(ids: string[], at: string, signal: AbortSignal) {
  return send<void>("/runs/priority", "PUT", { run_ids: ids, at_utc: at }, signal);
}

export function runEvents(ids: string[]) {
  const query = new URLSearchParams();
  ids.forEach((id) => query.append("run_id", id));
  return new EventSource(`/api/runs/events?${query}`);
}

export function runSeries(id: string, signal: AbortSignal) {
  return send<Reading[]>(`/runs/${id}/series`, "GET", undefined, signal);
}

export function runSnapshot(id: string, index: number, signal: AbortSignal) {
  return send<FramePayload>(`/runs/${id}/snapshots/${index}`, "GET", undefined, signal);
}

/** Sun and Earth positions for the batch of samples around sample `index` of a time range. */
export function skyBatch(range: TimeRange, integrationMinutes: number, index: number, signal?: AbortSignal) {
  const query = new URLSearchParams({
    start_utc: range.start_utc, end_utc: range.end_utc,
    integration_minutes: String(integrationMinutes), index: String(index),
  });
  return send<SkyBatch>(`/sky?${query}`, "GET", undefined, signal);
}

/** How every point of a finished run's site fared over the whole run. */
export function runSiteMap(id: string, signal: AbortSignal) {
  return send<SiteMap>(`/runs/${id}/site-map`, "GET", undefined, signal);
}

/** The rays of a published snapshot, saved by the worker with the frame. */
export function runRays(id: string, index: number, signal: AbortSignal) {
  return send<RunRays>(`/runs/${id}/rays/${index}`, "GET", undefined, signal);
}

/** The Sun and Earth disk rays at a site's centre for sample `index` of a time range. */
export function siteRays(site: SiteSpec, range: TimeRange, options: SimulationOptions, index: number, wholeSite: boolean, signal: AbortSignal) {
  return send<SiteRays>("/terrain/rays", "POST", {
    site, start_utc: range.start_utc, end_utc: range.end_utc,
    integration_minutes: options.integration_minutes, index,
    solar_disk_samples: options.solar_disk_samples,
    whole_site: wholeSite, grid_spacing_m: options.grid_spacing_m,
    mast_height_m: options.mast_height_m,
    // A terrain receiver lies on the ground, as in the simulation.
    collector_height_m: options.receiver === "terrain" ? 0 : options.collector_height_m,
  }, signal);
}

export function siteInsight(
  site: SiteSpec, settings: { grid_spacing_m: number; collector_height_m: number; mast_height_m: number }, signal: AbortSignal,
) {
  const query = new URLSearchParams(Object.entries(settings).map(([name, value]) => [name, String(value)]));
  return send<SiteInsight>(`/terrain/insight?${query}`, "POST", site, signal);
}

/** NASA's long-term maps over a site: average sunlight and Earth visibility, shadow, open sky. */
export function siteContext(site: SiteSpec, gridSpacingM: number, signal: AbortSignal) {
  return send<SiteContext>(`/terrain/context?grid_spacing_m=${gridSpacingM}`, "POST", site, signal);
}

export function listRuns(signal: AbortSignal) {
  return send<RunList>("/runs?limit=30", "GET", undefined, signal);
}

/**
 * Free the stored results of a deleted site. With `keep`, they are retained (hidden) so the
 * site can be restored later; without it, everything is removed to save space.
 */
export function releaseSiteData(site: SiteSpec, keep: boolean) {
  const query = new URLSearchParams({
    latitude_deg: String(site.latitude_deg), longitude_deg: String(site.longitude_deg),
    radius_m: String(site.radius_m), keep: String(keep),
  });
  return send<{ runs_removed: number; runs_kept: number; horizon_maps_removed: number }>(`/runs/site?${query}`, "DELETE");
}
