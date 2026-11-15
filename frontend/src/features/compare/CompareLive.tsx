import { useState } from "react";
import type { Reading, RunStatus, Site, SunlightGrid } from "../../api/types";
import { Icon } from "../../Icon";
import { SouthPoleMap } from "../globe/SouthPoleMap";
import { StatTiles } from "../results/SiteMetrics";
import { coordinatesLabel } from "../sites/referenceSites";
import { slotColor, slotLabel, slots } from "./slots";
import type { Slot } from "./slots";

type PaneData = {
  site: Site | null;
  run: RunStatus | null;
  reading: Reading | null;
  sunlight: SunlightGrid | null;
};

type LiveProps = {
  panes: Record<Slot, PaneData>;
  at: Date;
  showSunlight: boolean;
  onToggleSunlight: () => void;
};

/** Two independent 2D maps, one per site, driven by the shared timeline. */
export function CompareLive({ panes, at, showSunlight, onToggleSunlight }: LiveProps) {
  return <div className="compare-live">
    {slots.map((slot) => <Pane key={`${slot}-${panes[slot].site?.id ?? "none"}`} slot={slot} data={panes[slot]} at={at}
      showSunlight={showSunlight} onToggleSunlight={onToggleSunlight} />)}
  </div>;
}

function Pane({ slot, data, at, showSunlight, onToggleSunlight }: {
  slot: Slot;
  data: PaneData;
  at: Date;
  showSunlight: boolean;
  onToggleSunlight: () => void;
}) {
  const { site } = data;
  const [cameraTarget, setCameraTarget] = useState<Site | null>(site ? { ...site } : null);

  if (!site) {
    return <section className="compare-pane empty">
      <p className="sidebar-note">Choose site {slotLabel[slot]} in the left panel.</p>
    </section>;
  }

  return <section className="compare-pane" aria-label={`Site ${slotLabel[slot]}: ${site.name}`}>
    <header className="pane-card" style={{ borderTopColor: slotColor[slot] }}>
      <div className="pane-title">
        <span className="site-chip" style={{ background: slotColor[slot] }}>{slotLabel[slot]}</span>
        <div className="pane-name">
          <strong>{site.name}</strong>
          <small>{coordinatesLabel(site.latitude_deg, site.longitude_deg)} · {site.radius_m.toLocaleString("en-GB")} m</small>
        </div>
        <button type="button" className="button quiet" onClick={() => setCameraTarget({ ...site })}><Icon name="target" size={15} /> Recentre</button>
      </div>
      <StatTiles reading={data.reading} run={data.run} at={at} />
    </header>
    <div className="pane-map">
      <SouthPoleMap compact sites={[site]} selectedId={site.id} draft={null} picking={false}
        onPick={() => undefined} onSelect={() => undefined} cameraTarget={cameraTarget}
        sunlight={data.sunlight} showSunlight={showSunlight} onToggleSunlight={onToggleSunlight} />
    </div>
  </section>;
}
