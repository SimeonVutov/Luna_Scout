import "./controlsHint.css";

/** Which part of the mouse a control uses. */
type Gesture = "left" | "right" | "wheel" | "double" | "click";

/** `detail` is shown on hover, where one word is not enough. */
type Control = { gesture: Gesture; verb: string; detail?: string };

const orbiting: Control[] = [
  { gesture: "left", verb: "Move" },
  { gesture: "right", verb: "Turn" },
  { gesture: "wheel", verb: "Zoom" },
  { gesture: "double", verb: "Centre" },
];

const standing: Control[] = [
  { gesture: "left", verb: "Look around" },
  { gesture: "wheel", verb: "Zoom" },
  { gesture: "click", verb: "Face Sun or Earth", detail: "Click the Sun or Earth label to turn toward it" },
];

const spoken: Record<Gesture, string> = {
  left: "Drag",
  right: "Right-drag",
  wheel: "Scroll",
  double: "Double-click",
  click: "Click a label",
};

/** How to move around the 3D view: a small mouse picture and one word per control. */
export function ControlsHint({ standingOnSurface }: { standingOnSurface: boolean }) {
  const controls = standingOnSurface ? standing : orbiting;

  return <ul className="controls-hint" aria-label="Mouse controls">
    {controls.map((control) => <li key={control.verb} title={control.detail}>
      <MouseGlyph gesture={control.gesture} />
      <span className="sr-only">{spoken[control.gesture]}: </span>
      {control.verb}
    </li>)}
  </ul>;
}

/** A mouse outline with the button or wheel in use filled in. */
function MouseGlyph({ gesture }: { gesture: Gesture }) {
  return <svg className="mouse-glyph" width="11" height="15" viewBox="0 0 11 15" aria-hidden="true">
    <rect x="0.75" y="0.75" width="9.5" height="13.5" rx="4.75" className="mouse-body" />
    <path d="M5.5 0.75v5.25M0.75 6h9.5" className="mouse-line" />
    {(gesture === "left" || gesture === "double" || gesture === "click") && <path d="M5.5 1 H5 A4.5 4.5 0 0 0 1 5.5 V5.75 H5.5 Z" className="mouse-lit" />}
    {gesture === "right" && <path d="M5.5 1 H6 A4.5 4.5 0 0 1 10 5.5 V5.75 H5.5 Z" className="mouse-lit" />}
    {gesture === "wheel" && <rect x="4.6" y="2.2" width="1.8" height="3" rx="0.9" className="mouse-lit" />}
    {gesture === "double" && <text x="11" y="15" className="mouse-count">2</text>}
  </svg>;
}
