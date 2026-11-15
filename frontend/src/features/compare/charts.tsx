import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { Visibility, VisibilityWindow } from "../../api/types";
import { slotColor, slotLabel } from "./slots";
import type { Slot } from "./slots";
import "./charts.css";

const shortDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23" });
const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

function timeLabel(time: number) {
  const date = new Date(time);
  return `${shortDay.format(date)} ${clock.format(date)}`;
}

function SlotChip({ slot }: { slot: Slot }) {
  return <span className="site-chip small" style={{ background: slotColor[slot] }}>{slotLabel[slot]}</span>;
}

export function Legend({ names }: { names: Partial<Record<Slot, string>> }) {
  return <ul className="chart-key">
    {(Object.keys(names) as Slot[]).map((slot) => <li key={slot}><SlotChip slot={slot} />{names[slot]}</li>)}
  </ul>;
}

/** Axis ticks at readable UTC boundaries: every 6 h for short ranges, else about eight days. */
function timeTicks(start: number, end: number) {
  const span = end - start;
  const step = span <= 36 * hourMs ? 6 * hourMs : Math.max(1, Math.ceil(span / dayMs / 8)) * dayMs;
  const ticks: number[] = [];
  for (let tick = Math.ceil(start / step) * step; tick <= end; tick += step) ticks.push(tick);
  return { ticks, short: step < dayMs };
}

function tickLabel(time: number, short: boolean) {
  const date = new Date(time);
  return short ? clock.format(date) : shortDay.format(date);
}

function Tooltip({ left, children }: { left: number; children: ReactNode }) {
  return <div className="chart-tooltip" style={{ left: `${left}%`, transform: left > 60 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>{children}</div>;
}

export type LineSeries = { slot: Slot; points: { time: number; value: number }[] };

const lineBox = { width: 900, height: 230, left: 48, right: 26, top: 12, bottom: 26 };

/** One measure over time for both sites, with the timeline playhead and a crosshair tooltip. */
export function LineChart({ series, start, end, playhead, yMax, formatValue, formatAxis, gapMs }: {
  series: LineSeries[];
  start: number;
  end: number;
  playhead: number;
  yMax: number;
  formatValue: (value: number) => string;
  formatAxis: (value: number) => string;
  gapMs: number;
}) {
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const plotWidth = lineBox.width - lineBox.left - lineBox.right;
  const plotHeight = lineBox.height - lineBox.top - lineBox.bottom;
  const x = (time: number) => lineBox.left + plotWidth * (time - start) / Math.max(1, end - start);
  const y = (value: number) => lineBox.top + plotHeight * (1 - Math.min(value, yMax) / yMax);
  const { ticks, short } = timeTicks(start, end);

  function move(event: MouseEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = Math.min(lineBox.width - lineBox.right, Math.max(lineBox.left, (event.clientX - box.left) / box.width * lineBox.width));
    setHover({ x: px, time: start + (px - lineBox.left) / plotWidth * (end - start) });
  }

  const nearest = (points: LineSeries["points"], time: number) =>
    points.reduce<LineSeries["points"][number] | null>((best, point) => !best || Math.abs(point.time - time) < Math.abs(best.time - time) ? point : best, null);

  const lastY = series.map((item) => item.points.length ? y(item.points[item.points.length - 1].value) : null);

  return <div className="chart">
    <svg viewBox={`0 0 ${lineBox.width} ${lineBox.height}`} role="img" aria-label="Comparison over time">
      {[0, 1, 2, 3, 4].map((step) => {
        const value = yMax * step / 4;
        return <g key={step}>
          <line className="grid-line" x1={lineBox.left} x2={lineBox.width - lineBox.right} y1={y(value)} y2={y(value)} />
          <text className="axis-text" x={lineBox.left - 8} y={y(value) + 3} textAnchor="end">{formatAxis(value)}</text>
        </g>;
      })}
      {ticks.map((tick) => <text key={tick} className="axis-text" x={x(tick)} y={lineBox.height - 8} textAnchor="middle">{tickLabel(tick, short)}</text>)}
      <line className="playhead-line" x1={x(playhead)} x2={x(playhead)} y1={lineBox.top} y2={lineBox.height - lineBox.bottom} />
      {series.map((item) => {
        let path = "";
        let previous = -Infinity;
        for (const point of item.points) {
          path += `${point.time - previous > gapMs ? "M" : "L"}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)} `;
          previous = point.time;
        }
        return <path key={item.slot} d={path} fill="none" stroke={slotColor[item.slot]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />;
      })}
      {series.map((item, index) => lastY[index] !== null && <text key={item.slot} className="end-label" fill={slotColor[item.slot]}
        x={lineBox.width - lineBox.right + 6} y={(lastY[index] as number) + (index > 0 && Math.abs((lastY[index] as number) - (lastY[0] ?? 0)) < 12 ? 12 : 3)}>{slotLabel[item.slot]}</text>)}
      {hover && <line className="crosshair" x1={hover.x} x2={hover.x} y1={lineBox.top} y2={lineBox.height - lineBox.bottom} />}
      {hover && series.map((item) => {
        const point = nearest(item.points, hover.time);
        return point && Math.abs(point.time - hover.time) <= gapMs
          ? <circle key={item.slot} cx={x(point.time)} cy={y(point.value)} r="4.5" fill={slotColor[item.slot]} stroke="var(--surface)" strokeWidth="2" /> : null;
      })}
      <rect x={lineBox.left} y={lineBox.top} width={plotWidth} height={plotHeight} fill="transparent" onMouseMove={move} onMouseLeave={() => setHover(null)} />
    </svg>
    {hover && <Tooltip left={hover.x / lineBox.width * 100}>
      <strong>{timeLabel(hover.time)} UTC</strong>
      {series.map((item) => {
        const point = nearest(item.points, hover.time);
        return <span key={item.slot}><SlotChip slot={item.slot} />{point && Math.abs(point.time - hover.time) <= gapMs ? formatValue(point.value) : "not ready"}</span>;
      })}
    </Tooltip>}
  </div>;
}

export type StripRow = { slot: Slot; kind: "Sun" | "Earth"; windows: VisibilityWindow[] | null };

const stateText: Record<"Sun" | "Earth", Record<Visibility, string>> = {
  Sun: { clear: "Visible", blocked: "Hidden", unknown: "Unresolved" },
  Earth: { clear: "Visible", blocked: "Blocked", unknown: "Unresolved" },
};

/** Exact visibility windows at the site centre, one strip per site and body. */
export function WindowStrips({ rows, start, end, playhead }: { rows: StripRow[]; start: number; end: number; playhead: number }) {
  const [hover, setHover] = useState<{ row: number; window: VisibilityWindow; left: number } | null>(null);
  const percent = (time: number) => 100 * (time - start) / Math.max(1, end - start);
  const { ticks, short } = timeTicks(start, end);

  return <div className="chart strips">
    {rows.map((row, index) => <div key={`${row.slot}-${row.kind}`} className="strip-row">
      <span className="strip-label"><SlotChip slot={row.slot} />{row.kind}</span>
      <div className="strip-track">
        {row.windows === null && <span className="strip-pending">Available when the run completes</span>}
        {row.windows?.map((window) => {
          const from = percent(Date.parse(window.start_utc));
          const to = percent(Date.parse(window.end_utc));
          return <i key={window.start_utc} className={`strip-segment ${window.visibility}`}
            style={{ left: `${from}%`, width: `calc(${to - from}% - 2px)`, ...(window.visibility === "clear" ? { background: slotColor[row.slot] } : {}) }}
            onMouseEnter={() => setHover({ row: index, window, left: (from + to) / 2 })} onMouseLeave={() => setHover(null)} />;
        })}
      </div>
    </div>)}
    <div className="strip-axis">
      <span className="strip-label" />
      <div className="strip-track axis">
        {ticks.map((tick) => <span key={tick} style={{ left: `${percent(tick)}%` }}>{tickLabel(tick, short)}</span>)}
      </div>
    </div>
    <i className="strip-playhead" style={{ left: `calc(var(--lead) + (100% - var(--lead)) * ${percent(playhead) / 100})` }} />
    {hover && <div className="chart-tooltip strip-tooltip" style={{ left: `calc(var(--lead) + (100% - var(--lead)) * ${hover.left / 100})`, top: `${hover.row * 28}px` }}>
      <strong>{slotLabel[rows[hover.row].slot]} · {rows[hover.row].kind}: {stateText[rows[hover.row].kind][hover.window.visibility]}</strong>
      <span>{timeLabel(Date.parse(hover.window.start_utc))} – {timeLabel(Date.parse(hover.window.end_utc))}</span>
    </div>}
  </div>;
}

export type BarGroup = { label: string; values: Partial<Record<Slot, number>> };

const barBox = { width: 900, height: 220, left: 48, right: 10, top: 12, bottom: 26 };

/** Two bars per day, one per site, anchored to a shared baseline. */
export function PairedBars({ groups, formatValue }: { groups: BarGroup[]; formatValue: (value: number) => string }) {
  const [hover, setHover] = useState<{ group: number; slot: Slot } | null>(null);
  const plotWidth = barBox.width - barBox.left - barBox.right;
  const plotHeight = barBox.height - barBox.top - barBox.bottom;
  const peak = Math.max(1e-9, ...groups.flatMap((group) => Object.values(group.values)));
  const yMax = niceMax(peak);
  const slotWidth = plotWidth / groups.length;
  const barWidth = Math.max(2, Math.min(18, slotWidth / 2 - 3));
  const labelEvery = Math.ceil(groups.length / 10);
  const y = (value: number) => barBox.top + plotHeight * (1 - value / yMax);

  return <div className="chart">
    <svg viewBox={`0 0 ${barBox.width} ${barBox.height}`} role="img" aria-label="Daily comparison">
      {[0, 1, 2, 3, 4].map((step) => <g key={step}>
        <line className="grid-line" x1={barBox.left} x2={barBox.width - barBox.right} y1={y(yMax * step / 4)} y2={y(yMax * step / 4)} />
        <text className="axis-text" x={barBox.left - 8} y={y(yMax * step / 4) + 3} textAnchor="end">{formatValue(yMax * step / 4)}</text>
      </g>)}
      {groups.map((group, index) => {
        const centre = barBox.left + slotWidth * (index + 0.5);
        return <g key={group.label}>
          {(["a", "b"] as Slot[]).map((slot, position) => {
            const value = group.values[slot];
            if (value === undefined) return null;
            const left = centre + (position === 0 ? -barWidth - 1 : 1);
            const height = Math.max(1, plotHeight * value / yMax);
            const radius = Math.min(4, barWidth / 2, height);
            const top = barBox.top + plotHeight - height;
            return <path key={slot} fill={slotColor[slot]} opacity={hover && (hover.group !== index || hover.slot !== slot) ? .55 : 1}
              d={`M${left},${barBox.top + plotHeight} V${top + radius} Q${left},${top} ${left + radius},${top} H${left + barWidth - radius} Q${left + barWidth},${top} ${left + barWidth},${top + radius} V${barBox.top + plotHeight} Z`}
              onMouseEnter={() => setHover({ group: index, slot })} onMouseLeave={() => setHover(null)} />;
          })}
          {index % labelEvery === 0 && <text className="axis-text" x={centre} y={barBox.height - 8} textAnchor="middle">{group.label}</text>}
          <rect x={centre - slotWidth / 2} y={barBox.top} width={slotWidth} height={plotHeight} fill="transparent"
            onMouseEnter={() => setHover({ group: index, slot: hover?.slot ?? "a" })} onMouseLeave={() => setHover(null)} />
        </g>;
      })}
    </svg>
    {hover && <Tooltip left={(barBox.left + slotWidth * (hover.group + 0.5)) / barBox.width * 100}>
      <strong>{groups[hover.group].label}</strong>
      {(["a", "b"] as Slot[]).map((slot) => groups[hover.group].values[slot] !== undefined
        ? <span key={slot}><SlotChip slot={slot} />{formatValue(groups[hover.group].values[slot]!)}</span> : null)}
    </Tooltip>}
  </div>;
}

export function niceMax(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 1.5, 2, 2.5, 3, 4, 5, 8, 10]) if (factor * magnitude >= value) return factor * magnitude;
  return 10 * magnitude;
}
