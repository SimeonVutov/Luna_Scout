import type { SiteSpec, TimeRange } from "../../api/types";
import { snapshotAt, snapshotCount } from "../timeline/time";

const hourMs = 3_600_000;
const turn = 2 * Math.PI;
const periodHours = 36;

export function demoSnapshot(site: SiteSpec, at: Date) {
  const time = at.getTime() / hourMs;
  const phase = (time % periodHours) / periodHours * turn
    + (site.longitude_deg + 2 * site.latitude_deg) * Math.PI / 180;
  const sunElevationDeg = 3.3 * Math.sin(phase - 2.3) + 0.6;
  const earthElevationDeg = 5 * Math.sin(phase + 0.9);
  const horizonDeg = 0.6 + 0.35 * Math.sin(site.latitude_deg * 0.37);
  const litAreaFraction = Math.min(1, Math.max(0, 0.43 + (sunElevationDeg - horizonDeg) * 0.17));
  return {
    sunElevationDeg,
    earthElevationDeg,
    horizonDeg,
    litAreaFraction,
    directIrradianceWm2: litAreaFraction * Math.max(0, 8 + sunElevationDeg * 14),
    earthVisible: earthElevationDeg > horizonDeg,
  };
}

export type DemoSnapshot = ReturnType<typeof demoSnapshot>;

export function demoPeriod(site: SiteSpec, range: TimeRange) {
  const count = snapshotCount(range);
  // The synthetic profile repeats every 36 h. Reuse a full cycle for long ranges
  // while keeping the summary consistent with the same hourly snapshots.
  const period = periodHours * 60 / range.snapshot_minutes;
  const cycleLength = Number.isInteger(period) ? period : count;
  const stepHours = range.snapshot_minutes / 60;
  let sunlitMinutes = 0;
  let incidentEnergyKwhM2 = 0;
  let earthVisibleMinutes = 0;

  for (let index = 0; index < Math.min(cycleLength, count); index += 1) {
    const repetitions = 1 + Math.floor((count - index - 1) / cycleLength);
    const values = demoSnapshot(site, snapshotAt(range, index));
    sunlitMinutes += values.litAreaFraction * 60 * stepHours * repetitions;
    incidentEnergyKwhM2 += values.directIrradianceWm2 * stepHours * repetitions / 1000;
    earthVisibleMinutes += Number(values.earthVisible) * 60 * stepHours * repetitions;
  }
  return { sunlitMinutes, incidentEnergyKwhM2, earthVisibleMinutes };
}

export function demoSkySeries(site: SiteSpec, range: TimeRange) {
  const last = snapshotCount(range) - 1;
  const length = Math.min(last + 1, 120);
  return Array.from({ length }, (_, index) => {
    const snapshotIndex = Math.round(index * last / Math.max(1, length - 1));
    return demoSnapshot(site, snapshotAt(range, snapshotIndex));
  });
}
