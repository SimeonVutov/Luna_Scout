import {
  BufferAttribute, BufferGeometry, Color, DirectionalLight, HemisphereLight,
  LineBasicMaterial, LineSegments, Mesh, MeshLambertMaterial, PerspectiveCamera,
  Scene, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SunlightGrid, TerrainPreview } from "../../api/types";
import { MOON_RADIUS_M } from "../globe/sunlightOverlay";
import { sunlightClass, sunlightColors } from "../results/sunlightColors";

const metresPerUnit = 1000;

function position(east: number, north: number, height: number, datum: number) {
  const arc = Math.hypot(east, north) / MOON_RADIUS_M;
  const radius = MOON_RADIUS_M + height;
  const tangentScale = radius / MOON_RADIUS_M * (arc ? Math.sin(arc) / arc : 1);
  const up = height - datum - 2 * radius * Math.sin(arc / 2) ** 2;
  return [east * tangentScale / metresPerUnit, up / metresPerUnit, -north * tangentScale / metresPerUnit];
}

function elevationAt(data: TerrainPreview, east: number, north: number) {
  const axis = data.offsets_m;
  const size = axis.length;
  const step = axis[1] - axis[0];
  const x = (east - axis[0]) / step;
  const y = (north - axis[0]) / step;
  if (x < 0 || y < 0 || x > size - 1 || y > size - 1) return null;

  const col = Math.min(size - 2, Math.floor(x));
  const row = Math.min(size - 2, Math.floor(y));
  const s = x - col;
  const t = y - row;
  const h = row * size + col;
  const southEast = data.heights_m[h + 1];
  const northWest = data.heights_m[h + size];
  if (southEast === null || northWest === null) return null;

  if (s + t <= 1) {
    const southWest = data.heights_m[h];
    return southWest === null ? null : southWest * (1 - s - t) + southEast * s + northWest * t;
  }
  const northEast = data.heights_m[h + size + 1];
  return northEast === null ? null : northEast * (s + t - 1) + southEast * (1 - t) + northWest * (1 - s);
}

function footprintOutline(data: TerrainPreview, radius: number, datum: number) {
  const points: number[] = [];
  const segments = 240;
  let previous: number[] | null = null;
  for (let index = 0; index <= segments; index++) {
    const angle = Math.PI * 2 * index / segments;
    const east = Math.cos(angle) * radius;
    const north = Math.sin(angle) * radius;
    const height = elevationAt(data, east, north);
    const next = height === null ? null : position(east, north, height + 2, datum);
    if (previous && next) points.push(...previous, ...next);
    previous = next;
  }
  return new LineSegments(
    new BufferGeometry().setAttribute("position", new BufferAttribute(new Float32Array(points), 3)),
    new LineBasicMaterial({ color: 0x9af0d8 }),
  );
}

export function terrainScene(
  host: HTMLDivElement,
  data: TerrainPreview,
  siteRadius: number,
  onNorth: (angle: number) => void,
) {
  const scene = new Scene();
  scene.background = new Color("#0d1118");
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "Interactive lunar terrain");
  host.appendChild(renderer.domElement);

  const offsets = data.offsets_m;
  const size = offsets.length;
  const extent = offsets[size - 1] / metresPerUnit;
  const datum = data.center_height_m ?? data.heights_m.find((height) => height !== null) ?? 0;
  const heights = data.heights_m.filter((height): height is number => height !== null);
  const minimumHeight = Math.min(...heights);
  const heightRange = Math.max(1, Math.max(...heights) - minimumHeight);
  const positions = new Float32Array(size * size * 3);
  const indices: number[] = [];
  const colors = new Float32Array(positions.length);
  for (let index = 0; index < size * size; index++) {
    const row = Math.floor(index / size);
    const col = index % size;
    const height = data.heights_m[index];
    if (height !== null) positions.set(position(offsets[col], offsets[row], height, datum), index * 3);
    if (row === size - 1 || col === size - 1) continue;

    const east = index + 1;
    const north = index + size;
    const northEast = north + 1;
    if (data.heights_m[east] === null || data.heights_m[north] === null) continue;
    if (height !== null) indices.push(index, east, north);
    if (data.heights_m[northEast] !== null) indices.push(east, northEast, north);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  const colorAttribute = new BufferAttribute(colors, 3);
  geometry.setAttribute("color", colorAttribute);
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const surface = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true }));
  const outline = footprintOutline(data, siteRadius, datum);
  const fill = new HemisphereLight(0xdde9f7, 0x363b44, 1.0);
  const key = new DirectionalLight(0xffeedd, 2.2);
  key.position.set(-4, 1.6, 0.9);
  scene.add(surface, outline, fill, key);

  const camera = new PerspectiveCamera(45, 1, Math.max(0.002, extent / 800), extent * 25);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.zoomToCursor = true;
  controls.minDistance = extent * 0.04;
  controls.maxDistance = extent * 8;
  controls.maxTargetRadius = extent * 1.4;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.rotateSpeed = 0.65;
  controls.listenToKeyEvents(renderer.domElement);
  const north = new Vector3();

  function render() {
    if (!host.clientWidth || !host.clientHeight) return;
    north.set(0, 0, -1).applyQuaternion(camera.quaternion.clone().invert());
    onNorth(Math.atan2(north.x, north.y) * 180 / Math.PI);
    renderer.render(scene, camera);
  }

  function resize() {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    render();
  }

  function reset() {
    const fit = Math.max(1, 1.22 / camera.aspect);
    controls.target.set(0, 0, 0);
    camera.position.set(1.50 * extent * fit, 1.65 * extent * fit, 1.90 * extent * fit);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.update();
    render();
  }

  function paint(grid: SunlightGrid | null) {
    const low = new Color("#535f70");
    const high = new Color("#bbb7b5");
    const base = new Color();
    const tint = new Color();
    const axis = grid?.offsets_m;
    const step = axis && axis.length > 1 ? axis[1] - axis[0] : siteRadius * 2;
    for (let index = 0; index < size * size; index++) {
      const col = index % size;
      const row = Math.floor(index / size);
      const height = data.heights_m[index] ?? minimumHeight;
      base.lerpColors(low, high, (height - minimumHeight) / heightRange);
      tint.copy(base);
      if (grid && axis && axis.length) {
        const east = offsets[col];
        const northOffset = offsets[row];
        const x = Math.round((east - axis[0]) / step);
        const y = Math.round((northOffset - axis[0]) / step);
        if (Math.hypot(east, northOffset) <= siteRadius && x >= 0 && y >= 0 && x < axis.length && y < axis.length) {
          const category = sunlightClass(grid, y * axis.length + x);
          if (category) {
            const [red, green, blue] = sunlightColors[category];
            tint.setRGB(red / 255, green / 255, blue / 255, "srgb");
            tint.lerp(base, 0.15);
          }
        }
      }
      tint.toArray(colors, index * 3);
    }
    colorAttribute.needsUpdate = true;
    render();
  }

  controls.addEventListener("change", render);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  reset();
  paint(null);

  return {
    paint,
    reset,
    dispose() {
      observer.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      surface.geometry.dispose();
      surface.material.dispose();
      outline.geometry.dispose();
      outline.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
