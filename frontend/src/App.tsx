import { lazy, Suspense, useState } from "react";
import { releaseSiteData } from "./api/client";
import { errorText } from "./api/errorText";
import type { Coordinate, RunStatus, Site, SiteSpec, TimeRange } from "./api/types";
import { useActivity } from "./features/activity/useActivity";
import { ComparePicker } from "./features/compare/ComparePicker";
import { CompareLive } from "./features/compare/CompareLive";
import { CompareSummary } from "./features/compare/CompareSummary";
import { slotColor, slotLabel, slots } from "./features/compare/slots";
import type { Slot } from "./features/compare/slots";
import { useCompareSelection } from "./features/compare/useCompareSelection";
import { SouthPoleMap } from "./features/globe/SouthPoleMap";
import type { MapLayer } from "./features/globe/SouthPoleMap";
import { ResultsPanel } from "./features/results/ResultsPanel";
import { defaultOptions, isActive, useScience } from "./features/results/useScience";
import { useSiteData } from "./features/results/useSiteData";
import { SettingsDrawer } from "./features/settings/SettingsDrawer";
import { maximumSiteRadius, referenceSites } from "./features/sites/referenceSites";
import { SitePanel } from "./features/sites/SitePanel";
import { useSiteCatalog } from "./features/sites/useSiteCatalog";
import { defaultSpaceLayers } from "./features/space/layers";
import { Timeline } from "./features/timeline/Timeline";
import type { ReadyTrack } from "./features/timeline/Timeline";
import { snapshotAt, todayRange } from "./features/timeline/time";
import { TopBar } from "./TopBar";
import type { CompareView, Mode, View } from "./TopBar";
import { Icon } from "./Icon";

const SpaceView = lazy(() => import("./features/space/SpaceView").then((module) => ({ default: module.SpaceView })));

const emptyDraft: SiteSpec = {
  name: "New site",
  latitude_deg: Number.NaN,
  longitude_deg: Number.NaN,
  radius_m: 500,
};

/** The draft site, once it has a usable position and size; otherwise null. */
function usableDraft(draft: SiteSpec | null) {
  if (!draft) return null;

  const positioned = Number.isFinite(draft.latitude_deg) && Number.isFinite(draft.longitude_deg);
  const onMoon = Math.abs(draft.latitude_deg) <= 90 && Math.abs(draft.longitude_deg) <= 180;
  const sized = Number.isSafeInteger(draft.radius_m) && draft.radius_m > 0 && draft.radius_m <= maximumSiteRadius;

  return positioned && onMoon && sized ? draft : null;
}

/** A site is a reference site when it sits where one of NASA's listed sites does. */
function isReferenceSite(site: Site) {
  return referenceSites.some((reference) =>
    reference.latitude_deg === site.latitude_deg && reference.longitude_deg === site.longitude_deg);
}

export function App() {
  const [mode, setMode] = useState<Mode>("single");
  const [view, setView] = useState<View>("3d");
  const [compareView, setCompareView] = useState<CompareView>("live");
  const [spaceLayers, setSpaceLayers] = useState(defaultSpaceLayers);
  const [mapLayer, setMapLayer] = useState<MapLayer>("sunlight");
  const [draft, setDraft] = useState<SiteSpec | null>(null);
  const [cameraTarget, setCameraTarget] = useState<Site | null>(null);
  const [range, setRange] = useState(todayRange);
  const [timeIndex, setTimeIndex] = useState(0);
  const [options, setOptions] = useState(defaultOptions);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const catalog = useSiteCatalog(setError);
  const comparison = useCompareSelection(catalog.sites);
  const { sites, selected } = catalog;
  const { chosen } = comparison;

  const instant = snapshotAt(range, timeIndex);
  const science = useScience(sites, range, options, instant.toISOString());
  const activity = useActivity();
  const single = mode === "single";
  const inSpace = view === "3d";

  const selectedRun = science.status(selected);
  const compareRuns: Record<Slot, RunStatus | null> = { a: science.status(chosen.a), b: science.status(chosen.b) };
  const selectedData = useSiteData(selected, selectedRun, timeIndex, options, single);
  const compareData = {
    a: useSiteData(chosen.a, compareRuns.a, timeIndex, options, !single),
    b: useSiteData(chosen.b, compareRuns.b, timeIndex, options, !single),
  };

  const sunlight = selectedData.output.frame?.grid ?? null;
  const siteRuns = Object.fromEntries(sites.map((site) => [site.id, science.status(site)]));
  const workerRun = activity.list?.worker;
  const phases: Record<string, string | null> = workerRun?.run_id ? { [workerRun.run_id]: workerRun.activity } : {};

  const submittedSites = single ? (selected ? [selected] : []) : slots.flatMap((slot) => chosen[slot] ?? []);
  const runnableSites = submittedSites.filter((site) => {
    if (site.latitude_deg > -60) return false;

    const status = science.status(site);
    return !science.submitting(site) && !isActive(status) && status?.stage !== "complete";
  });

  const tracks: ReadyTrack[] | undefined = single
    ? (selectedRun ? [{ id: "selected", color: "var(--accent)", ready: selectedRun.ready_indices }] : undefined)
    : slots.flatMap((slot) => compareRuns[slot]
      ? [{ id: slot, label: slotLabel[slot], color: slotColor[slot], ready: compareRuns[slot]!.ready_indices }]
      : []);

  function chooseMode(next: Mode) {
    if (next === "compare") comparison.startFrom(catalog.selectedId);
    setMode(next);
  }

  function startAddingSite() {
    // A new site is placed by clicking the flat map.
    setMode("single");
    setView("2d");
    setDraft({ ...emptyDraft, name: `Site ${sites.length + 1}` });
  }

  function placeDraft(coordinate: Coordinate) {
    if (!catalog.busy) setDraft((site) => site && { ...site, ...coordinate });
  }

  async function saveSite(spec: SiteSpec) {
    const site = await catalog.create(spec);
    if (!site) return;

    setDraft(null);
    setCameraTarget({ ...site });
  }

  async function deleteSite(site: Site) {
    const removed = await catalog.remove(site);
    if (!removed) return false;

    // A reference site keeps its results, so it is instant to bring back; a site you created
    // yourself has its results removed to save space. Failing to free space is not an error.
    void releaseSiteData(site, isReferenceSite(site)).then(() => activity.refresh()).catch(() => undefined);
    return true;
  }

  async function startRuns() {
    setError(null);

    const results = await Promise.allSettled(runnableSites.map((site) => science.run(site)));
    const problems = results.flatMap((result, index) =>
      result.status === "rejected" ? [`${runnableSites[index].name} · ${errorText(result.reason)}`] : []);

    if (problems.length) setError(problems.join(" "));
    void activity.refresh();
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

  return (
    <main className="workspace">
      <TopBar mode={mode} onMode={chooseMode} view={view} onView={setView}
        compareView={compareView} onCompareView={setCompareView}
        sites={sites} catalogState={catalog.state} onRetryCatalog={() => void catalog.reload()}
        activity={activity} onOpenSettings={() => setSettingsOpen(true)} />

      {error && <div className="error-bar" role="alert">
        <span>{error}</span>
        <button type="button" aria-label="Dismiss message" onClick={() => setError(null)}><Icon name="close" size={16} /></button>
      </div>}

      <div className={single ? "dashboard" : "dashboard compare"}>
        {single ? <SitePanel
          sites={sites} selectedId={catalog.selectedId} draft={draft} busy={catalog.busy || catalog.state !== "ready"}
          runs={siteRuns} phases={phases} workerRunning={activity.list ? activity.list.worker.running : null}
          onAdd={startAddingSite} onDraft={setDraft} onSave={(site) => void saveSite(site)} onSelect={catalog.select}
          onFly={(site) => setCameraTarget({ ...site })} onDelete={deleteSite} onEdit={catalog.edit}
        /> : <ComparePicker sites={sites} chosen={chosen} runs={compareRuns} options={options}
          submitting={submittedSites.some(science.submitting)} canStart={chosen.a !== null && chosen.b !== null && runnableSites.length > 0}
          onAssign={comparison.assign} onSwap={comparison.swap} onRun={() => void startRuns()} onOpenSettings={() => setSettingsOpen(true)} />}

        {!single && compareView === "summary" && <CompareSummary range={range} at={instant} panes={{
          a: { site: chosen.a, run: compareRuns.a, series: compareData.a.series, context: compareData.a.context, insight: compareData.a.insight.insight },
          b: { site: chosen.b, run: compareRuns.b, series: compareData.b.series, context: compareData.b.context, insight: compareData.b.insight.insight },
        }} />}

        {!single && compareView === "live" && <CompareLive at={instant} view={view} range={range} timeIndex={timeIndex} options={options}
          spaceLayers={spaceLayers} onSpaceLayers={setSpaceLayers} layer={mapLayer} onLayerChange={setMapLayer}
          panes={{
            a: { site: chosen.a, run: compareRuns.a, reading: compareData.a.output.frame?.reading ?? null, sunlight: compareData.a.output.frame?.grid ?? null, insight: compareData.a.insight.insight, context: compareData.a.context },
            b: { site: chosen.b, run: compareRuns.b, reading: compareData.b.output.frame?.reading ?? null, sunlight: compareData.b.output.frame?.grid ?? null, insight: compareData.b.insight.insight, context: compareData.b.context },
          }} />}

        <div className="viewport-stage" hidden={!single}>
          <div className="stage-view" hidden={inSpace}>
            <SouthPoleMap sites={sites} selectedId={catalog.selectedId} draft={usableDraft(draft)} picking={draft !== null}
              onPick={placeDraft} onSelect={catalog.select} cameraTarget={cameraTarget} sunlight={sunlight}
              slope={selectedData.insight.insight?.slope_grid ?? null} context={selectedData.context} layer={mapLayer} onLayerChange={setMapLayer} />
          </div>
          <div className="stage-view" hidden={!inSpace}>
            <Suspense fallback={<div className="stage-status" role="status">Opening the 3D view…</div>}>
              <SpaceView active={inSpace && single} sites={sites} selected={selected} focus={cameraTarget} run={selectedRun}
                layerState={spaceLayers} onLayers={setSpaceLayers}
                range={range} timeIndex={timeIndex} options={options} sunlight={sunlight} context={selectedData.context} onSelect={catalog.select} />
            </Suspense>
          </div>
        </div>

        {single && <ResultsPanel site={selected} at={instant} range={range} index={timeIndex}
          run={selectedRun} reading={selectedData.output.frame?.reading ?? null} series={selectedData.series} frameError={selectedData.output.error}
          submitting={submittedSites.some(science.submitting)} reconnecting={science.reconnecting} priorityError={science.priorityError}
          options={options} insight={selectedData.insight.insight} insightLoading={selectedData.insight.loading} insightError={selectedData.insight.error}
          onRun={() => void startRuns()} onOpenSettings={() => setSettingsOpen(true)} canStart={runnableSites.length > 0} />}
      </div>

      <Timeline range={range} index={timeIndex} onIndex={setTimeIndex} onRange={changeRange} tracks={tracks} />

      {settingsOpen && <SettingsDrawer options={options} onClose={() => setSettingsOpen(false)}
        onApply={(next) => { setOptions(next); setSettingsOpen(false); }} />}
    </main>
  );
}
