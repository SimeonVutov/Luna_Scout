import type { Site } from "./api/types";
import { ActivityMenu } from "./features/activity/ActivityMenu";
import type { useActivity } from "./features/activity/useActivity";
import type { CatalogState } from "./features/sites/useSiteCatalog";
import { usesApiCatalog } from "./features/sites/siteCatalog";
import { Icon } from "./Icon";

export type Mode = "single" | "compare";
/** The Moon in 3D (the default) or the flat south-polar map. */
export type View = "3d" | "2d";
export type CompareView = "live" | "summary";

type TopBarProps = {
  mode: Mode;
  onMode: (mode: Mode) => void;
  view: View;
  onView: (view: View) => void;
  compareView: CompareView;
  onCompareView: (view: CompareView) => void;
  sites: Site[];
  catalogState: CatalogState;
  onRetryCatalog: () => void;
  activity: ReturnType<typeof useActivity>;
  onOpenSettings: () => void;
};

/** The header: where the app is, what it is showing, and the shortcuts to activity and settings. */
export function TopBar(props: TopBarProps) {
  const { mode, view, compareView, sites, catalogState, activity } = props;
  const comparing = mode === "compare";
  const canCompare = sites.length >= 2;
  const showsMapType = !comparing || compareView === "live";

  return <header className="topbar">
    <div className="brand">
      <span className="brand-mark"><Icon name="moon" size={24} /></span>
      <div><h1>LunaScout</h1><p>Lunar landing sites</p></div>
    </div>

    <div className="topbar-center">
      <div className="view-switch mode-switch" role="group" aria-label="Mode">
        <button className="button secondary" type="button" aria-pressed={!comparing} onClick={() => props.onMode("single")}>Single site</button>
        <button className="button secondary" type="button" aria-pressed={comparing} disabled={!canCompare}
          title={canCompare ? undefined : "Save two sites to compare them"} onClick={() => props.onMode("compare")}>Compare</button>
      </div>

      {showsMapType && <div className="view-switch" role="group" aria-label="Map type">
        <button className="button secondary" type="button" aria-pressed={view === "3d"} title="The Moon, the Sun and Earth in 3D" onClick={() => props.onView("3d")}>3D</button>
        <button className="button secondary" type="button" aria-pressed={view === "2d"} title="The flat map of the south pole" onClick={() => props.onView("2d")}>2D</button>
      </div>}

      {comparing && <div className="view-switch" role="group" aria-label="Comparison view">
        <button className="button secondary" type="button" aria-pressed={compareView === "live"} onClick={() => props.onCompareView("live")}>Live maps</button>
        <button className="button secondary" type="button" aria-pressed={compareView === "summary"} onClick={() => props.onCompareView("summary")}>Whole period</button>
      </div>}
    </div>

    <div className="topbar-end">
      <div className="connection" role="status">
        {catalogState === "ready" && (usesApiCatalog ? "Saved on server" : "Sites saved in this browser")}
        {catalogState === "loading" && "Loading saved sites…"}
        {catalogState === "error" && <button className="button quiet" type="button" onClick={props.onRetryCatalog}>Retry loading sites</button>}
      </div>
      <ActivityMenu list={activity.list} problem={activity.problem} sites={sites} onOpen={() => void activity.refresh()} />
      <button className="button secondary" type="button" onClick={props.onOpenSettings}><Icon name="settings" size={16} /> Settings</button>
    </div>
  </header>;
}
