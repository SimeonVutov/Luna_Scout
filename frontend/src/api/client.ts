import type { FramePayload, Reading, RunList, RunRequest, RunStatus, Site, SiteInsight, SiteSpec, TerrainPreview } from "./types";

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

export function terrainPreview(site: SiteSpec, scale: "site" | "region", signal: AbortSignal) {
  return send<TerrainPreview>(`/terrain/preview?scale=${scale}`, "POST", site, signal);
}

export function siteInsight(
  site: SiteSpec, settings: { grid_spacing_m: number; collector_height_m: number; mast_height_m: number }, signal: AbortSignal,
) {
  const query = new URLSearchParams(Object.entries(settings).map(([name, value]) => [name, String(value)]));
  return send<SiteInsight>(`/terrain/insight?${query}`, "POST", site, signal);
}

export function listRuns(signal: AbortSignal) {
  return send<RunList>("/runs?limit=30", "GET", undefined, signal);
}
