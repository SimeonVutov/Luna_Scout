import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { TimeRange } from "../../api/types";
import { Icon } from "../../Icon";
import { clockLabel, dateLabel, finalDay, rangeForDates, snapshotAt, snapshotCount, todayRange } from "./time";

/** Snapshots already computed for one site, drawn as dots under the slider. */
export type ReadyTrack = { id: string; label?: string; color: string; ready: number[] };

export function Timeline({ range, index, onIndex, onRange, tracks }: {
  range: TimeRange;
  index: number;
  onIndex: (index: number) => void;
  onRange: (range: TimeRange) => void;
  tracks?: ReadyTrack[];
}) {
  const count = snapshotCount(range);
  const instant = snapshotAt(range, index);
  const [playing, setPlaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(range.start_utc.slice(0, 10));
  const [last, setLast] = useState(finalDay(range));
  const [error, setError] = useState<string | null>(null);
  const ticks = Array.from({ length: Math.min(count, 7) }, (_, position) => position);
  const lastSnapshot = snapshotAt(range, count - 1);
  const singleDay = range.start_utc.slice(0, 10) === finalDay(range);

  useEffect(() => {
    if (!playing) return;
    if (index >= count - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => onIndex(index + 1), 500);
    return () => window.clearTimeout(timer);
  }, [count, index, onIndex, playing]);

  function apply(next: TimeRange) {
    setPlaying(false);
    setEditing(false);
    setError(null);
    onRange(next);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      apply(rangeForDates(first, last));
    } catch (failure) {
      if (failure instanceof Error) setError(failure.message);
    }
  }

  return (
    <section className="timeline" aria-label="Shared timeline">
      <div className="timeline-head">
        <div className="timeline-title">
          <h2>Timeline</h2>
          <span className="timezone">UTC</span>
          {tracks && tracks.map((track) => <span key={track.id} className="timeline-ready" style={{ color: track.color }}>
            {track.label ? `${track.label} · ` : ""}{track.ready.length}/{count} ready
          </span>)}
        </div>
        <time dateTime={instant.toISOString()}>{dateLabel(instant)} · {clockLabel(instant)}</time>
        <button className="button secondary date-trigger" type="button" aria-expanded={editing} onClick={() => {
          setFirst(range.start_utc.slice(0, 10));
          setLast(finalDay(range));
          setError(null);
          setEditing(!editing);
        }}><Icon name="calendar" size={16} /> {singleDay ? dateLabel(snapshotAt(range, 0)) : `${dateLabel(snapshotAt(range, 0))} – ${dateLabel(lastSnapshot)}`} <Icon name="chevron" size={15} /></button>
      </div>
      {editing && <form className="range-form" onSubmit={submit} onKeyDown={(event) => {
        if (event.key === "Escape") setEditing(false);
      }}>
        <label>From (UTC)<input type="date" required value={first} onChange={(event) => setFirst(event.target.value)} /></label>
        <label>Through (UTC)<input type="date" required min={first} value={last} onChange={(event) => setLast(event.target.value)} /></label>
        {error && <p role="alert">{error}</p>}
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={() => apply(todayRange())}>Today</button>
          <button className="button primary" type="submit">Apply</button>
        </div>
      </form>}
      <div className="playback">
        <div className="transport">
          <button type="button" title="Previous hour" aria-label="Previous hour" disabled={index === 0} onClick={() => { setPlaying(false); onIndex(index - 1); }}><Icon name="previous" size={17} /></button>
          <button type="button" className="play-button" title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"} disabled={count <= 1} onClick={() => {
            if (!playing && index === count - 1) onIndex(0);
            setPlaying(!playing);
          }}><Icon name={playing ? "pause" : "play"} size={19} /></button>
          <button type="button" title="Next hour" aria-label="Next hour" disabled={index >= count - 1} onClick={() => { setPlaying(false); onIndex(index + 1); }}><Icon name="next" size={17} /></button>
        </div>
        <div className="track">
          <input type="range" aria-label="Timeline position" aria-valuetext={`${dateLabel(instant)} ${clockLabel(instant)} UTC`} min={0} max={count - 1} value={index} onChange={(event) => { setPlaying(false); onIndex(Number(event.target.value)); }} />
          {tracks && tracks.map((track) => <div key={track.id} className="ready-track" aria-hidden="true" style={{ color: track.color }}>
            {track.ready.map((position) => <i key={position} style={{ left: `${100 * position / Math.max(1, count - 1)}%` }} />)}
          </div>)}
          <div className="ticks" aria-hidden="true">
            {ticks.map((tick) => {
              const value = snapshotAt(range, Math.round(tick * (count - 1) / Math.max(1, ticks.length - 1)));
              return <span key={tick}>{singleDay ? clockLabel(value) : value.toISOString().slice(5, 10)}</span>;
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
