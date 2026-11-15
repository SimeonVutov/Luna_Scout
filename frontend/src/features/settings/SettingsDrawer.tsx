import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { RayMethod, Receiver, SimulationOptions } from "../../api/types";
import { Icon } from "../../Icon";
import "./settings.css";

const receivers: { value: Receiver; label: string; note: string }[] = [
  { value: "vertical_tracking", label: "Vertical panel", note: "Turns to face the Sun, like polar lander arrays." },
  { value: "terrain", label: "Ground surface", note: "The local terrain slope. Useful for ground and thermal questions." },
  { value: "horizontal", label: "Flat plate", note: "A level plate. At a 1–2° Sun it collects very little." },
];

const methods: { value: RayMethod; label: string; note: string }[] = [
  { value: "horizon", label: "Fast", note: "Cached terrain horizons with exact re-tracing near the skyline." },
  { value: "direct", label: "Reference", note: "Traces every solar-disk ray. Slower, same results." },
];

function Choice<T extends string>({ name, value, options, onChange }: {
  name: string;
  value: T;
  options: { value: T; label: string; note: string }[];
  onChange: (value: T) => void;
}) {
  const current = options.find((option) => option.value === value);
  return <div className="choice">
    <div className="segmented" role="radiogroup" aria-label={name}>
      {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
        className={option.value === value ? "selected" : ""} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
    <p className="field-note">{current?.note}</p>
  </div>;
}

export function SettingsDrawer({ options, onApply, onClose }: {
  options: SimulationOptions;
  onApply: (options: SimulationOptions) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(options);
  const first = useRef<HTMLButtonElement>(null);
  const groundReceiver = draft.receiver === "terrain";
  const changed = JSON.stringify(draft) !== JSON.stringify(options);

  useEffect(() => {
    first.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  function number(field: keyof SimulationOptions, value: string) {
    setDraft((current) => ({ ...current, [field]: Number(value) }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onApply(groundReceiver ? { ...draft, collector_height_m: 0 } : draft);
  }

  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="drawer" role="dialog" aria-modal="true" aria-label="Simulation settings">
      <header className="drawer-head">
        <div><h2>Simulation settings</h2><p>Shared by every site, so comparisons stay fair.</p></div>
        <button ref={first} type="button" className="icon-button" aria-label="Close settings" onClick={onClose}><Icon name="close" size={17} /></button>
      </header>

      <form className="drawer-body" onSubmit={submit}>
        <section>
          <h3>Receiver</h3>
          <Choice name="Receiver type" value={draft.receiver} options={receivers} onChange={(receiver) => setDraft({ ...draft, receiver })} />
          <div className="field-grid">
            <label>Panel height (m)
              <input type="number" min="0" step="any" required disabled={groundReceiver}
                value={groundReceiver ? 0 : draft.collector_height_m} onChange={(event) => number("collector_height_m", event.target.value)} />
            </label>
            <label>Antenna mast height (m)
              <input type="number" min="0" step="any" required value={draft.mast_height_m} onChange={(event) => number("mast_height_m", event.target.value)} />
            </label>
          </div>
        </section>

        <section>
          <h3>Sampling</h3>
          <div className="field-grid">
            <label>Grid spacing (m)
              <input type="number" min="0.1" step="any" required value={draft.grid_spacing_m} onChange={(event) => number("grid_spacing_m", event.target.value)} />
            </label>
            <label>Solar disk rays
              <input type="number" min="1" step="1" required value={draft.solar_disk_samples} onChange={(event) => number("solar_disk_samples", event.target.value)} />
            </label>
            <label>Sample every
              <select value={draft.integration_minutes} onChange={(event) => number("integration_minutes", event.target.value)}>
                {[5, 10, 15, 20, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
              </select>
            </label>
          </div>
        </section>

        <section>
          <h3>Method</h3>
          <Choice name="Ray method" value={draft.ray_method} options={methods} onChange={(ray_method) => setDraft({ ...draft, ray_method })} />
        </section>

        <footer className="drawer-foot">
          <p>Changed settings start new runs. Identical ones are reused.</p>
          <div className="form-actions">
            <button type="button" className="button quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="button primary" disabled={!changed}>Apply settings</button>
          </div>
        </footer>
      </form>
    </aside>
  </div>;
}
