import { useMemo } from "react";
import type { Site, TimeRange } from "../../api/types";
import { coordinatesLabel } from "../sites/referenceSites";
import { clockLabel, dateLabel, snapshotCount } from "../timeline/time";
import { demoPeriod, demoSkySeries } from "./demoResults";
import type { DemoSnapshot } from "./demoResults";
import { SkyChart } from "./SkyChart";

const decimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const energy = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const ratio = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 0 });

function duration(minutes: number) {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  return whole % 60 ? `${decimal.format(hours)} h ${whole % 60} min` : `${decimal.format(hours)} h`;
}

export function ResultsPanel({ site, at, range, index, snapshot }: {
  site: Site | null;
  at: Date;
  range: TimeRange;
  index: number;
  snapshot: DemoSnapshot | null;
}) {
  const period = useMemo(() => site && demoPeriod(site, range), [site, range]);
  const series = useMemo(() => site ? demoSkySeries(site, range) : [], [site, range]);

  return (
    <aside className="panel results-panel" aria-label="Site results">
      <div className="panel-title"><h2>Site results</h2>{site && <span className="demo-label">Demo data</span>}</div>
      {site && snapshot && period ? <>
        <div className="result-site">
          <h3>{site.name}</h3>
          <p>{coordinatesLabel(site.latitude_deg, site.longitude_deg)} · {decimal.format(site.radius_m)} m radius</p>
        </div>

        <section className="result-section">
          <div className="result-section-heading">
            <h4>Selected time</h4>
            <time dateTime={at.toISOString()}>{dateLabel(at)} · {clockLabel(at)} UTC</time>
          </div>
          <dl className="metrics">
            <div><dt>Lit area</dt><dd>{ratio.format(snapshot.litAreaFraction)}</dd></div>
            <div><dt>Direct irradiance</dt><dd>{decimal.format(snapshot.directIrradianceWm2)} W/m²</dd></div>
            <div><dt>Earth at center mast</dt><dd className={snapshot.earthVisible ? "visible-value" : ""}>{snapshot.earthVisible ? "Visible" : "Obscured"}</dd></div>
          </dl>
        </section>

        <SkyChart samples={series} position={index / Math.max(1, snapshotCount(range) - 1)} current={snapshot} />

        <section className="result-section">
          <div className="result-section-heading">
            <h4>Over the selected period</h4>
          </div>
          <dl className="metrics">
            <div><dt>Area-weighted sunlit time</dt><dd>{duration(period.sunlitMinutes)}</dd></div>
            <div><dt>Incident solar energy</dt><dd>{energy.format(period.incidentEnergyKwhM2)} kWh/m²</dd></div>
            <div><dt>Earth visible time</dt><dd>{duration(period.earthVisibleMinutes)}</dd></div>
          </dl>
        </section>
      </> : <p className="sidebar-note">Add or select a landing site to see its demo results.</p>}
    </aside>
  );
}
