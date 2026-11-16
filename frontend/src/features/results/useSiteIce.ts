import { useEffect, useState } from "react";
import { siteIce } from "../../api/client";
import type { SiteIceSummary, SiteSpec } from "../../api/types";

export type IceState =
  | { status: "idle" | "loading" | "unavailable" | "outside" }
  | { status: "ready"; ice: SiteIceSummary };

// Diviner's table never changes, so every hook instance shares one memory.
const remembered = new Map<string, IceState>();

const idle: IceState = { status: "idle" };

/** Diviner's modelled temperatures and ice-stability depth for the site. */
export function useSiteIce(site: SiteSpec | null): IceState {
  const supported = site !== null && site.latitude_deg <= -60;
  const key = supported ? JSON.stringify([site.latitude_deg, site.longitude_deg, site.radius_m]) : null;
  const [state, setState] = useState<IceState>((key && remembered.get(key)) || idle);

  useEffect(() => {
    if (!key || !site) { setState(idle); return; }

    const known = remembered.get(key);
    if (known) { setState(known); return; }

    setState({ status: "loading" });
    const controller = new AbortController();
    void siteIce(site, controller.signal)
      .then(({ summary }) => {
        const next: IceState = summary ? { status: "ready", ice: summary } : { status: "outside" };
        remembered.set(key, next);
        setState(next);
      })
      // A server that predates these numbers, or whose data was not downloaded, leaves them out.
      .catch(() => { if (!controller.signal.aborted) setState({ status: "unavailable" }); });
    return () => controller.abort();
  // The key already captures everything the request depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
