import { CanvasTexture, NearestFilter, PerspectiveCamera, SRGBColorSpace, Scene, Vector3, WebGLRenderer } from "three";
import type { SiteSpec } from "../../api/types";
import { CameraRig } from "./cameraRig";
import type { RigView } from "./cameraRig";
import { MOON_RADIUS_KM, latLonToUnit, siteAxes } from "./geodesy";
import { RayLayer } from "./rayLayer";
import type { RayToggles } from "./rayLayer";
import { SceneLabels } from "./sceneLabels";
import type { LabelSite } from "./sceneLabels";
import { SkyBodies } from "./skyBodies";
import type { Sky } from "./skyBodies";
import { sharedUniforms } from "./terrainMaterial";
import { TileTree } from "./tiles";
import type { ShownRays } from "./useSiteRays";

/** Camera distance of the south-pole view: the Moon's disk fills the screen. */
const POLE_VIEW_KM = 4200;
/** Far enough to hold the Sun, 150 million km away. */
const FAR_KM = 4e8;
const MAX_ANISOTROPY = 4;

export type SceneSite = LabelSite;
export type { Sky };

/** The simulation's result grid as a picture, and how far it reaches from its site's centre. */
export type ResultGrid = { site: SiteSpec; canvas: HTMLCanvasElement; halfWidthM: number };

export type SceneCallbacks = {
  onView: (view: RigView) => void;
  onSelect: (id: string) => void;
  onProblem: (message: string | null) => void;
};

/**
 * The 3D view of the Moon, the Sun and Earth: owns the renderer, the camera and the frame loop,
 * and coordinates the tiles, sky bodies, rays and labels. React talks to it only through the
 * returned methods.
 */
export function spaceScene(host: HTMLDivElement, labelLayer: HTMLDivElement, callbacks: SceneCallbacks) {
  const renderer = createRenderer(host);
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 1, FAR_KM);
  const shared = sharedUniforms();

  let disposed = false;
  let frameRequested = false;
  let lastProblem: string | null = null;
  let sunShading = true;
  let rays: ShownRays | null = null;
  let rayToggles: RayToggles = { sun: false, earth: false };
  let overlayTexture: CanvasTexture | null = null;

  function invalidate() {
    if (frameRequested || disposed) return;

    frameRequested = true;
    requestAnimationFrame(frame);
  }

  const tiles = new TileTree(shared, Math.min(MAX_ANISOTROPY, renderer.capabilities.getMaxAnisotropy()), invalidate);
  scene.add(tiles.group);

  const groundKm = (unit: Vector3) => tiles.heightAt(unit) * shared.uExaggeration.value;
  const rig = new CameraRig(camera, renderer.domElement, groundKm, invalidate);
  const sky = new SkyBodies(scene, shared.uSunDirection.value);
  const rayLayer = new RayLayer(scene);

  const labels = new SceneLabels(labelLayer, camera, groundKm, {
    onFaceBody: (body) => rig.faceToward((body === "sun" ? sky.sun : sky.earth).position.clone().sub(camera.position)),
    onSelectSite: callbacks.onSelect,
  });

  function frame(now: number) {
    frameRequested = false;
    if (disposed || !host.clientWidth || !host.clientHeight) return;

    const moving = rig.advance(now) || sky.advance(now);
    const view = rig.apply();
    const needsMoreTiles = tiles.update(camera, host.clientHeight);

    labels.place(host.clientWidth, host.clientHeight, sky);
    renderer.render(scene, camera);
    callbacks.onView(view);

    if (tiles.problem !== lastProblem) {
      lastProblem = tiles.problem;
      callbacks.onProblem(lastProblem);
    }
    if (moving || needsMoreTiles) invalidate();
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

  // Start on the south pole with longitude 0 up the screen, as on the 2D map.
  rig.up.set(0, 0, -1);
  rig.forward.set(1, 0, 0);
  rig.distanceKm = POLE_VIEW_KM;
  resize();

  function applyResultGrid(grid: ResultGrid | null) {
    overlayTexture?.dispose();
    overlayTexture = null;

    if (!grid) {
      tiles.setOverlay(null);
      shared.uOverlay.value = null;
      return;
    }

    overlayTexture = new CanvasTexture(grid.canvas);
    overlayTexture.colorSpace = SRGBColorSpace;
    overlayTexture.magFilter = overlayTexture.minFilter = NearestFilter;
    overlayTexture.generateMipmaps = false;

    const { east, north, up } = siteAxes(grid.site.latitude_deg, grid.site.longitude_deg);
    const halfKm = grid.halfWidthM / 1000;
    shared.uSiteEast.value.copy(east);
    shared.uSiteNorth.value.copy(north);
    shared.uOverlayHalfKm.value = halfKm;

    tiles.setOverlay({ centre: up.multiplyScalar(MOON_RADIUS_KM), halfKm });
    shared.uOverlay.value = overlayTexture;
  }

  return {
    setSites(sites: SceneSite[], selectedId: string | null) {
      labels.setSites(sites, selectedId);

      tiles.setSites(sites.map((site) => ({
        centre: latLonToUnit(site.latitude_deg, site.longitude_deg, new Vector3()).multiplyScalar(MOON_RADIUS_KM),
        radiusKm: site.radius_m / 1000,
        selected: site.id === selectedId,
      })));
      invalidate();
    },

    /** Moon-centred Sun and Earth positions for the timeline's time, or null when unknown. */
    setSky(next: Sky | null) {
      sky.setSky(next);
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
      rayLayer.update(rays, rayToggles, value);
      invalidate();
    },

    /** Drape the simulation's result grid over its site, or remove it with null. */
    setResultGrid(grid: ResultGrid | null) {
      applyResultGrid(grid);
      invalidate();
    },

    setRays(next: ShownRays | null, show: RayToggles) {
      rays = next;
      rayToggles = show;
      rayLayer.update(rays, rayToggles, shared.uExaggeration.value);
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
      rayLayer.dispose();
      tiles.dispose();
      sky.dispose();
      labels.dispose();
      overlayTexture?.dispose();

      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export type SpaceScene = ReturnType<typeof spaceScene>;

function createRenderer(host: HTMLElement) {
  const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setClearColor("#05070b");
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "Interactive 3D view of the Moon, the Sun and Earth");
  host.appendChild(renderer.domElement);
  return renderer;
}
