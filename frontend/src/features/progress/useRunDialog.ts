import { useEffect, useState } from "react";
import type { Site } from "../../api/types";
import type { CardEntry } from "./RunCard";

/** After every tracked simulation finished while hidden, the pill says so this long, then goes. */
const READY_PILL_MS = 6000;

/**
 * Which sites' simulations the progress dialog follows, and whether it is open or hidden.
 * `entryFor` gives a site's current run; the dialog stops following sites once all are done.
 */
export function useRunDialog(sites: Site[], entryFor: (site: Site) => CardEntry) {
  const [tracked, setTracked] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const entries = tracked.flatMap((id) => {
    const site = sites.find((candidate) => candidate.id === id);
    return site ? [entryFor(site)] : [];
  });
  const allReady = entries.length > 0 && entries.every((entry) => entry.run?.stage === "complete");
  const allStopped = entries.length > 0 && entries.every((entry) => entry.run === null);

  useEffect(() => {
    if (!tracked.length) return;
    // Every simulation was cancelled: there is nothing left to follow.
    if (allStopped) { setTracked([]); setOpen(false); return; }
    if (open || !allReady) return;

    const timer = window.setTimeout(() => setTracked([]), READY_PILL_MS);
    return () => window.clearTimeout(timer);
  }, [tracked.length, open, allReady, allStopped]);

  return {
    entries,
    open: open && entries.length > 0,
    hidden: !open && entries.length > 0,
    /** Follow these sites and show the dialog. */
    show(next: Site[]) {
      setTracked(next.map((site) => site.id));
      setOpen(true);
    },
    reopen() { setOpen(true); },
    hide() {
      setOpen(false);
      // Hiding finished results needs no reminder.
      if (allReady) setTracked([]);
    },
  };
}
