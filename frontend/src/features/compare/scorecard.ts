import type { Bounds, PeriodSummary, SiteContext, SiteExtremes, SiteInsight, SiteMap } from "../../api/types";
import { bound, decimal, energy, longestLabel, middle, wholePercent } from "../results/format";
import type { Slot } from "./slots";

/** Everything a scorecard row can read for one site. */
export type RowData = { period: PeriodSummary | null; context: SiteContext | null; insight: SiteInsight | null; siteMap: SiteMap | null };

export type ScoreRow = {
  label: string;
  /** Which value is better; "none" for facts that are neither good nor bad on their own. */
  better: "higher" | "lower" | "none";
  /** Whether the numbers are available yet; if not, the cell says the run is still going. */
  ready: (data: RowData) => boolean;
  number: (data: RowData) => number | null;
  text: (data: RowData) => string;
};

export type ScoreGroup = {
  title: string;
  /** What the group's numbers cover. May depend on the standards a run's results used. */
  note: (siteMap: SiteMap | null) => string;
  rows: ScoreRow[];
};

const hours = (bounds: Bounds | null | undefined) => bound(bounds, decimal, " h");
const percent = (value: number | null | undefined) => value === null || value === undefined ? "—" : wholePercent.format(value);

/** A row read from the run's period summary. */
function runRow(label: string, better: ScoreRow["better"], number: (p: PeriodSummary) => number | null, text: (p: PeriodSummary) => string): ScoreRow {
  return {
    label, better,
    ready: (data) => data.period !== null,
    number: (data) => data.period ? number(data.period) : null,
    text: (data) => data.period ? text(data.period) : "—",
  };
}

/** A row about the place, which does not wait for the run. */
function placeRow(label: string, better: ScoreRow["better"], value: (data: RowData) => number | null, text: (data: RowData) => string = (data) => percent(value(data))): ScoreRow {
  return { label, better, ready: () => true, number: value, text };
}

/** A row read from every point of the site over the whole run. */
function siteRow(label: string, better: ScoreRow["better"], value: (map: SiteMap) => number | null, text: (map: SiteMap) => string): ScoreRow {
  return {
    label, better,
    ready: (data) => data.siteMap !== null,
    number: (data) => data.siteMap ? value(data.siteMap) : null,
    text: (data) => data.siteMap ? text(data.siteMap) : "—",
  };
}

/** A row for the typical or best duration of a whole-site extreme, marked "≥" when the period cut it off. */
function durationRow(label: string, better: ScoreRow["better"], extremesOf: (map: SiteMap) => SiteExtremes, field: "typical_hours" | "best_hours") {
  return siteRow(label, better, (map) => extremesOf(map)[field], (map) => {
    const extremes = extremesOf(map);
    return `${extremes.truncated ? "≥ " : ""}${decimal.format(extremes[field])} h`;
  });
}

const areaRow = (label: string, share: (map: SiteMap) => number | null) =>
  siteRow(label, "higher", share, (map) => percent(share(map)));

export const scoreGroups: ScoreGroup[] = [
  {
    title: "Power",
    note: () => "For the selected dates, at the centre of the site",
    rows: [
      runRow("Solar energy on receiver", "higher", (p) => middle(p.incident_energy_kwh_m2), (p) => bound(p.incident_energy_kwh_m2, energy, " kWh/m²")),
      runRow("Sunlit time · any Sun", "higher", (p) => middle(p.sunlit_hours), (p) => hours(p.sunlit_hours)),
      runRow("Sunlit time · at least half the Sun", "higher", (p) => middle(p.half_disk_sunlit_hours), (p) => hours(p.half_disk_sunlit_hours)),
      runRow("Longest day · continuous sunlight", "higher", (p) => p.longest_daylight?.hours ?? 0, (p) => longestLabel(p.longest_daylight)),
      runRow("Longest darkness", "lower", (p) => p.longest_darkness?.hours ?? 0, (p) => longestLabel(p.longest_darkness)),
    ],
  },
  {
    title: "Communication",
    note: () => "For the selected dates, at the centre of the site",
    rows: [
      runRow("Earth visible at mast", "higher", (p) => middle(p.earth_visible_hours), (p) => hours(p.earth_visible_hours)),
      runRow("Longest Earth contact", "higher", (p) => p.longest_earth_contact?.hours ?? 0, (p) => longestLabel(p.longest_earth_contact)),
      runRow("Longest Earth blackout", "lower", (p) => p.longest_earth_blackout?.hours ?? 0, (p) => longestLabel(p.longest_earth_blackout)),
    ],
  },
  {
    title: "Across the whole site",
    note: (map) => map
      ? `Every point, for the selected dates. Good for Sun: lit at least ${wholePercent.format(map.sun_good_share)} of the time. Good for Earth contact: Earth in view at least ${wholePercent.format(map.earth_good_share)}.`
      : "Every point, for the selected dates",
    rows: [
      durationRow("Longest day · typical point", "higher", (map) => map.summary.longest_day, "typical_hours"),
      durationRow("Longest day · best spot", "higher", (map) => map.summary.longest_day, "best_hours"),
      durationRow("Longest darkness · typical point", "lower", (map) => map.summary.longest_dark, "typical_hours"),
      durationRow("Longest darkness · best spot", "lower", (map) => map.summary.longest_dark, "best_hours"),
      areaRow("Area good for Sun", (map) => map.summary.area_good_for_sun),
      areaRow("Area good for Earth contact", (map) => map.summary.area_good_for_earth),
      areaRow("Area good for both", (map) => map.summary.area_good_for_both),
    ],
  },
  {
    title: "Long-term and terrain",
    note: () => "NASA maps averaged over 18.6 years, over the whole site",
    rows: [
      placeRow("Average sunlight", "higher", (d) => d.context?.summary.average_sunlight ?? null),
      placeRow("Average Earth visibility", "higher", (d) => d.context?.summary.average_earth ?? null),
      placeRow("Permanent shadow (cold traps)", "none", (d) => d.context?.summary.permanent_shadow_share ?? null),
      placeRow("Open sky", "higher", (d) => d.context?.summary.sky_openness ?? null),
      placeRow("Ground at or below 10°", "higher", (d) => d.insight?.summary.gentle_area_fractions["10"] ?? null),
      placeRow("Mean slope", "lower", (d) => d.insight?.summary.slope_mean_deg ?? null,
        (d) => d.insight?.summary.slope_mean_deg == null ? "—" : `${decimal.format(d.insight.summary.slope_mean_deg)}°`),
    ],
  },
];

/** The better site for a row, or null when the values are missing or within 2% of each other. */
export function winner(row: ScoreRow, a: RowData, b: RowData): Slot | null {
  if (row.better === "none") return null;

  const first = row.number(a);
  const second = row.number(b);
  if (first === null || second === null) return null;

  const spread = Math.abs(first - second);
  if (spread <= 0.02 * Math.max(Math.abs(first), Math.abs(second)) || spread < 0.05) return null;

  const firstWins = row.better === "higher" ? first > second : first < second;
  return firstWins ? "a" : "b";
}
