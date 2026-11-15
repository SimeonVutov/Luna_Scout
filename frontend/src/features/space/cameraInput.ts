import type { CameraRig } from "./cameraRig";

/** Arrow keys move the view this many pixels' worth per press, or more with Shift held. */
const KEY_STEP_PX = 40;
const KEY_STEP_FAST_PX = 120;
const KEY_ZOOM_FACTOR = 1.3;
/** Pixels a scroll "line" counts for, for mice that scroll by lines. */
const LINE_SCROLL_PX = 16;

type Drag = { pointer: number; x: number; y: number; turning: boolean };

/**
 * Turns mouse, wheel and keyboard events on `element` into camera moves. Drag moves the view,
 * right-drag (or Ctrl or Shift) turns and tilts, the wheel zooms, a double click flies closer
 * and the arrow keys and +/- work without a pointer. Returns a function that removes the listeners.
 */
export function attachCameraInput(element: HTMLElement, rig: CameraRig) {
  let drag: Drag | null = null;

  const pointerDown = (event: PointerEvent) => {
    element.setPointerCapture(event.pointerId);
    element.focus({ preventScroll: true });
    rig.interrupt();

    const turning = event.button !== 0 || event.ctrlKey || event.shiftKey;
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, turning };
  };

  const pointerMove = (event: PointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId) return;

    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;

    if (dx || dy) rig.drag(dx, dy, drag.turning);
  };

  const pointerEnd = (event: PointerEvent) => {
    if (drag?.pointer === event.pointerId) drag = null;
  };

  const wheel = (event: WheelEvent) => {
    event.preventDefault();

    const amount = event.deltaY * (event.deltaMode === 1 ? LINE_SCROLL_PX : 1);
    rig.scroll(amount, event.clientX, event.clientY);
  };

  const doubleClick = (event: MouseEvent) => rig.flyCloserTo(event.clientX, event.clientY);

  const key = (event: KeyboardEvent) => {
    const step = event.shiftKey ? KEY_STEP_FAST_PX : KEY_STEP_PX;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };

    const move = moves[event.key];
    if (move) rig.nudge(...move);
    else if (event.key === "+" || event.key === "=") rig.scaleDistance(1 / KEY_ZOOM_FACTOR);
    else if (event.key === "-") rig.scaleDistance(KEY_ZOOM_FACTOR);
    else return;

    event.preventDefault();
  };

  const contextMenu = (event: Event) => event.preventDefault();

  element.addEventListener("pointerdown", pointerDown);
  element.addEventListener("pointermove", pointerMove);
  element.addEventListener("pointerup", pointerEnd);
  element.addEventListener("pointercancel", pointerEnd);
  element.addEventListener("wheel", wheel, { passive: false });
  element.addEventListener("dblclick", doubleClick);
  element.addEventListener("keydown", key);
  element.addEventListener("contextmenu", contextMenu);

  return () => {
    element.removeEventListener("pointerdown", pointerDown);
    element.removeEventListener("pointermove", pointerMove);
    element.removeEventListener("pointerup", pointerEnd);
    element.removeEventListener("pointercancel", pointerEnd);
    element.removeEventListener("wheel", wheel);
    element.removeEventListener("dblclick", doubleClick);
    element.removeEventListener("keydown", key);
    element.removeEventListener("contextmenu", contextMenu);
  };
}
