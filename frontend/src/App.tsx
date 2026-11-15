import { lazy, Suspense, useEffect, useState } from "react";
import { SouthPoleMap } from "./features/globe/SouthPoleMap";
import type { Coordinate, Site, SiteSpec, TimeRange } from "./api/types";
import { Icon } from "./Icon";
import { defaultOptions, isActive, useRunOutput, useRunSeries, useScience } from "./features/results/useScience";
import { ResultsPanel } from "./features/results/ResultsPanel";
import { siteCatalog, usesApiCatalog } from "./features/sites/siteCatalog";
import { SitePanel } from "./features/sites/SitePanel";
import { maximumSiteRadius } from "./features/sites/referenceSites";
import { Timeline } from "./features/timeline/Timeline";
import { snapshotAt, todayRange } from "./features/timeline/time";

const TerrainView = lazy(() => import("./features/terrain/TerrainView").then((module) => ({ default: module.TerrainView })));

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
  const [options, setOptions] = useState(defaultOptions);
  const [comparisonId, setComparisonId] = useState("");
  const [terrainMode, setTerrainMode] = useState(false);
  const [visitedTerrain, setVisitedTerrain] = useState<string | null>(null);
  const [showSunlight, setShowSunlight] = useState(true);
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
  const comparison = sites.find((site) => site.id === comparisonId && site.id !== selectedId) ?? null;
  const science = useScience(sites, range, options, instant.toISOString());
  const selectedRun = science.status(selected);
  const comparedRun = science.status(comparison);
  const selectedOutput = useRunOutput(selectedRun, timeIndex);
  const series = useRunSeries(selectedRun);
  const comparisonSeries = useRunSeries(comparedRun);
  const comparedReading = comparisonSeries.find((point) => Date.parse(point.at_utc) === instant.valueOf()) ?? null;
  const showTerrain = terrainMode && selected !== null && !draft;
  const terrainKey = selected ? `${selected.latitude_deg}/${selected.longitude_deg}/${selected.radius_m}` : null;
  useEffect(() => {
    if (showTerrain) setVisitedTerrain(terrainKey);
  }, [showTerrain, terrainKey]);
  const sunlight = selectedOutput.frame?.grid ?? null;
  const submittedSites = [selected, comparison].filter((site): site is Site => site !== null);
  const supportedSelection = submittedSites.every((site) => site.latitude_deg <= -60);
  const runnableSites = submittedSites.filter((site) => {
    if (!supportedSelection) return false;
    const status = science.status(site);
    return !science.submitting(site) && !isActive(status) && status?.stage !== "complete";
  });
  const activeDraft = draft && Number.isFinite(draft.latitude_deg) && Number.isFinite(draft.longitude_deg) &&
    Number.isSafeInteger(draft.radius_m) && draft.radius_m > 0 && Math.abs(draft.latitude_deg) <= 90 &&
    Math.abs(draft.longitude_deg) <= 180 && draft.radius_m <= maximumSiteRadius ? draft : null;

  function selectSite(id: string | null) {
    setSelectedId(id);
    if (id === comparisonId) setComparisonId("");
  }

  async function startRuns() {
    setError(null);
    const results = await Promise.allSettled(runnableSites.map((site) => science.run(site)));
    const problems = results.flatMap((result, index) =>
      result.status === "rejected" ? [`${runnableSites[index].name} · ${errorText(result.reason)}`] : [],
    );
    if (problems.length) setError(problems.join(" "));
  }

  function flyTo(site: Site) {
    setTerrainMode(false);
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
      selectSite(site.id);
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
        <div className="view-switch" role="group" aria-label="Lunar view">
          <button className="button secondary" type="button" aria-pressed={!showTerrain} onClick={() => setTerrainMode(false)}>Map</button>
          <button className="button secondary" type="button" aria-pressed={showTerrain} disabled={!selected || selected.latitude_deg > -60 || !!draft} onClick={() => setTerrainMode(true)}>3D terrain</button>
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
          onAdd={() => {
            setTerrainMode(false);
            setDraft({ ...emptyDraft, name: `Site ${sites.length + 1}` });
          }}
          onDraft={setDraft} onSave={(site) => void save(site)} onSelect={selectSite}
          onFly={flyTo} onDelete={deleteSaved} onEdit={edit}
        />
        <div className="viewport-stage">
          <div className="stage-view" hidden={showTerrain}>
            <SouthPoleMap sites={sites} selectedId={selectedId} draft={activeDraft} picking={draft !== null}
              onPick={pick} onSelect={selectSite} cameraTarget={cameraTarget} sunlight={sunlight}
              showSunlight={showSunlight} onToggleSunlight={() => setShowSunlight((value) => !value)} />
          </div>
          {selected && (showTerrain || terrainKey === visitedTerrain) && <div className="stage-view" hidden={!showTerrain}>
            <Suspense fallback={<div className="terrain-status" role="status">Opening 3D terrain…</div>}>
              <TerrainView key={terrainKey} site={selected}
                sunlight={sunlight} showSunlight={showSunlight} onToggleSunlight={() => setShowSunlight((value) => !value)} />
            </Suspense>
          </div>}
        </div>
        <ResultsPanel site={selected} at={instant} range={range} index={timeIndex}
          run={selectedRun} reading={selectedOutput.frame?.reading ?? null} series={series} frameError={selectedOutput.error}
          submitting={submittedSites.some(science.submitting)} reconnecting={science.reconnecting}
          priorityError={science.priorityError}
          options={options} onOptions={setOptions} onRun={() => void startRuns()}
          sites={sites} comparison={comparison} compareRun={comparedRun} compareReading={comparedReading}
          onCompare={setComparisonId} canStart={runnableSites.length > 0} />
      </div>
      <Timeline range={range} index={timeIndex} onIndex={setTimeIndex} onRange={changeRange} ready={selectedRun?.ready_indices} />
    </main>
  );
}
