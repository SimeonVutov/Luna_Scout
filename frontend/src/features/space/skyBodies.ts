import {
  AdditiveBlending, AmbientLight, CanvasTexture, DirectionalLight, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  SRGBColorSpace, Sprite, SpriteMaterial, SphereGeometry, Vector3,
} from "three";
import type { Scene } from "three";
import type { Vector } from "../../api/types";
import { EARTH_RADIUS_KM, SUN_RADIUS_KM } from "./geodesy";

/** How long the Sun and Earth take to glide to a new timeline position. */
const SKY_GLIDE_MS = 280;

/** Moon-centred positions of the Sun and Earth, in km. */
export type Sky = { sunKm: Vector; earthKm: Vector };

/**
 * The Sun and Earth at their true sizes and distances, with glows that only help to find them.
 * Positions glide from one timeline step to the next, so playing the timeline looks continuous.
 */
export class SkyBodies {
  readonly sun = new Mesh(new SphereGeometry(SUN_RADIUS_KM, 32, 16), new MeshBasicMaterial({ color: "#fff4cf" }));
  readonly earth = new Mesh(new SphereGeometry(EARTH_RADIUS_KM, 48, 24), new MeshLambertMaterial({ color: "#4a86d8" }));
  /** True once a position is known; before that, nothing is drawn. */
  known = false;

  private readonly sunGlow = glow("#ffe9a8", 0.075);
  private readonly earthGlow = glow("#7fb6ff", 0.06);
  /** Lights Earth from the Sun's direction as seen from Earth. */
  private readonly earthLight = new DirectionalLight("#ffffff", 3);
  private readonly group = new Group();

  private readonly from = { sun: new Vector3(), earth: new Vector3() };
  private readonly to = { sun: new Vector3(), earth: new Vector3() };
  private startedAt = 0;

  constructor(scene: Scene, private readonly sunDirection: Vector3) {
    this.group.add(this.sun, this.sunGlow, this.earth, this.earthGlow, this.earthLight, new AmbientLight("#ffffff", 0.05));
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Move toward new positions, or hide the bodies with null. The first position is shown at once. */
  setSky(next: Sky | null) {
    if (next) {
      const first = !this.known;
      this.to.sun.set(...next.sunKm);
      this.to.earth.set(...next.earthKm);

      // Glide from wherever the bodies are now.
      this.from.sun.copy(first ? this.to.sun : this.sun.position);
      this.from.earth.copy(first ? this.to.earth : this.earth.position);
      this.startedAt = performance.now();
    }

    this.known = next !== null;
    this.group.visible = this.known;
  }

  /** Advance the glide. Returns true while the bodies are still moving. */
  advance(now: number) {
    if (!this.known) return false;

    const progress = Math.min(1, (now - this.startedAt) / SKY_GLIDE_MS);
    this.sun.position.lerpVectors(this.from.sun, this.to.sun, progress);
    this.earth.position.lerpVectors(this.from.earth, this.to.earth, progress);

    this.sunGlow.position.copy(this.sun.position);
    this.earthGlow.position.copy(this.earth.position);
    this.sunDirection.copy(this.sun.position).normalize();
    this.earthLight.position.subVectors(this.sun.position, this.earth.position).normalize();

    return progress < 1;
  }

  dispose() {
    for (const body of [this.sun, this.earth]) {
      body.geometry.dispose();
      body.material.dispose();
    }
    for (const sprite of [this.sunGlow, this.earthGlow]) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
  }
}

/** A soft round glow that keeps the same size on screen, so a body is easy to find. */
function glow(colour: string, size: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;

  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, colour);
  gradient.addColorStop(0.25, `${colour}88`);
  gradient.addColorStop(1, `${colour}00`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;

  const sprite = new Sprite(new SpriteMaterial({ map: texture, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: false }));
  sprite.scale.set(size, size, 1);
  return sprite;
}
