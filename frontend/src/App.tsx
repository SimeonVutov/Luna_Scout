import { useEffect, useState } from "react";
import { SouthPoleMap } from "./features/globe/SouthPoleMap";
import type { Coordinate, Site, SiteSpec, TimeRange } from "./api/types";
import { Icon } from "./Icon";
import { demoSnapshot } from "./features/results/demoResults";
import { ResultsPanel } from "./features/results/ResultsPanel";
import { siteCatalog, usesApiCatalog } from "./features/sites/siteCatalog";
import { SitePanel } from "./features/sites/SitePanel";
import { maximumSiteRadius } from "./features/sites/referenceSites";
import { Timeline } from "./features/timeline/Timeline";
import { snapshotAt, todayRange } from "./features/timeline/time";

const emptyDraft: SiteSpec = {
  name: "New site",
  latitude_deg: Number.NaN,
  longitude_deg: Number.NaN,
  radius_m: 500,
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function App() {
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SiteSpec | null>(null);
  const [cameraTarget, setCameraTarget] = useState<Site | null>(null);
  const [range, setRange] = useState(todayRange);
  const [timeIndex, setTimeIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  async function loadSites() {
    setCatalogState("loading");
    try {
      const saved = await siteCatalog.list();
      setSites(saved);
      setSelectedId((id) => saved.some((site) => site.id === id) ? id : saved[0]?.id ?? null);
      setCatalogState("ready");
      setError(null);
    } catch (failure) {
      setCatalogState("error");
      setError(errorText(failure));
    }
  }

  useEffect(() => { void loadSites(); }, []);

  const selected = sites.find((site) => site.id === selectedId) ?? null;
  const instant = snapshotAt(range, timeIndex);
  const snapshot = selected ? demoSnapshot(selected, instant) : null;
  const activeDraft = draft && Number.isFinite(draft.latitude_deg) && Number.isFinite(draft.longitude_deg) &&
    Number.isSafeInteger(draft.radius_m) && draft.radius_m > 0 && Math.abs(draft.latitude_deg) <= 90 &&
    Math.abs(draft.longitude_deg) <= 180 && draft.radius_m <= maximumSiteRadius ? draft : null;

  function flyTo(site: Site) {
    setCameraTarget({ ...site });
  }

  function pick(coordinate: Coordinate) {
    if (!busy) setDraft((site) => site && { ...site, ...coordinate });
  }

  async function save(spec: SiteSpec) {
    setBusy(true);
    setError(null);
    try {
      const site = await siteCatalog.create(spec);
      setSites((current) => [...current, site]);
      setSelectedId(site.id);
      setDraft(null);
      flyTo(site);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function edit(site: Site) {
    setBusy(true);
    setError(null);
    try {
      const { id, ...spec } = site;
      const updated = await siteCatalog.update(id, spec);
      setSites((current) => current.map((saved) => saved.id === updated.id ? updated : saved));
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteSaved(site: Site) {
    setBusy(true);
    setError(null);
    try {
      await siteCatalog.remove(site.id);
      const remaining = sites.filter((saved) => saved.id !== site.id);
      setSites(remaining);
      setSelectedId((id) => id === site.id ? remaining[0]?.id ?? null : id);
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function changeRange(next: TimeRange) {
    setTimeIndex(0);
    setRange(next);
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Icon name="moon" size={24} /></span>
          <div><h1>LunaScout</h1><p>Lunar landing sites</p></div>
        </div>
        <div className="connection" role="status">
          {catalogState === "ready" && (usesApiCatalog ? "Saved on server" : "Sites saved in this browser")}
          {catalogState === "loading" && "Loading saved sites…"}
          {catalogState === "error" && <button className="button quiet" type="button" onClick={() => void loadSites()}>Retry loading sites</button>}
        </div>
      </header>

      {error && <div className="error-bar" role="alert">
        <span>{error}</span><button type="button" aria-label="Dismiss message" onClick={() => setError(null)}><Icon name="close" size={16} /></button>
      </div>}

      <div className="dashboard">
        <SitePanel
          sites={sites} selectedId={selectedId} draft={draft} busy={busy || catalogState !== "ready"}
          onAdd={() => setDraft({ ...emptyDraft, name: `Site ${sites.length + 1}` })}
          onDraft={setDraft} onSave={(site) => void save(site)} onSelect={setSelectedId}
          onFly={flyTo} onDelete={deleteSaved} onEdit={edit}
        />
        <SouthPoleMap sites={sites} selectedId={selectedId} draft={activeDraft} picking={draft !== null}
          onPick={pick} onSelect={setSelectedId} cameraTarget={cameraTarget}
          demoLightFraction={snapshot?.litAreaFraction ?? null} />
        <ResultsPanel site={selected} at={instant} range={range} index={timeIndex} snapshot={snapshot} />
      </div>
      <Timeline range={range} index={timeIndex} onIndex={setTimeIndex} onRange={changeRange} />
    </main>
  );
}
