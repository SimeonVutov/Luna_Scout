import {
  AdditiveBlending, AmbientLight, BufferAttribute, BufferGeometry, CanvasTexture, Color, DirectionalLight, Group,
  LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshLambertMaterial, NearestFilter, PerspectiveCamera, Points,
  PointsMaterial, SRGBColorSpace, Scene, SphereGeometry, Sprite, SpriteMaterial, Vector3, WebGLRenderer,
} from "three";
import type { RayFan, SiteSpec, Vector } from "../../api/types";
import type { ShownRays } from "./useSiteRays";
import { CameraRig } from "./cameraRig";
import type { RigView } from "./cameraRig";
import { EARTH_RADIUS_KM, MOON_RADIUS_KM, SUN_RADIUS_KM, latLonToUnit, siteAxes } from "./geodesy";
import { sharedUniforms } from "./terrainMaterial";
import { TileTree } from "./tiles";

/** Each body has its own colour for clear rays and for rays terrain cuts off. */
export const rayColours = {
  sun: "#ffd76a", sunBlocked: "#ff5a36",
  earth: "#5fb8ff", earthBlocked: "#c45bff",
  unknown: "#9aa3ad",
} as const;
/** How long the Sun and Earth take to glide to a new timeline position. */
const SKY_GLIDE_MS = 280;
/** Distances along a clear ray where its drawn line is split, in km. */
const CLEAR_RAY_STOPS_KM = [5, 500];
/**
 * A clear ray is drawn only this far. It leaves the Moon, crosses some space and stops: the
 * Sun and Earth are millions of kilometres away, and drawing all of it only costs time.
 */
const RAY_DRAW_LENGTH_KM = 4000;
/** Camera distance of the south-pole view: the Moon's disk fills the screen. */
const POLE_VIEW_KM = 4200;
/** Far enough to hold the Sun, 150 million km away. */
const FAR_KM = 4e8;

export type SceneSite = SiteSpec & { id: string };
export type Sky = { sunKm: Vector; earthKm: Vector };
export type ResultGrid = { site: SiteSpec; canvas: HTMLCanvasElement; halfWidthM: number };
export type SceneCallbacks = {
  onView: (view: RigView) => void;
  onSelect: (id: string) => void;
  onProblem: (message: string | null) => void;
};

type Label = { element: HTMLButtonElement; arrow: HTMLElement; position: Vector3 };

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

/** Radial point with its height above the reference sphere multiplied by `exaggeration`. */
function exaggerate(point: Vector3, exaggeration: number) {
  const radius = point.length();
  return point.multiplyScalar((MOON_RADIUS_KM + (radius - MOON_RADIUS_KM) * exaggeration) / radius);
}

/**
 * The simulation's rays from one instrument to a body's disk. A clear ray runs all the way to
 * the body; a blocked ray stops, with a dot, at the terrain that blocks it.
 */
function rayFan(fan: RayFan, clearColour: string, blockedColour: string, exaggeration: number, opacity = 0.9) {
  const origin = new Vector3(...fan.origin_m).divideScalar(1000);
  const shownOrigin = exaggerate(origin.clone(), exaggeration);
  const bodyDistanceKm = Math.min(RAY_DRAW_LENGTH_KM, new Vector3(...fan.body_m).divideScalar(1000).distanceTo(origin));
  const clear = new Color(clearColour);
  const blocked = new Color(blockedColour);
  const unknown = new Color(rayColours.unknown);

  const positions: number[] = [];
  const colours: number[] = [];
  const hits: number[] = [];
  const end = new Vector3();
  fan.directions.forEach((direction, index) => {
    const status = fan.statuses[index];
    const hitM = fan.hit_distances_m[index];
    const along = end.set(...direction);
    let colour = clear;
    if (status === "clear") {
      // A clear ray reaches the body. It is drawn in pieces of growing length, because one
      // line from a few metres to 150 million km loses its near end to rounding when drawn.
      const start = origin.clone().sub(shownOrigin);
      const stops = [...CLEAR_RAY_STOPS_KM.filter((stop) => stop < bodyDistanceKm), bodyDistanceKm];
      let from = start;
      for (const stop of stops) {
        const to = start.clone().addScaledVector(along, stop);
        positions.push(from.x, from.y, from.z, to.x, to.y, to.z);
        colours.push(clear.r, clear.g, clear.b, clear.r, clear.g, clear.b);
        from = to;
      }
      return;
    } else if (status === "blocked" && hitM !== null) {
      // The blocking point is raised with the terrain, so the ray ends on the drawn ridge.
      exaggerate(along.multiplyScalar(hitM / 1000).add(origin), exaggeration).sub(shownOrigin);
      hits.push(along.x, along.y, along.z);
      colour = blocked;
    } else {
      // No blocking point is known: draw a short stub in the ray's direction.
      along.multiplyScalar(status === "blocked" ? 1.5 : 25);
      colour = status === "blocked" ? blocked : unknown;
    }
    positions.push(0, 0, 0, along.x, along.y, along.z);
    colours.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b);
  });

  const group = new Group();
  // Vertices are relative to the instrument, which keeps them exact at lunar-radius distances.
  group.position.copy(shownOrigin);
  const lines = new BufferGeometry();
  lines.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  lines.setAttribute("color", new BufferAttribute(new Float32Array(colours), 3));
  group.add(new LineSegments(lines, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity })));

  const dots = new BufferGeometry();
  dots.setAttribute("position", new BufferAttribute(new Float32Array(hits), 3));
  group.add(new Points(dots, new PointsMaterial({ color: blockedColour, size: 6, sizeAttenuation: false })));
  const start = new BufferGeometry();
  start.setAttribute("position", new BufferAttribute(new Float32Array(3), 3));
  group.add(new Points(start, new PointsMaterial({ color: "#ffffff", size: 7, sizeAttenuation: false })));
  for (const child of group.children) child.frustumCulled = false;
  return group;
}

function disposeFan(group: Group) {
  for (const child of group.children as (LineSegments | Points)[]) {
    child.geometry.dispose();
    (child.material as LineBasicMaterial | PointsMaterial).dispose();
  }
  group.removeFromParent();
}

export function spaceScene(host: HTMLDivElement, labelLayer: HTMLDivElement, callbacks: SceneCallbacks) {
  const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setClearColor("#05070b");
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "Interactive 3D view of the Moon, the Sun and Earth");
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 1, FAR_KM);
  const shared = sharedUniforms();
  let disposed = false;
  let frameRequested = false;
  function invalidate() {
    if (frameRequested || disposed) return;
    frameRequested = true;
    requestAnimationFrame(frame);
  }

  const tiles = new TileTree(shared, Math.min(4, renderer.capabilities.getMaxAnisotropy()), invalidate);
  scene.add(tiles.group);
  const groundKm = (unit: Vector3) => tiles.heightAt(unit) * shared.uExaggeration.value;
  const rig = new CameraRig(camera, renderer.domElement, groundKm, invalidate);

  // The Sun and Earth at their true sizes and distances; the glows only help to find them.
  const sun = new Mesh(new SphereGeometry(SUN_RADIUS_KM, 32, 16), new MeshBasicMaterial({ color: "#fff4cf" }));
  const earth = new Mesh(new SphereGeometry(EARTH_RADIUS_KM, 48, 24), new MeshLambertMaterial({ color: "#4a86d8" }));
  const sunGlow = glow("#ffe9a8", 0.075);
  const earthGlow = glow("#7fb6ff", 0.06);
  const sunlight = new DirectionalLight("#ffffff", 3);
  const bodies = new Group();
  bodies.add(sun, sunGlow, earth, earthGlow, sunlight, new AmbientLight("#ffffff", 0.05));
  bodies.visible = false;
  scene.add(bodies);

  // Sky positions glide from the previous timeline step to the next one.
  const sky = { from: { sun: new Vector3(), earth: new Vector3() }, to: { sun: new Vector3(), earth: new Vector3() }, startedAt: 0, known: false };
  let sunShading = true;
  function advanceSky(now: number) {
    if (!sky.known) return false;
    const progress = Math.min(1, (now - sky.startedAt) / SKY_GLIDE_MS);
    sun.position.lerpVectors(sky.from.sun, sky.to.sun, progress);
    earth.position.lerpVectors(sky.from.earth, sky.to.earth, progress);
    sunGlow.position.copy(sun.position);
    earthGlow.position.copy(earth.position);
    shared.uSunDirection.value.copy(sun.position).normalize();
    // Earth is lit from the Sun's direction as seen from Earth.
    sunlight.position.subVectors(sun.position, earth.position).normalize();
    return progress < 1;
  }

  function makeLabel(className: string, text: string, onClick: () => void): Label {
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
    labelLayer.appendChild(element);
    return { element, arrow, position: new Vector3() };
  }
  const sunLabel = makeLabel("body sun", "Sun", () => rig.faceToward(sun.position.clone().sub(camera.position)));
  const earthLabel = makeLabel("body earth", "Earth", () => rig.faceToward(earth.position.clone().sub(camera.position)));
  let siteLabels: (Label & { up: Vector3 })[] = [];

  const inCamera = new Vector3();
  const closestPoint = new Vector3();
  /** Put a label at its body, or on the edge of the view pointing toward it when out of sight. */
  function placeBody(label: Label, body: Vector3, width: number, height: number) {
    label.element.hidden = !sky.known;
    if (!sky.known) return;

    inCamera.copy(body).applyMatrix4(camera.matrixWorldInverse);
    const half = Math.tan(camera.fov * Math.PI / 360);
    const inFront = inCamera.z < 0;
    let x = inFront ? (inCamera.x / (-inCamera.z * half * camera.aspect) + 1) / 2 * width : 0;
    let y = inFront ? (1 - inCamera.y / (-inCamera.z * half)) / 2 * height : 0;
    const margin = 34;
    const onScreen = inFront && x >= margin && x <= width - margin && y >= margin && y <= height - margin;
    if (!onScreen) {
      // Slide along the line from the screen centre toward the body until the edge is reached.
      const dx = inCamera.x;
      const dy = -inCamera.y;
      const reach = Math.min((width / 2 - margin) / Math.max(1e-9, Math.abs(dx)), (height / 2 - margin) / Math.max(1e-9, Math.abs(dy)));
      x = width / 2 + dx * reach;
      y = height / 2 + dy * reach;
      label.arrow.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    }

    // Hidden by the Moon when the sight line dips below the ground at its closest approach
    // to the Moon's centre: ‖c + t·v‖ < R + h, with t = −c·v.
    const toBody = inCamera.copy(body).sub(camera.position).normalize();
    const along = -camera.position.dot(toBody);
    const closest = closestPoint.copy(camera.position).addScaledVector(toBody, along);
    const closestRadius = closest.length();
    const behindMoon = along > 0 && closestRadius < MOON_RADIUS_KM + groundKm(closest.normalize());
    label.element.classList.toggle("off-screen", !onScreen);
    label.element.classList.toggle("behind", behindMoon);
    label.element.style.transform = `translate(${x}px, ${y}px)`;
  }

  function placeLabels() {
    const width = host.clientWidth;
    const height = host.clientHeight;
    placeBody(sunLabel, sun.position, width, height);
    placeBody(earthLabel, earth.position, width, height);

    const half = Math.tan(camera.fov * Math.PI / 360);
    for (const label of siteLabels) {
      label.position.copy(label.up).multiplyScalar(MOON_RADIUS_KM + groundKm(label.up));
      // A ground point faces the camera when the camera is above its level plane.
      const facing = inCamera.copy(camera.position).sub(label.position).dot(label.up) > -2;
      inCamera.copy(label.position).applyMatrix4(camera.matrixWorldInverse);
      const x = (inCamera.x / (-inCamera.z * half * camera.aspect) + 1) / 2 * width;
      const y = (1 - inCamera.y / (-inCamera.z * half)) / 2 * height;
      const shown = facing && inCamera.z < 0 && x > 0 && x < width && y > 0 && y < height;
      label.element.hidden = !shown;
      if (shown) label.element.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  let rays: ShownRays | null = null;
  let rayShow = { sun: false, earth: false };
  let fans: Group[] = [];
  function rebuildRays() {
    fans.forEach(disposeFan);
    fans = [];
    if (!rays) return;
    if (rayShow.sun) {
      const sources = rays.sun;
      const opacity = sources.length > 1 ? 0.55 : 0.9;
      for (const fan of sources) fans.push(rayFan(fan, rayColours.sun, rayColours.sunBlocked, shared.uExaggeration.value, opacity));
    }
    if (rayShow.earth) {
      const sources = rays.earth;
      const opacity = sources.length > 1 ? 0.55 : 0.9;
      for (const fan of sources) fans.push(rayFan(fan, rayColours.earth, rayColours.earthBlocked, shared.uExaggeration.value, opacity));
    }
    if (fans.length) scene.add(...fans);
  }

  let lastProblem: string | null = null;
  function frame(now: number) {
    frameRequested = false;
    if (disposed || !host.clientWidth || !host.clientHeight) return;

    let moving = rig.advance(now);
    moving = advanceSky(now) || moving;
    const view = rig.apply();
    const more = tiles.update(camera, host.clientHeight);
    placeLabels();
    renderer.render(scene, camera);
    callbacks.onView(view);
    if (tiles.problem !== lastProblem) {
      lastProblem = tiles.problem;
      callbacks.onProblem(lastProblem);
    }
    if (moving || more) invalidate();
  }

  function resize() {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    invalidate();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  // Start, and reset, on the south pole with longitude 0 up the screen, as on the 2D map.
  rig.up.set(0, 0, -1);
  rig.forward.set(1, 0, 0);
  rig.distanceKm = POLE_VIEW_KM;
  resize();

  let overlayTexture: CanvasTexture | null = null;
  return {
    setSites(sites: SceneSite[], selectedId: string | null) {
      for (const label of siteLabels) label.element.remove();
      siteLabels = sites.map((site) => {
        const up = latLonToUnit(site.latitude_deg, site.longitude_deg, new Vector3());
        const label = makeLabel(site.id === selectedId ? "site selected" : "site", site.name, () => callbacks.onSelect(site.id));
        return { ...label, up };
      });
      tiles.setSites(sites.map((site) => ({
        centre: latLonToUnit(site.latitude_deg, site.longitude_deg, new Vector3()).multiplyScalar(MOON_RADIUS_KM),
        radiusKm: site.radius_m / 1000,
        selected: site.id === selectedId,
      })));
      invalidate();
    },

    /** Moon-centred Sun and Earth positions for the timeline's time, or null when unknown. */
    setSky(next: Sky | null) {
      if (!next) {
        sky.known = false;
      } else {
        const first = !sky.known;
        sky.to.sun.set(...next.sunKm);
        sky.to.earth.set(...next.earthKm);
        // Glide from wherever the bodies are now; the first position is shown at once.
        sky.from.sun.copy(first ? sky.to.sun : sun.position);
        sky.from.earth.copy(first ? sky.to.earth : earth.position);
        sky.startedAt = performance.now();
        sky.known = true;
      }
      bodies.visible = sky.known;
      shared.uSunShading.value = sunShading && sky.known ? 1 : 0;
      invalidate();
    },

    setSunShading(on: boolean) {
      sunShading = on;
      shared.uSunShading.value = on && sky.known ? 1 : 0;
      invalidate();
    },

    setExaggeration(value: number) {
      shared.uExaggeration.value = value;
      rebuildRays();
      invalidate();
    },

    /** Drape the simulation's result grid over its site, or remove it with null. */
    setResultGrid(grid: ResultGrid | null) {
      overlayTexture?.dispose();
      overlayTexture = null;
      if (grid) {
        overlayTexture = new CanvasTexture(grid.canvas);
        overlayTexture.colorSpace = SRGBColorSpace;
        overlayTexture.magFilter = overlayTexture.minFilter = NearestFilter;
        overlayTexture.generateMipmaps = false;
        const { east, north, up } = siteAxes(grid.site.latitude_deg, grid.site.longitude_deg);
        shared.uSiteEast.value.copy(east);
        shared.uSiteNorth.value.copy(north);
        shared.uOverlayHalfKm.value = grid.halfWidthM / 1000;
        tiles.setOverlay({ centre: up.multiplyScalar(MOON_RADIUS_KM), halfKm: grid.halfWidthM / 1000 });
      } else {
        tiles.setOverlay(null);
      }
      shared.uOverlay.value = overlayTexture;
      invalidate();
    },

    setRays(next: ShownRays | null, show: { sun: boolean; earth: boolean }) {
      rays = next;
      rayShow = show;
      rebuildRays();
      invalidate();
    },

    showPole() {
      rig.flyTo({ up: new Vector3(0, 0, -1), forward: new Vector3(1, 0, 0), distanceKm: POLE_VIEW_KM, tilt: 0 });
    },
    showSite(site: SiteSpec) {
      const up = latLonToUnit(site.latitude_deg, site.longitude_deg, new Vector3());
      rig.flyTo({ up, distanceKm: Math.max(2.5, site.radius_m / 1000 * 7), tilt: 0.95 });
    },
    standAt(site: SiteSpec, eyeHeightM: number) {
      rig.eyeHeightKm = eyeHeightM / 1000;
      rig.standAt(latLonToUnit(site.latitude_deg, site.longitude_deg, new Vector3()));
    },
    leaveStand() {
      rig.leaveStand();
    },
    invalidate,

    dispose() {
      disposed = true;
      observer.disconnect();
      rig.dispose();
      fans.forEach(disposeFan);
      tiles.dispose();
      overlayTexture?.dispose();
      for (const body of [sun, earth]) {
        body.geometry.dispose();
        body.material.dispose();
      }
      for (const sprite of [sunGlow, earthGlow]) {
        sprite.material.map?.dispose();
        sprite.material.dispose();
      }
      labelLayer.replaceChildren();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export type SpaceScene = ReturnType<typeof spaceScene>;
