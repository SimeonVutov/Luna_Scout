import { useState } from "react";
import type { Bounds, PeriodSummary, Reading, RunStatus, Site, SiteContext, SiteInsight, TimeRange } from "../../api/types";
import { bound, decimal, energy, longestLabel, middle, ratio, wholePercent } from "../results/format";
import { Legend, LineChart, PairedBars, WindowStrips, niceMax } from "./charts";
import type { BarGroup, LineSeries, StripRow } from "./charts";
import { slotColor, slotLabel, slots } from "./slots";
import type { Slot } from "./slots";
import "./compare.css";

type SummaryPane = { site: Site | null; run: RunStatus | null; series: Reading[]; context: SiteContext | null; insight: SiteInsight | null };

/** What a chart can plot over time. Fractions are drawn on a 0–100% axis. */
type Measure = {
  id: string;
  label: string;
  fraction: boolean;
  unit?: string;
  get: (reading: Reading) => number | null;
};

const sunMeasures: Measure[] = [
  { id: "lit", label: "Lit area · any Sun", fraction: true, get: (reading) => middle(reading.summary.lit_area_fraction) },
  { id: "half", label: "Lit area · at least half the Sun", fraction: true, get: (reading) => middle(reading.summary.half_disk_lit_area_fraction) },
  { id: "usable", label: "Lit and gentle (≤ 10°)", fraction: true, get: (reading) => middle(reading.summary.usable_area_fraction) },
  { id: "mean", label: "Mean fraction of the Sun visible", fraction: true, get: (reading) => middle(reading.summary.mean_visible_sun_fraction) },
  { id: "power", label: "Irradiance on the receiver", fraction: false, unit: " W/m²", get: (reading) => middle(reading.summary.mean_irradiance_on_known_ground_w_m2) },
];

const earthMeasures: Measure[] = [
  { id: "disk", label: "Earth disk visible from the mast", fraction: true, get: (reading) => middle(reading.earth_disk_visible_fraction) },
  { id: "area", label: "Area seeing at least half of Earth", fraction: true, get: (reading) => middle(reading.summary.earth_visible_area_fraction) },
];

/** Everything a scorecard row can read for one site. */
type RowData = { period: PeriodSummary | null; context: SiteContext | null; insight: SiteInsight | null };

type ScoreRow = {
  label: string;
  /** Which value is better; "none" for facts that are neither good nor bad on their own. */
  better: "higher" | "lower" | "none";
  /** Whether the value comes from the simulation (and so waits for the run). */
  needsRun: boolean;
  number: (data: RowData) => number | null;
  text: (data: RowData) => string;
};

const hours = (bounds: Bounds | null | undefined) => bound(bounds, decimal, " h");
const percent = (value: number | null | undefined) => value === null || value === undefined ? "—" : wholePercent.format(value);

const run = (label: string, better: ScoreRow["better"], number: (p: PeriodSummary) => number | null, text: (p: PeriodSummary) => string): ScoreRow => ({
  label, better, needsRun: true,
  number: (data) => data.period ? number(data.period) : null,
  text: (data) => data.period ? text(data.period) : "—",
});

const fact = (label: string, better: ScoreRow["better"], value: (data: RowData) => number | null): ScoreRow => ({
  label, better, needsRun: false, number: value, text: (data) => percent(value(data)),
});

const scoreGroups: { title: string; note: string; rows: ScoreRow[] }[] = [
  {
    title: "Power",
    note: "For the selected dates",
    rows: [
      run("Solar energy on receiver", "higher", (p) => middle(p.incident_energy_kwh_m2), (p) => bound(p.incident_energy_kwh_m2, energy, " kWh/m²")),
      run("Sunlit time · any Sun", "higher", (p) => middle(p.sunlit_hours), (p) => hours(p.sunlit_hours)),
      run("Sunlit time · at least half the Sun", "higher", (p) => middle(p.half_disk_sunlit_hours), (p) => hours(p.half_disk_sunlit_hours)),
      run("Longest day · continuous sunlight", "higher", (p) => p.longest_daylight?.hours ?? 0, (p) => longestLabel(p.longest_daylight)),
      run("Longest darkness at centre", "lower", (p) => p.longest_darkness?.hours ?? 0, (p) => longestLabel(p.longest_darkness)),
    ],
  },
  {
    title: "Communication",
    note: "For the selected dates",
    rows: [
      run("Earth visible at mast", "higher", (p) => middle(p.earth_visible_hours), (p) => hours(p.earth_visible_hours)),
      run("Longest Earth contact", "higher", (p) => p.longest_earth_contact?.hours ?? 0, (p) => longestLabel(p.longest_earth_contact)),
      run("Longest Earth blackout", "lower", (p) => p.longest_earth_blackout?.hours ?? 0, (p) => longestLabel(p.longest_earth_blackout)),
    ],
  },
  {
    title: "Long-term and terrain",
    note: "NASA maps averaged over 18.6 years, over the whole site",
    rows: [
      fact("Average sunlight", "higher", (d) => d.context?.summary.average_sunlight ?? null),
      fact("Average Earth visibility", "higher", (d) => d.context?.summary.average_earth ?? null),
      fact("Permanent shadow (cold traps)", "none", (d) => d.context?.summary.permanent_shadow_share ?? null),
      fact("Open sky", "higher", (d) => d.context?.summary.sky_openness ?? null),
      fact("Ground at or below 10°", "higher", (d) => d.insight?.summary.gentle_area_fractions["10"] ?? null),
      {
        label: "Mean slope", better: "lower", needsRun: false,
        number: (d) => d.insight?.summary.slope_mean_deg ?? null,
        text: (d) => d.insight?.summary.slope_mean_deg == null ? "—" : `${decimal.format(d.insight.summary.slope_mean_deg)}°`,
      },
    ],
  },
];

/** The better site for a row, or null when the values are missing or within 2% of each other. */
function winner(row: ScoreRow, a: RowData, b: RowData): Slot | null {
  if (row.better === "none") return null;
  const first = row.number(a);
  const second = row.number(b);
  if (first === null || second === null) return null;
  const spread = Math.abs(first - second);
  if (spread <= 0.02 * Math.max(Math.abs(first), Math.abs(second)) || spread < 0.05) return null;
  const firstWins = row.better === "higher" ? first > second : first < second;
  return firstWins ? "a" : "b";
}

function seriesFor(slot: Slot, readings: Reading[], measure: Measure): LineSeries {
  return {
    slot,
    points: readings.flatMap((reading) => {
      const value = measure.get(reading);
      return value === null ? [] : [{ time: Date.parse(reading.at_utc), value }];
    }),
  };
}


/** A time chart of one measure for both sites, with a dropdown for which measure. */
function MeasureChart({ title, measures, panes, start, end, at, gapMs }: {
  title: string; measures: Measure[]; panes: Record<Slot, SummaryPane>; start: number; end: number; at: Date; gapMs: number;
}) {
  const [measureId, setMeasureId] = useState(measures[0].id);
  const measure = measures.find((item) => item.id === measureId) ?? measures[0];
  const names = Object.fromEntries(slots.flatMap((slot) => panes[slot].site ? [[slot, panes[slot].site!.name]] : [])) as Partial<Record<Slot, string>>;
  const lines = slots.map((slot) => seriesFor(slot, panes[slot].series, measure));
  const peak = Math.max(0, ...lines.flatMap((line) => line.points.map((point) => point.value)));
  const hasData = lines.some((line) => line.points.length > 0);
  const formatValue = (value: number) => measure.fraction ? ratio.format(value) : `${decimal.format(value)}${measure.unit ?? ""}`;
  return <section className="summary-card">
    <header>
      <h3>{title}</h3>
      <label className="measure-select"><span>Show</span>
        <select value={measure.id} onChange={(event) => setMeasureId(event.target.value)} aria-label={`${title}: what to show`}>
          {measures.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
    </header>
    <Legend names={names} />
    {hasData ? <LineChart series={lines} start={start} end={end} playhead={at.valueOf()} gapMs={gapMs}
      yMax={measure.fraction ? 1 : niceMax(Math.max(1, peak))} formatValue={formatValue}
      formatAxis={(value) => measure.fraction ? wholePercent.format(value) : decimal.format(value)} />
      : <p className="result-note">Run both sites to see how they change over time.</p>}
  </section>;
}

export function CompareSummary({ panes, range, at }: { panes: Record<Slot, SummaryPane>; range: TimeRange; at: Date }) {
  const start = Date.parse(range.start_utc);
  const end = Date.parse(range.end_utc);
  const periods: Record<Slot, PeriodSummary | null> = { a: panes.a.run?.period ?? null, b: panes.b.run?.period ?? null };
  const names = Object.fromEntries(slots.flatMap((slot) => panes[slot].site ? [[slot, panes[slot].site!.name]] : [])) as Partial<Record<Slot, string>>;

  if (!panes.a.site || !panes.b.site) {
    return <div className="compare-summary"><p className="sidebar-note">Choose two sites in the left panel to compare them over the whole period.</p></div>;
  }

  const data: Record<Slot, RowData> = {
    a: { period: periods.a, context: panes.a.context, insight: panes.a.insight },
    b: { period: periods.b, context: panes.b.context, insight: panes.b.insight },
  };
  const stripRows: StripRow[] = slots.flatMap((slot) => [
    { slot, kind: "Sun" as const, windows: periods[slot]?.sun_windows ?? null },
    { slot, kind: "Earth" as const, windows: periods[slot]?.earth_windows ?? null },
  ]);

  const dayLabels = new Map<string, BarGroup>();
  for (const slot of slots) {
    for (const day of periods[slot]?.days ?? []) {
      const value = middle(day.incident_energy_kwh_m2);
      if (value === null) continue;
      const group = dayLabels.get(day.date_utc) ?? { label: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(day.date_utc)), values: {} };
      group.values[slot] = value;
      dayLabels.set(day.date_utc, group);
    }
  }
  const days = [...dayLabels.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([, group]) => group);

  return <div className="compare-summary">
    <section className="summary-card">
      <header><h3>Scorecard</h3><p>▲ marks the better site for each row</p></header>
      <table className="scorecard">
        <thead><tr>
          <th scope="col">Metric</th>
          {slots.map((slot) => <th key={slot} scope="col"><span className="site-chip small" style={{ background: slotColor[slot] }}>{slotLabel[slot]}</span>{panes[slot].site!.name}</th>)}
        </tr></thead>
        {scoreGroups.map((group) => <tbody key={group.title}>
          <tr className="group-row"><th colSpan={3} scope="colgroup">{group.title}<small>{group.note}</small></th></tr>
          {group.rows.map((row) => {
            const best = winner(row, data.a, data.b);
            return <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {slots.map((slot) => <td key={slot} className={best === slot ? "best" : ""}>
                {row.needsRun && !periods[slot] ? <span className="pending">{panes[slot].run ? "Running…" : "—"}</span>
                  : <>{row.text(data[slot])}{best === slot && <span className="winner" title="Better for this metric" aria-label="better">▲</span>}</>}
              </td>)}
            </tr>;
          })}
        </tbody>)}
      </table>
      <p className="result-note">“≥” means the state lasts past the end of the period, so a longer date range may show more. Values show a range when terrain coverage is incomplete. Long-term numbers are NASA's 18.6-year averages: they describe the place, not the dates.</p>
    </section>

    <MeasureChart title="Sun over time" measures={sunMeasures} panes={panes} start={start} end={end} at={at} gapMs={range.snapshot_minutes * 90_000} />
    <MeasureChart title="Earth over time" measures={earthMeasures} panes={panes} start={start} end={end} at={at} gapMs={range.snapshot_minutes * 90_000} />

    <section className="summary-card">
      <header><h3>Sun and Earth at the site centre</h3><p>Exact windows, available when each run completes</p></header>
      <WindowStrips rows={stripRows} start={start} end={end} playhead={at.valueOf()} />
      <ul className="chart-key states">
        <li><i className="swatch clear" />Visible</li><li><i className="swatch blocked" />Hidden or blocked</li><li><i className="swatch unknown" />Unresolved</li>
      </ul>
    </section>

    {days.length > 1 && <section className="summary-card">
      <header><h3>Daily solar energy</h3><p>kWh/m² per UTC day on the chosen receiver</p></header>
      <Legend names={names} />
      <PairedBars groups={days} formatValue={(value) => decimal.format(value)} />
    </section>}
  </div>;
}
