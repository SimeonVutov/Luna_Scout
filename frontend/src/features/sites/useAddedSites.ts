import { useEffect, useRef } from "react";
import type { Site } from "../../api/types";

/**
 * Calls `onAdded` with the sites that appear in the list after it first loaded. The sites saved
 * before the page opened are not "added", so nothing is asked about them on every reload.
 */
export function useAddedSites(sites: Site[], loaded: boolean, onAdded: (added: Site[]) => void) {
  const known = useRef<Set<string> | null>(null);
  const latest = useRef(onAdded);
  latest.current = onAdded;

  useEffect(() => {
    if (!loaded) return;

    const before = known.current;
    known.current = new Set(sites.map((site) => site.id));
    if (!before) return;

    const added = sites.filter((site) => !before.has(site.id));
    if (added.length) latest.current(added);
  }, [sites, loaded]);
}
