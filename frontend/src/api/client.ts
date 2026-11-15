import type { Site, SiteSpec } from "./types";

async function send<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the LunaScout API. Check that the backend is running.");
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : null;
    throw new Error(detail ?? "The request could not be completed. Check the API and try again.");
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
