import { Vector3 } from "three";
import type { PerspectiveCamera } from "three";
import type { SiteSpec } from "../../api/types";
import { MOON_RADIUS_KM, latLonToUnit } from "./geodesy";
import type { SkyBodies } from "./skyBodies";

/** Distance from the view's edge at which a label off screen is parked, in pixels. */
const EDGE_MARGIN_PX = 34;
/** A ground label counts as facing the camera when the camera is no lower than this below its level plane, in km. */
const FACING_SLACK_KM = 2;

type Label = { element: HTMLButtonElement; arrow: HTMLElement };
type SiteLabel = Label & { up: Vector3 };

/** A saved site that gets a label on the ground. */
export type LabelSite = SiteSpec & { id: string };

type LabelHandlers = {
  /** Turn the camera toward the Sun or Earth when its label is clicked. */
  onFaceBody: (body: "sun" | "earth") => void;
  onSelectSite: (id: string) => void;
};

/**
 * The HTML labels over the 3D view: the Sun and Earth (which slide to the edge and point toward
 * the body when it is out of sight) and one per saved site on the ground.
 */
export class SceneLabels {
  private readonly sunLabel: Label;
  private readonly earthLabel: Label;
  private siteLabels: SiteLabel[] = [];

  private readonly inCamera = new Vector3();
  private readonly towardBody = new Vector3();
  private readonly closest = new Vector3();
  private readonly groundPoint = new Vector3();

  constructor(
    private readonly layer: HTMLElement,
    private readonly camera: PerspectiveCamera,
    /** Terrain height at a unit direction, in rendered km. */
    private readonly groundKm: (unit: Vector3) => number,
    private readonly handlers: LabelHandlers,
  ) {
    this.sunLabel = this.createLabel("body sun", "Sun", () => handlers.onFaceBody("sun"));
    this.earthLabel = this.createLabel("body earth", "Earth", () => handlers.onFaceBody("earth"));
  }

  setSites(sites: LabelSite[], selectedId: string | null) {
    for (const label of this.siteLabels) label.element.remove();

    this.siteLabels = sites.map((site) => {
      const className = site.id === selectedId ? "site selected" : "site";
      const label = this.createLabel(className, site.name, () => this.handlers.onSelectSite(site.id));
      return { ...label, up: latLonToUnit(site.latitude_deg, site.longitude_deg, new Vector3()) };
    });
  }

  /** Put every label where it belongs for the current camera. */
  place(width: number, height: number, sky: SkyBodies) {
    this.placeBody(this.sunLabel, sky.sun.position, sky.known, width, height);
    this.placeBody(this.earthLabel, sky.earth.position, sky.known, width, height);
    this.placeSites(width, height);
  }

  dispose() {
    this.layer.replaceChildren();
  }

  private createLabel(className: string, text: string, onClick: () => void): Label {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `space-label ${className}`;

    const arrow = document.createElement("i");
    arrow.textContent = "➤";
    arrow.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.textContent = text;

    element.append(arrow, name);
    element.addEventListener("click", onClick);
    this.layer.appendChild(element);
    return { element, arrow };
  }

  /** Put a label at its body, or on the edge of the view pointing toward it when out of sight. */
  private placeBody(label: Label, body: Vector3, known: boolean, width: number, height: number) {
    label.element.hidden = !known;
    if (!known) return;

    const { x: cx, y: cy, z: cz } = this.inCamera.copy(body).applyMatrix4(this.camera.matrixWorldInverse);
    const screen = this.project(cx, cy, cz, width, height);
    const onScreen = cz < 0
      && screen.x >= EDGE_MARGIN_PX && screen.x <= width - EDGE_MARGIN_PX
      && screen.y >= EDGE_MARGIN_PX && screen.y <= height - EDGE_MARGIN_PX;

    let { x, y } = screen;
    if (!onScreen) {
      // Slide along the line from the screen centre toward the body until the edge is reached.
      const dx = cx;
      const dy = -cy;
      const reach = Math.min(
        (width / 2 - EDGE_MARGIN_PX) / Math.max(1e-9, Math.abs(dx)),
        (height / 2 - EDGE_MARGIN_PX) / Math.max(1e-9, Math.abs(dy)),
      );
      x = width / 2 + dx * reach;
      y = height / 2 + dy * reach;
      label.arrow.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    }

    label.element.classList.toggle("off-screen", !onScreen);
    label.element.classList.toggle("behind", this.hiddenByMoon(body));
    label.element.style.transform = `translate(${x}px, ${y}px)`;
  }

  private placeSites(width: number, height: number) {
    for (const label of this.siteLabels) {
      this.groundPoint.copy(label.up).multiplyScalar(MOON_RADIUS_KM + this.groundKm(label.up));

      // A ground point faces the camera when the camera is above its level plane.
      const facing = this.inCamera.copy(this.camera.position).sub(this.groundPoint).dot(label.up) > -FACING_SLACK_KM;
      const { x: cx, y: cy, z: cz } = this.inCamera.copy(this.groundPoint).applyMatrix4(this.camera.matrixWorldInverse);
      const { x, y } = this.project(cx, cy, cz, width, height);

      const shown = facing && cz < 0 && x > 0 && x < width && y > 0 && y < height;
      label.element.hidden = !shown;
      if (shown) label.element.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  /**
   * Screen position of a camera-space point.
   *
   * Perspective projection: x = W/2·(1 + x_c/(−z_c·h·a)); y = H/2·(1 − y_c/(−z_c·h))
   *   x, y - Pixel position from the top left; W, H - viewport size, in pixels.
   *   x_c, y_c, z_c - Point in camera space, in km, looking down −z.
   *   h - tan(φ/2) for the vertical field of view φ; a - aspect ratio (width/height).
   *   Assumption: the point is in front of the camera (z_c < 0); otherwise the result is not meaningful.
   */
  private project(cx: number, cy: number, cz: number, width: number, height: number) {
    const half = Math.tan(this.camera.fov * Math.PI / 360);
    return {
      x: (cx / (-cz * half * this.camera.aspect) + 1) / 2 * width,
      y: (1 - cy / (-cz * half)) / 2 * height,
    };
  }

  /**
   * Whether the Moon hides a body from the camera.
   *
   * Closest approach: t = −c·v; ‖c + t·v‖ < R + h hides the body when t > 0
   *   c - Camera position and v - unit direction toward the body, Moon-centred, in km.
   *   t - Distance along the sight line to its closest point to the Moon's centre, in km.
   *   R (MOON_RADIUS_KM) - Reference sphere radius, in km; h - terrain height at that point, in km.
   */
  private hiddenByMoon(body: Vector3) {
    const direction = this.towardBody.copy(body).sub(this.camera.position).normalize();
    const along = -this.camera.position.dot(direction);
    const closest = this.closest.copy(this.camera.position).addScaledVector(direction, along);
    const closestRadius = closest.length();

    return along > 0 && closestRadius < MOON_RADIUS_KM + this.groundKm(closest.normalize());
  }
}
