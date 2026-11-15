import { useState } from "react";
import type { FormEvent } from "react";
import type { Site, SiteSpec } from "../../api/types";
import { Icon } from "../../Icon";
import { coordinatesLabel, maximumSiteRadius, referenceSites } from "./referenceSites";

function SiteForm({ site, onChange, onSave, onCancel, busy }: {
  site: SiteSpec;
  onChange: (next: SiteSpec) => void;
  onSave: (site: SiteSpec) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave({ ...site, name: site.name.trim() || "New site" });
  }

  return <form className="site-form" onSubmit={submit} onKeyDown={(event) => {
    if (event.key === "Escape" && !busy) onCancel();
  }}>
    <label>Site name
      <input value={site.name} maxLength={80} onChange={(event) => onChange({ ...site, name: event.target.value })} />
    </label>
    <div className="coordinate-inputs">
      <label>Latitude
        <input type="number" min={-90} max={90} step="any" required value={Number.isFinite(site.latitude_deg) ? site.latitude_deg : ""} onChange={(event) => onChange({ ...site, latitude_deg: event.target.valueAsNumber })} />
      </label>
      <label>Longitude
        <input type="number" min={-180} max={180} step="any" required value={Number.isFinite(site.longitude_deg) ? site.longitude_deg : ""} onChange={(event) => onChange({ ...site, longitude_deg: event.target.valueAsNumber })} />
      </label>
    </div>
    <label>Radius (m)
      <input type="number" min={1} max={maximumSiteRadius} step={1} required value={Number.isFinite(site.radius_m) ? site.radius_m : ""} onChange={(event) => onChange({ ...site, radius_m: event.target.valueAsNumber })} />
    </label>
    <div className="form-actions">
      <button type="submit" className="button primary" disabled={busy}>Save site</button>
      <button type="button" className="button quiet" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

export function SitePanel({ sites, selectedId, draft, busy, onAdd, onDraft, onSave, onSelect, onFly, onDelete, onEdit }: {
  sites: Site[];
  selectedId: string | null;
  draft: SiteSpec | null;
  busy: boolean;
  onAdd: () => void;
  onDraft: (site: SiteSpec | null) => void;
  onSave: (site: SiteSpec) => void;
  onSelect: (id: string | null) => void;
  onFly: (site: Site) => void;
  onDelete: (site: Site) => Promise<boolean>;
  onEdit: (site: Site) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<Site | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    <aside className="panel site-panel" aria-label="Landing sites">
      <div className="panel-title">
        <h2>Landing sites</h2>
        <span className="count">{sites.length}</span>
      </div>
      <button type="button" className="button primary add-site" onClick={() => { setEditing(null); onAdd(); }} disabled={busy || !!draft}><Icon name="plus" /> Add site</button>

      {draft && <SiteForm site={draft} onChange={onDraft} onSave={onSave} onCancel={() => onDraft(null)} busy={busy} />}

      {sites.length === 0 && !draft && <p className="sidebar-note">Pick a point on the Moon or start with a reference site.</p>}

      <div className="saved-sites">
        {sites.map((site) => {
          const selected = site.id === selectedId;
          return <section className={selected ? "site-card selected" : "site-card"} key={site.id}>
            <button
              className="site-heading"
              type="button"
              aria-expanded={selected}
              onClick={() => { onSelect(selected ? null : site.id); setEditing(null); setConfirmDelete(null); }}
            >
              <span className="site-icon"><Icon name="pin" size={17} /></span>
              <span className="site-info"><strong>{site.name}</strong><small>{coordinatesLabel(site.latitude_deg, site.longitude_deg)}</small></span>
              <span className="site-chevron"><Icon name="chevron" size={15} /></span>
            </button>
            {selected && <div className="site-details">
              {editing?.id === site.id
                ? <SiteForm site={editing} onChange={(next) => setEditing({ ...next, id: site.id })} onSave={async (next) => {
                    if (await onEdit({ ...next, id: site.id })) setEditing(null);
                  }} onCancel={() => setEditing(null)} busy={busy} />
                : <>
                  <p>{site.radius_m.toLocaleString("en-GB")} m radius</p>
                  {confirmDelete === site.id
                    ? <div className="site-actions">
                        <button className="button quiet danger" type="button" onClick={async () => {
                          if (await onDelete(site)) setConfirmDelete(null);
                        }} disabled={busy}>Delete site</button>
                        <button className="button quiet" type="button" onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </div>
                    : <div className="site-actions">
                        <button className="button quiet" type="button" onClick={() => onFly(site)}><Icon name="target" size={15} /> Go to</button>
                        <button className="button quiet" type="button" onClick={() => setEditing(site)} disabled={busy}>Edit</button>
                        <button className="button quiet" type="button" onClick={() => setConfirmDelete(site.id)} disabled={busy}>Delete</button>
                      </div>}
                </>}
            </div>}
          </section>;
        })}
      </div>

      {!draft && <div className="reference-sites">
        <h3>Reference sites</h3>
        {referenceSites.map((site) => {
          const existing = sites.find((saved) => saved.latitude_deg === site.latitude_deg && saved.longitude_deg === site.longitude_deg);
          return <button key={site.name} className="reference-button" type="button" disabled={busy} onClick={() => {
            if (existing) {
              onSelect(existing.id);
              onFly(existing);
            } else onSave(site);
          }}><span>{site.name}</span><Icon name={existing ? "arrow" : "plus"} size={15} /></button>;
        })}
      </div>}
    </aside>
  );
}
