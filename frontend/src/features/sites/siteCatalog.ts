import { createSite, listSites, removeSite, updateSite } from "../../api/client";
import type { Site, SiteSpec } from "../../api/types";

const storageKey = "lunascout.sites.v1";

function readSavedSites(): Site[] {
  const content = localStorage.getItem(storageKey);
  if (!content) return [];

  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed) || !parsed.every((site) =>
    site && typeof site.id === "string" && typeof site.name === "string" &&
    Number.isFinite(site.latitude_deg) && Math.abs(site.latitude_deg) <= 90 &&
    Number.isFinite(site.longitude_deg) && Math.abs(site.longitude_deg) <= 180 &&
    Number.isSafeInteger(site.radius_m) && site.radius_m > 0
  )) {
    throw new Error("The site catalog saved in this browser could not be read.");
  }
  return parsed;
}

function writeSavedSites(sites: Site[]) {
  localStorage.setItem(storageKey, JSON.stringify(sites));
}

const browserCatalog = {
  async list() {
    return readSavedSites();
  },
  async create(spec: SiteSpec) {
    const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
      part.toString(16).padStart(8, "0"),
    ).join("");
    const site = { ...spec, id };
    writeSavedSites([...readSavedSites(), site]);
    return site;
  },
  async update(id: string, spec: SiteSpec) {
    const sites = readSavedSites();
    if (!sites.some((site) => site.id === id)) throw new Error("This site was already removed.");
    const updated = { ...spec, id };
    writeSavedSites(sites.map((site) => site.id === id ? updated : site));
    return updated;
  },
  async remove(id: string) {
    writeSavedSites(readSavedSites().filter((site) => site.id !== id));
  },
};

export const usesApiCatalog = import.meta.env.VITE_SITE_STORAGE === "api";
export const siteCatalog = usesApiCatalog
  ? { list: listSites, create: createSite, update: updateSite, remove: removeSite }
  : browserCatalog;
