import { useState } from "react";
import type { Bounds, PeriodSummary, Reading, RunStatus, Site, TimeRange } from "../../api/types";
import { bound, decimal, energy, longestLabel, middle, ratio, wholePercent } from "../results/format";
import { Legend, LineChart, PairedBars, WindowStrips, niceMax } from "./charts";
import type { BarGroup, LineSeries, StripRow } from "./charts";
import { slotColor, slotLabel, slots } from "./slots";
import type { Slot } from "./slots";

type SummaryPane = { site: Site | null; run: RunStatus | null; series: Reading[] };

type Measure = {
  id: string;
  label: string;
  fraction: boolean;
  get: (reading: Reading) => number | null;
};

const measures: Measure[] = [
  { id: "lit", label: "Lit area · any Sun", fraction: true, get: (reading) => middle(reading.summary.lit_area_fraction) },
  { id: "half", label: "Lit area · ≥ half the Sun", fraction: true, get: (reading) => middle(reading.summary.half_disk_lit_area_fraction) },
  { id: "power", label: "Irradiance on receiver", fraction: false, get: (reading) => middle(reading.summary.mean_irradiance_on_known_ground_w_m2) },
  { id: "disk", label: "Earth disk visible", fraction: true, get: (reading) => middle(reading.earth_disk_visible_fraction) },
];

type ScoreRow = {
  label: string;
  better: "higher" | "lower";
  number: (period: PeriodSummary) => number | null;
  text: (period: PeriodSummary) => string;
};

const hours = (bounds: Bounds | null | undefined) => bound(bounds, decimal, " h");

const scoreRows: ScoreRow[] = [
  { label: "Solar energy on receiver", better: "higher", number: (p) => middle(p.incident_energy_kwh_m2), text: (p) => bound(p.incident_energy_kwh_m2, energy, " kWh/m²") },
  { label: "Sunlit time · any Sun", better: "higher", number: (p) => middle(p.sunlit_hours), text: (p) => hours(p.sunlit_hours) },
  { label: "Sunlit time · ≥ half the Sun", better: "higher", number: (p) => middle(p.half_disk_sunlit_hours), text: (p) => hours(p.half_disk_sunlit_hours) },
  { label: "Earth visible at mast", better: "higher", number: (p) => middle(p.earth_visible_hours), text: (p) => hours(p.earth_visible_hours) },
  { label: "Longest darkness at centre", better: "lower", number: (p) => p.longest_darkness?.hours ?? 0, text: (p) => longestLabel(p.longest_darkness) },
  { label: "Longest Earth blackout", better: "lower", number: (p) => p.longest_earth_blackout?.hours ?? 0, text: (p) => longestLabel(p.longest_earth_blackout) },
];

/** The better site for a row, or null when the values are missing or within 2% of each other. */
function winner(row: ScoreRow, a: PeriodSummary | null, b: PeriodSummary | null): Slot | null {
  const first = a ? row.number(a) : null;
  const second = b ? row.number(b) : null;
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

export function CompareSummary({ panes, range, at }: { panes: Record<Slot, SummaryPane>; range: TimeRange; at: Date }) {
  const [measureId, setMeasureId] = useState("lit");
  const measure = measures.find((item) => item.id === measureId) ?? measures[0];
  const start = Date.parse(range.start_utc);
  const end = Date.parse(range.end_utc);
  const periods: Record<Slot, PeriodSummary | null> = { a: panes.a.run?.period ?? null, b: panes.b.run?.period ?? null };
  const names = Object.fromEntries(slots.flatMap((slot) => panes[slot].site ? [[slot, panes[slot].site!.name]] : [])) as Partial<Record<Slot, string>>;

  if (!panes.a.site || !panes.b.site) {
    return <div className="compare-summary"><p className="sidebar-note">Choose two sites in the left panel to compare them over the whole period.</p></div>;
  }

  const lines = slots.map((slot) => seriesFor(slot, panes[slot].series, measure));
  const peak = Math.max(0, ...lines.flatMap((line) => line.points.map((point) => point.value)));
  const formatValue = (value: number) => measure.fraction ? ratio.format(value) : `${decimal.format(value)} W/m²`;
  const hasData = lines.some((line) => line.points.length > 0);

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
      <header><h3>Scorecard</h3><p>Whole selected period · ▲ marks the better site for each row</p></header>
      <table className="scorecard">
        <thead><tr>
          <th scope="col">Metric</th>
          {slots.map((slot) => <th key={slot} scope="col"><span className="site-chip small" style={{ background: slotColor[slot] }}>{slotLabel[slot]}</span>{panes[slot].site!.name}</th>)}
        </tr></thead>
        <tbody>
          {scoreRows.map((row) => {
            const best = winner(row, periods.a, periods.b);
            return <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {slots.map((slot) => <td key={slot} className={best === slot ? "best" : ""}>
                {periods[slot] ? <>{row.text(periods[slot]!)}{best === slot && <span className="winner" title="Better for this metric" aria-label="better">▲</span>}</> : <span className="pending">{panes[slot].run ? "Running…" : "—"}</span>}
              </td>)}
            </tr>;
          })}
        </tbody>
      </table>
      <p className="result-note">“≥” means the state lasts past the end of the period. Values show a range when terrain coverage is incomplete.</p>
    </section>

    <section className="summary-card">
      <header>
        <h3>Over time</h3>
        <div className="segmented compact" role="radiogroup" aria-label="Measure">
          {measures.map((item) => <button key={item.id} type="button" role="radio" aria-checked={item.id === measure.id}
            className={item.id === measure.id ? "selected" : ""} onClick={() => setMeasureId(item.id)}>{item.label}</button>)}
        </div>
      </header>
      <Legend names={names} />
      {hasData ? <LineChart series={lines} start={start} end={end} playhead={at.valueOf()} gapMs={range.snapshot_minutes * 90_000}
        yMax={measure.fraction ? 1 : niceMax(Math.max(1, peak))} formatValue={formatValue}
        formatAxis={(value) => measure.fraction ? wholePercent.format(value) : decimal.format(value)} />
        : <p className="result-note">Run both sites to see how they change over time.</p>}
    </section>

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
