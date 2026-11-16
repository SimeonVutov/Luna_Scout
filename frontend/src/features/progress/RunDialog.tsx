import { useEffect, useRef } from "react";
import type { Site } from "../../api/types";
import { Icon } from "../../Icon";
import { RunCard } from "./RunCard";
import type { CardEntry } from "./RunCard";
import "./progressMotion.css";
import "./runDialog.css";

type DialogProps = {
  entries: CardEntry[];
  onHide: () => void;
  onPause: (site: Site) => void;
  onResume: (site: Site) => void;
  onCancel: (site: Site) => void;
};

/** Results that were already computed show "Ready" this long, then the dialog closes itself. */
const INSTANT_CLOSE_MS = 1400;
/** A dialog whose runs finish within this long of opening was answered from stored results. */
const INSTANT_WINDOW_MS = 3000;

/**
 * The progress of the simulations just started, one card per site. It does not block the page:
 * Hide (or Escape) puts it away while the simulations keep running.
 */
export function RunDialog({ entries, onHide, onPause, onResume, onCancel }: DialogProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const openedAt = useRef(performance.now());
  const allReady = entries.length > 0 && entries.every((entry) => entry.run?.stage === "complete");
  const title = allReady ? "Results ready" : entries.length === 1 ? "Simulation in progress" : "Simulations in progress";

  useEffect(() => { heading.current?.focus(); }, []);

  useEffect(() => {
    const hide = (event: KeyboardEvent) => { if (event.key === "Escape") onHide(); };
    window.addEventListener("keydown", hide);
    return () => window.removeEventListener("keydown", hide);
  }, [onHide]);

  useEffect(() => {
    if (!allReady || performance.now() - openedAt.current > INSTANT_WINDOW_MS) return;
    const timer = window.setTimeout(onHide, INSTANT_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [allReady, onHide]);

  return <div className={allReady ? "run-dialog ready" : "run-dialog"} role="dialog" aria-modal="false" aria-labelledby="run-dialog-title">
    <div className="run-dialog-head">
      <h2 id="run-dialog-title" ref={heading} tabIndex={-1}>{title}</h2>
      <button className="button secondary run-dialog-hide" type="button" onClick={onHide}>
        {allReady ? <>Close <Icon name="close" size={14} /></> : <>Hide <Icon name="chevron" size={15} /></>}
      </button>
    </div>

    <div className="run-dialog-body">
      {entries.map((entry) => <RunCard key={entry.site.id} {...entry}
        onPause={() => onPause(entry.site)} onResume={() => onResume(entry.site)} onCancel={() => onCancel(entry.site)} />)}
    </div>

    {allReady && <div className="run-dialog-foot">
      <button className="button primary" type="button" onClick={onHide}>Show results</button>
    </div>}
  </div>;
}
