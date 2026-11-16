import type { CSSProperties } from "react";
import { Icon } from "../../Icon";
import type { Segment } from "./progressModel";
import { stageLabel } from "./progressModel";
import "./progressMotion.css";
import "./stageBar.css";

type BarProps = {
  segments: Segment[];
  overall: number;
  /** Read aloud with the percentage, such as "Building terrain horizons, about 2 min left". */
  description: string;
  paused: boolean;
};

/**
 * One bar made of the run's stages, each as wide as its share of the time. A finished stage
 * turns green and gets a check at its end; the stage in progress shimmers as it fills.
 */
export function StageBar({ segments, overall, description, paused }: BarProps) {
  const percent = Math.round(overall * 100);

  return <div className={paused ? "stage-bar paused" : "stage-bar"} role="progressbar" aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={percent} aria-valuetext={`${percent}%, ${description}`}>
    {segments.map((segment) => {
      const style = { "--width": segment.width, "--fill": segment.fill } as CSSProperties;
      return <div key={segment.key} className={`stage-segment ${segment.state}`} style={style} title={stageLabel[segment.key]}>
        <span className="stage-fill" />
        {segment.state === "done" && <span className="stage-mark" aria-hidden="true"><Icon name="check" size={10} /></span>}
      </div>;
    })}
  </div>;
}
