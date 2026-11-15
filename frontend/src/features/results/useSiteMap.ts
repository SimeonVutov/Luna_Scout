import { useEffect, useState } from "react";
import { runSiteMap } from "../../api/client";
import type { RunStatus, SiteMap } from "../../api/types";

// A finished run never changes, so its per-point results are kept for every hook instance.
const remembered = new Map<string, SiteMap | "unavailable">();

/**
 * How every point of the run's site fared over the whole run, once the run has finished.
 * Null until then, and for a server that predates this result.
 */
export function useSiteMap(run: RunStatus | null) {
  const runId = run?.stage === "complete" ? run.run_id : null;
  const [entry, setEntry] = useState<SiteMap | "unavailable" | undefined>(runId ? remembered.get(runId) : undefined);

  useEffect(() => {
    if (!runId) { setEntry(undefined); return; }

    const known = remembered.get(runId);
    setEntry(known);
    if (known) return;

    const controller = new AbortController();
    void runSiteMap(runId, controller.signal)
      .then((value) => { remembered.set(runId, value); setEntry(value); })
      .catch(() => { if (!controller.signal.aborted) setEntry("unavailable"); });
    return () => controller.abort();
  }, [runId]);

  return entry === undefined || entry === "unavailable" ? null : entry;
}
