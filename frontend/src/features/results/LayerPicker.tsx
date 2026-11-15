import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../Icon";
import { allLayers, layerLabel } from "./mapLayers";
import type { LayerAvailability, MapLayer } from "./mapLayers";
import "./layers.css";

/**
 * A plain list of the layers that can be drawn on the ground. Layers that are not available yet
 * stay in the list, greyed out, with the reason underneath.
 */
export function LayerPicker({ value, onChange, unavailable }: {
  value: MapLayer;
  onChange: (layer: MapLayer) => void;
  unavailable: LayerAvailability;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function choose(layer: MapLayer) {
    if (unavailable[layer]) return;
    onChange(layer);
    setOpen(false);
  }

  return <div className="layer-picker" ref={root} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className="layer-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
      <span className="layer-caption">Layer</span>
      <strong>{layerLabel[value]}</strong>
      <Icon name="chevron" size={16} />
    </button>
    {open && <ul className="layer-list" id={listId} role="listbox" aria-label="Map layer">
      {allLayers.map((layer) => {
        const reason = unavailable[layer];
        return <li key={layer} role="option" aria-selected={layer === value} aria-disabled={reason ? true : undefined}
          className={layer === value ? "selected" : reason ? "unavailable" : undefined}
          tabIndex={reason ? -1 : 0} onClick={() => choose(layer)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(layer); } }}>
          <span>{layerLabel[layer]}</span>
          {reason && <small>{reason}</small>}
        </li>;
      })}
    </ul>}
  </div>;
}
