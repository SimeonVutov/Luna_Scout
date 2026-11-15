import type { SiteInsight, TerrainSummary } from "../../api/types";
import { decimal, wholePercent } from "./format";

export type TerrainQuality = "fine" | "regional" | "coarse";

function postings(summary: TerrainSummary) {
  return Object.entries(summary.detail_area_fractions)
    .map(([metres, share]) => ({ metres: Number(metres), share }))
    .sort((first, second) => first.metres - second.metres);
}

/** How fine the elevation data under most of the site is. */
export function terrainQuality(summary: TerrainSummary): TerrainQuality {
  const coarsest = postings(summary).filter((entry) => entry.share >= 0.05).at(-1)?.metres ?? 240;
  return coarsest <= 5 ? "fine" : coarsest <= 80 ? "regional" : "coarse";
}

/** "5 m LOLA", or the mix when a site straddles two sources. */
export function detailLabel(summary: TerrainSummary) {
  const entries = postings(summary);
  if (entries.length === 0) return "No terrain";
  if (entries.length === 1 || entries[0].share >= 0.995) return `${entries[0].metres} m LOLA`;
  return entries.map((entry) => `${entry.metres} m ${wholePercent.format(entry.share)}`).join(" · ");
}

const qualityNote: Record<TerrainQuality, string> = {
  fine: "Fine terrain: the rims and ridges that cast shadows are resolved.",
  regional: "Regional terrain: large craters and rims only. Small features are missed.",
  coarse: "Coarse terrain: shadows here are approximate. Compare with care.",
};

export function TerrainSection({ insight, loading, error }: { insight: SiteInsight | null; loading: boolean; error: string | null }) {
  if (error) return <p className="result-note error-text" role="alert">{error}</p>;
  if (!insight) return <p className="result-note" role="status">{loading ? "Reading the terrain…" : "Terrain is available from 60°S to the pole."}</p>;

  const summary = insight.summary;
  const quality = terrainQuality(summary);
  const gentle = summary.gentle_area_fractions;
  const relief = summary.height_min_m !== null && summary.height_max_m !== null ? summary.height_max_m - summary.height_min_m : null;
  return <>
    <dl className="metrics">
      <div><dt>Terrain detail</dt><dd className={`quality ${quality}`}>{detailLabel(summary)}</dd></div>
      <div><dt>Mean slope</dt><dd>{summary.slope_mean_deg === null ? "—" : `${decimal.format(summary.slope_mean_deg)}°`}</dd></div>
      <div><dt>95th percentile · steepest</dt><dd>{summary.slope_p95_deg === null ? "—" : `${decimal.format(summary.slope_p95_deg)}° · ${decimal.format(summary.slope_max_deg ?? 0)}°`}</dd></div>
      <div><dt>Ground ≤ 5° · ≤ 10° · ≤ 15°</dt><dd>{["5", "10", "15"].map((limit) => gentle[limit] === undefined ? "—" : wholePercent.format(gentle[limit])).join(" · ")}</dd></div>
      <div><dt>Height range</dt><dd>{relief === null ? "—" : `${decimal.format(relief)} m`}</dd></div>
    </dl>
    <p className={`result-note quality-note ${quality}`}>{qualityNote[quality]} Slope is measured over {decimal.format(summary.slope_baseline_m)} m.</p>
  </>;
}
