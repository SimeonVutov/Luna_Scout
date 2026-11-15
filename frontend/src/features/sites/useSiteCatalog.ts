import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../api/errorText";
import type { Site, SiteSpec } from "../../api/types";
import { siteCatalog } from "./siteCatalog";

export type CatalogState = "loading" | "ready" | "error";

/**
 * The saved sites, which one is selected, and the actions that change the catalogue. Failures are
 * reported through `reportError` so the page can show them in one place.
 */
export function useSiteCatalog(reportError: (message: string | null) => void) {
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<CatalogState>("loading");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState("loading");

    try {
      const saved = await siteCatalog.list();
      setSites(saved);
      setSelectedId((id) => saved.some((site) => site.id === id) ? id : saved[0]?.id ?? null);
      setState("ready");
      reportError(null);
    } catch (failure) {
      setState("error");
      reportError(errorText(failure));
    }
  }, [reportError]);

  useEffect(() => { void load(); }, [load]);

  /** Run a change to the catalogue: mark the page busy, and report a failure instead of throwing. */
  async function change<T>(action: () => Promise<T>): Promise<{ value: T } | null> {
    setBusy(true);
    reportError(null);

    try {
      return { value: await action() };
    } catch (failure) {
      reportError(errorText(failure));
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** Save a new site and select it. Returns it, or null when saving failed. */
  async function create(spec: SiteSpec) {
    const result = await change(() => siteCatalog.create(spec));
    if (!result) return null;

    setSites((current) => [...current, result.value]);
    setSelectedId(result.value.id);
    return result.value;
  }

  /** Save changes to a site. Returns whether they were saved. */
  async function edit(site: Site) {
    const { id, ...spec } = site;
    const result = await change(() => siteCatalog.update(id, spec));
    if (!result) return false;

    setSites((current) => current.map((saved) => saved.id === result.value.id ? result.value : saved));
    return true;
  }

  /** Delete a site. Returns whether it was deleted; selection moves to the first remaining site. */
  async function remove(site: Site) {
    const result = await change(() => siteCatalog.remove(site.id));
    if (!result) return false;

    const remaining = sites.filter((saved) => saved.id !== site.id);
    setSites(remaining);
    setSelectedId((id) => id === site.id ? remaining[0]?.id ?? null : id);
    return true;
  }

  return {
    sites,
    selected: sites.find((site) => site.id === selectedId) ?? null,
    selectedId,
    select: setSelectedId,
    state,
    busy,
    reload: load,
    create,
    edit,
    remove,
  };
}
