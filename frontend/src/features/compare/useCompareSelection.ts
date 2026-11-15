import { useState } from "react";
import type { Site } from "../../api/types";
import type { Slot } from "./slots";

/** Which two saved sites are compared, as slots A and B. */
export function useCompareSelection(sites: Site[]) {
  const [ids, setIds] = useState<Record<Slot, string | null>>({ a: null, b: null });

  const chosen: Record<Slot, Site | null> = {
    a: sites.find((site) => site.id === ids.a) ?? null,
    b: sites.find((site) => site.id === ids.b) ?? null,
  };

  /** Start from what the user was looking at: the selected site as A, any other site as B. */
  function startFrom(selectedId: string | null) {
    const first = ids.a ?? selectedId;
    const second = ids.b ?? sites.find((site) => site.id !== first)?.id ?? null;
    setIds({ a: first, b: second === first ? null : second });
  }

  function assign(slot: Slot, id: string | null) {
    const other: Slot = slot === "a" ? "b" : "a";

    // Picking the other slot's site swaps the two so a site is never compared with itself.
    setIds((current) => id !== null && id === current[other]
      ? { ...current, [slot]: id, [other]: current[slot] }
      : { ...current, [slot]: id });
  }

  function swap() {
    setIds((current) => ({ a: current.b, b: current.a }));
  }

  return { chosen, startFrom, assign, swap };
}
