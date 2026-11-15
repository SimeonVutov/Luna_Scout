import { lazy, Suspense, useEffect, useState } from "react";
import { SouthPoleMap } from "./features/globe/SouthPoleMap";
import type { MapLayer } from "./features/globe/SouthPoleMap";
import { releaseSiteData } from "./api/client";
import type { Coordinate, RunStatus, Site, SiteSpec, TimeRange } from "./api/types";
import { Icon } from "./Icon";
import { defaultOptions, isActive, useRunOutput, useRunSeries, useScience } from "./features/results/useScience";
import { useSiteInsight } from "./features/results/useSiteInsight";
import { ActivityMenu } from "./features/activity/ActivityMenu";
import { useActivity } from "./features/activity/useActivity";
import { ResultsPanel } from "./features/results/ResultsPanel";
import { siteCatalog, usesApiCatalog } from "./features/sites/siteCatalog";
import { SitePanel } from "./features/sites/SitePanel";
import { maximumSiteRadius, referenceSites } from "./features/sites/referenceSites";
import { SettingsDrawer } from "./features/settings/SettingsDrawer";
import { Timeline } from "./features/timeline/Timeline";
import type { ReadyTrack } from "./features/timeline/Timeline";
import { ComparePicker } from "./features/compare/ComparePicker";
import { CompareLive } from "./features/compare/CompareLive";
import { CompareSummary } from "./features/compare/CompareSummary";
import { slotColor, slotLabel, slots } from "./features/compare/slots";
import type { Slot } from "./features/compare/slots";
import { snapshotAt, todayRange } from "./features/timeline/time";

const SpaceView = lazy(() => import("./features/space/SpaceView").then((module) => ({ default: module.SpaceView })));

const emptyDraft: SiteSpec = {
  name: "New site",
  latitude_deg: Number.NaN,
  longitude_deg: Number.NaN,
  radius_m: 500,
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** Explore and 3D show one site with its results; Compare shows two side by side. */
type Mode = "explore" | "space" | "compare";
type CompareView = "live" | "summary";

export function App() {
  const [mode, setMode] = useState<Mode>("space");
  const [compareView, setCompareView] = useState<CompareView>("live");
  const [compareIds, setCompareIds] = useState<Record<Slot, string | null>>({ a: null, b: null });
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SiteSpec | null>(null);
  const [cameraTarget, setCameraTarget] = useState<Site | null>(null);
  const [range, setRange] = useState(todayRange);
  const [timeIndex, setTimeIndex] = useState(0);
  const [options, setOptions] = useState(defaultOptions);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The 3D view is created on first use and then kept, so its loaded terrain survives mode changes.
  const [spaceOpened, setSpaceOpened] = useState(true);
  const [mapLayer, setMapLayer] = useState<MapLayer>("sunlight");
  const [showCoverage, setShowCoverage] = useState(false);
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
  const science = useScience(sites, range, options, instant.toISOString());
  const activity = useActivity();
  const siteRuns = Object.fromEntries(sites.map((site) => [site.id, science.status(site)]));
  const phases: Record<string, string | null> = activity.list?.worker.run_id ? { [activity.list.worker.run_id]: activity.list.worker.activity } : {};
  const exploring = mode !== "compare";
  const inSpace = mode === "space";
  const chosen: Record<Slot, Site | null> = {
    a: sites.find((site) => site.id === compareIds.a) ?? null,
    b: sites.find((site) => site.id === compareIds.b) ?? null,
  };
  const compareRuns: Record<Slot, RunStatus | null> = { a: science.status(chosen.a), b: science.status(chosen.b) };
  const compareOutputA = useRunOutput(exploring ? null : compareRuns.a, timeIndex);
  const compareOutputB = useRunOutput(exploring ? null : compareRuns.b, timeIndex);
  const compareOutputs = { a: compareOutputA, b: compareOutputB };
  const compareSeriesA = useRunSeries(exploring ? null : compareRuns.a);
  const compareSeriesB = useRunSeries(exploring ? null : compareRuns.b);

  const selectedInsight = useSiteInsight(exploring ? selected : null, options);
  const insightA = useSiteInsight(exploring ? null : chosen.a, options);
  const insightB = useSiteInsight(exploring ? null : chosen.b, options);

  const selectedRun = science.status(selected);
  const selectedOutput = useRunOutput(exploring ? selectedRun : null, timeIndex);
  const series = useRunSeries(exploring ? selectedRun : null);
  const sunlight = selectedOutput.frame?.grid ?? null;
  const submittedSites = exploring ? (selected ? [selected] : []) : slots.flatMap((slot) => chosen[slot] ?? []);
  const runnableSites = submittedSites.filter((site) => {
    if (site.latitude_deg > -60) return false;
    const status = science.status(site);
    return !science.submitting(site) && !isActive(status) && status?.stage !== "complete";
  });
  const activeDraft = draft && Number.isFinite(draft.latitude_deg) && Number.isFinite(draft.longitude_deg) &&
    Number.isSafeInteger(draft.radius_m) && draft.radius_m > 0 && Math.abs(draft.latitude_deg) <= 90 &&
    Math.abs(draft.longitude_deg) <= 180 && draft.radius_m <= maximumSiteRadius ? draft : null;

  function selectSite(id: string | null) {
    setSelectedId(id);
  }

  function chooseMode(next: Mode) {
    if (next === "compare") {
      // Start from what the user was looking at: the selected site as A, any other site as B.
      const first = compareIds.a ?? selectedId;
      const second = compareIds.b ?? sites.find((site) => site.id !== first)?.id ?? null;
      setCompareIds({ a: first, b: second === first ? null : second });
    }
    // A new site is placed on the 2D map, so a draft does not follow into the other modes.
    if (next !== "explore") setDraft(null);
    if (next === "space") setSpaceOpened(true);
    setMode(next);
  }

  function assign(slot: Slot, id: string | null) {
    const other: Slot = slot === "a" ? "b" : "a";
    // Picking the other slot's site swaps the two so a site is never compared with itself.
    setCompareIds((current) => id !== null && id === current[other]
      ? { ...current, [slot]: id, [other]: current[slot] }
      : { ...current, [slot]: id });
  }

  function swap() {
    setCompareIds((current) => ({ a: current.b, b: current.a }));
  }

  async function startRuns() {
    setError(null);
    const results = await Promise.allSettled(runnableSites.map((site) => science.run(site)));
    const problems = results.flatMap((result, index) =>
      result.status === "rejected" ? [`${runnableSites[index].name} · ${errorText(result.reason)}`] : [],
    );
    if (problems.length) setError(problems.join(" "));
    void activity.refresh();
  }

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
      // A reference site keeps its results, so it is instant to bring back; a site you created
      // yourself has its results removed to save space. Failing to free space is not an error.
      const isReference = referenceSites.some((reference) =>
        reference.latitude_deg === site.latitude_deg && reference.longitude_deg === site.longitude_deg);
      void releaseSiteData(site, isReference).then(() => activity.refresh()).catch(() => undefined);
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

  /**
   * One timeline for every site: changing it starts, for all saved sites, whatever the new
   * range is missing. Earlier results stay stored when the range shrinks.
   */
  function changeRange(next: TimeRange) {
    setTimeIndex(0);
    setRange(next);
    const supported = sites.filter((site) => site.latitude_deg <= -60);
    if (!supported.length) return;

    const first = snapshotAt(next, 0).toISOString();
    void Promise.allSettled(supported.map((site) => science.run(site, next, first))).then((results) => {
      const problems = results.flatMap((result, index) =>
        result.status === "rejected" ? [`${supported[index].name} · ${errorText(result.reason)}`] : []);
      setError(problems.length ? problems.join(" ") : null);
      void activity.refresh();
    });
  }

  const tracks: ReadyTrack[] | undefined = exploring
    ? (selectedRun ? [{ id: "selected", color: "var(--accent)", ready: selectedRun.ready_indices }] : undefined)
    : slots.flatMap((slot) => compareRuns[slot] ? [{ id: slot, label: slotLabel[slot], color: slotColor[slot], ready: compareRuns[slot]!.ready_indices }] : []);

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Icon name="moon" size={24} /></span>
          <div><h1>LunaScout</h1><p>Lunar landing sites</p></div>
        </div>
        <div className="topbar-center">
          <div className="view-switch mode-switch" role="group" aria-label="Mode">
            <button className="button secondary" type="button" aria-pressed={mode === "explore"} onClick={() => chooseMode("explore")}>Explore</button>
            <button className="button secondary" type="button" aria-pressed={inSpace} title="The Moon, the Sun and Earth in 3D" onClick={() => chooseMode("space")}>3D view</button>
            <button className="button secondary" type="button" aria-pressed={!exploring} disabled={sites.length < 2} title={sites.length < 2 ? "Save two sites to compare them" : undefined} onClick={() => chooseMode("compare")}>Compare</button>
          </div>
          {!exploring && <div className="view-switch" role="group" aria-label="Comparison view">
            <button className="button secondary" type="button" aria-pressed={compareView === "live"} onClick={() => setCompareView("live")}>Live maps</button>
            <button className="button secondary" type="button" aria-pressed={compareView === "summary"} onClick={() => setCompareView("summary")}>Whole period</button>
          </div>}
        </div>
        <div className="topbar-end">
          <div className="connection" role="status">
            {catalogState === "ready" && (usesApiCatalog ? "Saved on server" : "Sites saved in this browser")}
            {catalogState === "loading" && "Loading saved sites…"}
            {catalogState === "error" && <button className="button quiet" type="button" onClick={() => void loadSites()}>Retry loading sites</button>}
          </div>
          <ActivityMenu list={activity.list} problem={activity.problem} sites={sites} onOpen={() => void activity.refresh()} />
          <button className="button secondary" type="button" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={16} /> Settings</button>
        </div>
      </header>

      {error && <div className="error-bar" role="alert">
        <span>{error}</span><button type="button" aria-label="Dismiss message" onClick={() => setError(null)}><Icon name="close" size={16} /></button>
      </div>}

      <div className={exploring ? "dashboard" : "dashboard compare"}>
        {exploring ? <SitePanel
          sites={sites} selectedId={selectedId} draft={draft} busy={busy || catalogState !== "ready"}
          runs={siteRuns} phases={phases} workerRunning={activity.list ? activity.list.worker.running : null}
          onAdd={() => {
            setMode("explore");
            setDraft({ ...emptyDraft, name: `Site ${sites.length + 1}` });
          }}
          onDraft={setDraft} onSave={(site) => void save(site)} onSelect={selectSite}
          onFly={flyTo} onDelete={deleteSaved} onEdit={edit}
        /> : <ComparePicker sites={sites} chosen={chosen} runs={compareRuns} options={options}
          submitting={submittedSites.some(science.submitting)} canStart={chosen.a !== null && chosen.b !== null && runnableSites.length > 0}
          onAssign={assign} onSwap={swap} onRun={() => void startRuns()} onOpenSettings={() => setSettingsOpen(true)} />}
        {!exploring && compareView === "summary" && <CompareSummary range={range} at={instant} panes={{
          a: { site: chosen.a, run: compareRuns.a, series: compareSeriesA },
          b: { site: chosen.b, run: compareRuns.b, series: compareSeriesB },
        }} />}
        {!exploring && compareView === "live" && <CompareLive at={instant} layer={mapLayer} onLayerChange={setMapLayer} showCoverage={showCoverage} onShowCoverageChange={setShowCoverage}
          panes={{
            a: { site: chosen.a, run: compareRuns.a, reading: compareOutputs.a.frame?.reading ?? null, sunlight: compareOutputs.a.frame?.grid ?? null, insight: insightA.insight },
            b: { site: chosen.b, run: compareRuns.b, reading: compareOutputs.b.frame?.reading ?? null, sunlight: compareOutputs.b.frame?.grid ?? null, insight: insightB.insight },
          }} />}
        <div className="viewport-stage" hidden={!exploring}>
          <div className="stage-view" hidden={inSpace}>
            <SouthPoleMap sites={sites} selectedId={selectedId} draft={activeDraft} picking={draft !== null}
              onPick={pick} onSelect={selectSite} cameraTarget={cameraTarget} sunlight={sunlight}
              slope={selectedInsight.insight?.slope_grid ?? null} layer={mapLayer} onLayerChange={setMapLayer}
              showCoverage={showCoverage} onShowCoverageChange={setShowCoverage} />
          </div>
          {spaceOpened && <div className="stage-view" hidden={!inSpace}>
            <Suspense fallback={<div className="terrain-status" role="status">Opening the 3D view…</div>}>
              <SpaceView active={inSpace} sites={sites} selected={selected} focus={cameraTarget} run={selectedRun}
                range={range} timeIndex={timeIndex} options={options} sunlight={sunlight} onSelect={selectSite} />
            </Suspense>
          </div>}
        </div>
        {exploring && <ResultsPanel site={selected} at={instant} range={range} index={timeIndex}
          run={selectedRun} reading={selectedOutput.frame?.reading ?? null} series={series} frameError={selectedOutput.error}
          submitting={submittedSites.some(science.submitting)} reconnecting={science.reconnecting}
          priorityError={science.priorityError}
          options={options} insight={selectedInsight.insight} insightLoading={selectedInsight.loading} insightError={selectedInsight.error}
          onRun={() => void startRuns()} onOpenSettings={() => setSettingsOpen(true)}
          canStart={runnableSites.length > 0} />}
      </div>
      <Timeline range={range} index={timeIndex} onIndex={setTimeIndex} onRange={changeRange} tracks={tracks} />
      {settingsOpen && <SettingsDrawer options={options} onClose={() => setSettingsOpen(false)}
        onApply={(next) => { setOptions(next); setSettingsOpen(false); }} />}
    </main>
  );
}
