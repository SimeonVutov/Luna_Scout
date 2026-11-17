/** A press that moves further than this many pixels is a drag, not a tap. */
const TAP_SLOP_PX = 5;

/**
 * Calls `onTap` with the screen position of a left-button click that stayed in place, so dragging
 * to move the view never counts. Returns a function that removes the listeners.
 */
export function attachGroundTap(element: HTMLElement, onTap: (clientX: number, clientY: number) => void) {
  let press: { pointer: number; x: number; y: number } | null = null;

  const down = (event: PointerEvent) => {
    press = event.button === 0 && !event.ctrlKey && !event.shiftKey
      ? { pointer: event.pointerId, x: event.clientX, y: event.clientY }
      : null;
  };

  const up = (event: PointerEvent) => {
    if (!press || press.pointer !== event.pointerId) return;

    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    press = null;
    if (moved <= TAP_SLOP_PX) onTap(event.clientX, event.clientY);
  };

  const cancel = () => { press = null; };

  element.addEventListener("pointerdown", down);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancel);

  return () => {
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("pointerup", up);
    element.removeEventListener("pointercancel", cancel);
  };
}
