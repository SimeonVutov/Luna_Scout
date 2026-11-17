import { useEffect, useRef } from "react";
import type { TimeRange } from "../../api/types";
import { timeLeft } from "../progress/progressModel";
import { rangeLabel } from "./time";
import type { MissingResults } from "./useRangeChange";
import "./extendDialog.css";

type DialogProps = {
  range: TimeRange;
  missing: MissingResults[];
  /** The dates are about to change, so there are previous dates to keep. */
  changesDates: boolean;
  onCompute: () => void;
  onKeepPrevious: () => void;
};

/** Asks before new dates are computed: shows what is missing and how long it should take. */
export function ExtendDialog({ range, missing, changesDates, onCompute, onKeepPrevious }: DialogProps) {
  const compute = useRef<HTMLButtonElement>(null);
  const total = missing.reduce((sum, item) => sum + item.seconds, 0);
  const who = missing.length === 1 ? missing[0].site.name : `${missing.length} sites`;

  useEffect(() => { compute.current?.focus(); }, []);

  useEffect(() => {
    const leave = (event: KeyboardEvent) => { if (event.key === "Escape") onKeepPrevious(); };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [onKeepPrevious]);

  return <div className="extend-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onKeepPrevious(); }}>
    <div className="extend-dialog" role="dialog" aria-modal="true" aria-labelledby="extend-title">
      <h2 id="extend-title">These dates need computing</h2>
      <p>{rangeLabel(range)} is missing results for {who}. Only the missing days are computed, and everything already done is reused.</p>

      <ul className="extend-list">
        {missing.map((item) => <li key={item.site.id}>
          <strong>{item.site.name}</strong>
          <span>{item.days} {item.days === 1 ? "day" : "days"} · {timeLeft(item.seconds)}</span>
        </li>)}
      </ul>
      {missing.length > 1 && <p className="extend-total">{capitalise(timeLeft(total))} in total</p>}

      <div className="extend-actions">
        <button className="button secondary" type="button" onClick={onKeepPrevious}>{changesDates ? "Keep previous dates" : "Not now"}</button>
        <button className="button primary" type="button" ref={compute} onClick={onCompute}>Compute missing dates</button>
      </div>
    </div>
  </div>;
}

function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
