import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from "three";
import { CAP_RADIUS_KM, MOON_RADIUS_KM } from "./geodesy";
import { CELLS, PADDED, SIDE } from "./tile";
import type { Tile, TileMesh } from "./tile";
import { terrainMaterial } from "./terrainMaterial";
import type { SharedUniforms } from "./terrainMaterial";

/** Vertices of a tile: the node grid plus a skirt copy of each of its four edges. */
const VERTICES = SIDE * SIDE + 4 * SIDE;
/** Heights fade to the reference sphere over this distance before the 60°S edge of the data. */
const EDGE_FADE_KM = 60;
/** How far the skirt hangs below a tile's edge, as a share of the tile's ground width. */
const SKIRT_DEPTH = 0.025;

/** Where the nodes of a tile lie and how high the ground is at each. */
type TileNodes = {
  /** Unit directions of every padded node, three numbers each. */
  directions: Float64Array;
  /** Heights in km per padded node, or null for a smooth sphere. */
  heights: Float32Array | null;
  lowestKm: number;
  highestKm: number;
};

/** The vertex data of one tile, ready to become geometry. */
type TileAttributes = {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  elevations: Float32Array;
};

/** Triangles of the node grid plus a downward skirt along each edge; shared by every tile. */
export function tileIndex() {
  const index = new Uint16Array((CELLS * CELLS + 4 * CELLS) * 6);
  let offset = 0;

  for (let row = 0; row < CELLS; row++) {
    for (let column = 0; column < CELLS; column++) {
      const corner = row * SIDE + column;
      index.set([corner, corner + SIDE, corner + 1, corner + 1, corner + SIDE, corner + SIDE + 1], offset);
      offset += 6;
    }
  }

  const skirt = SIDE * SIDE;
  for (let k = 0; k < CELLS; k++) {
    const edges = [
      [k, k + 1, skirt + k],
      [CELLS * SIDE + k, CELLS * SIDE + k + 1, skirt + SIDE + k],
      [k * SIDE, (k + 1) * SIDE, skirt + 2 * SIDE + k],
      [k * SIDE + CELLS, (k + 1) * SIDE + CELLS, skirt + 3 * SIDE + k],
    ];

    for (const [first, second, below] of edges) {
      index.set([first, below, second, second, below, below + 1], offset);
      offset += 6;
    }
  }
  return new BufferAttribute(index, 1);
}

/**
 * The drawable mesh of a tile. `heightsM` are the API's heights in metres on the padded grid, or
 * null for a tile that lies on the smooth reference sphere. Returns the mesh and the tile's
 * height range so the caller can record them.
 */
export function createTileMesh(tile: Tile, heightsM: Float32Array | null, index: BufferAttribute, shared: SharedUniforms) {
  const nodes = sampleNodes(tile, heightsM);
  const attributes = buildAttributes(tile, nodes);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(attributes.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(attributes.normals, 3));
  geometry.setAttribute("uv", new BufferAttribute(attributes.uvs, 2));
  geometry.setAttribute("aHeight", new BufferAttribute(attributes.elevations, 1));
  geometry.setIndex(index);

  const mesh: TileMesh = new Mesh(geometry, terrainMaterial(shared, tile.grid, tile.centre));
  mesh.position.copy(tile.centre);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  // Tiles are culled by the tile tree, with their relief; the vertex shader moves them anyway.
  mesh.frustumCulled = false;
  mesh.visible = false;

  return { mesh, heights: nodes.heights, lowestKm: nodes.lowestKm, highestKm: nodes.highestKm };
}

/** Smoothstep: 0 at or below 0, 1 at or above 1. */
function smooth(t: number) {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

function sampleNodes(tile: Tile, heightsM: Float32Array | null): TileNodes {
  const directions = new Float64Array(PADDED * PADDED * 3);
  const heights = heightsM && new Float32Array(PADDED * PADDED);
  const direction = new Vector3();
  let lowestKm = Infinity;
  let highestKm = -Infinity;

  for (let row = 0; row < PADDED; row++) {
    for (let column = 0; column < PADDED; column++) {
      const node = row * PADDED + column;
      tile.direction((column - 1) / CELLS, (row - 1) / CELLS, direction).toArray(directions, node * 3);
      if (!heights || !heightsM) continue;

      const x = tile.west + (column - 1) / CELLS * tile.size;
      const y = tile.north - (row - 1) / CELLS * tile.size;

      // Edge fade: h' = h·f, f = smoothstep((ρ_cap − ρ)/F)
      //   h - Height from the API, in km; ρ - Projected distance from the pole, in km.
      //   ρ_cap - Projected radius of the 60°S edge of the data, in km; F - fade width, in km.
      //   Assumption: nodes without data sit on the reference sphere, and the relief fades to it
      //   before the data ends so the cap meets the smooth globe without a cliff.
      const fade = smooth((CAP_RADIUS_KM - Math.hypot(x, y)) / EDGE_FADE_KM);
      const height = Number.isFinite(heightsM[node]) ? heightsM[node] / 1000 * fade : 0;

      heights[node] = height;
      lowestKm = Math.min(lowestKm, height);
      highestKm = Math.max(highestKm, height);
    }
  }
  return { directions, heights, lowestKm, highestKm };
}

function buildAttributes(tile: Tile, nodes: TileNodes): TileAttributes {
  const { directions, heights } = nodes;
  const attributes: TileAttributes = {
    positions: new Float32Array(VERTICES * 3),
    normals: new Float32Array(VERTICES * 3),
    uvs: new Float32Array(VERTICES * 2),
    elevations: new Float32Array(VERTICES),
  };

  for (let row = 0; row < SIDE; row++) {
    for (let column = 0; column < SIDE; column++) {
      const node = (row + 1) * PADDED + column + 1;
      const vertex = row * SIDE + column;

      for (let axis = 0; axis < 3; axis++) {
        // Positions are relative to the tile centre, which keeps them exact in 32-bit floats.
        attributes.positions[vertex * 3 + axis] = directions[node * 3 + axis] * MOON_RADIUS_KM - tile.centre.getComponent(axis);
      }
      attributes.uvs[vertex * 2] = column / CELLS;
      attributes.uvs[vertex * 2 + 1] = row / CELLS;

      if (heights) attributes.elevations[vertex] = heights[node];
      surfaceNormal(directions, heights, node).toArray(attributes.normals, vertex * 3);
    }
  }

  addSkirt(attributes, tile.widthKm * SKIRT_DEPTH);
  return attributes;
}

const normal = new Vector3();

/** Unit surface normal at a padded node: radial on a smooth sphere, tilted by the local slope on terrain. */
function surfaceNormal(directions: Float64Array, heights: Float32Array | null, node: number) {
  normal.fromArray(directions, node * 3);
  if (!heights) return normal;

  // Height-field normal from central differences across neighbouring nodes:
  //   n ∝ r − g_E·ê − g_N·n̂; g = Δh/(R·‖Δr‖)
  //   r - Unit radial direction; ê, n̂ - unit ground directions toward the east and
  //   north neighbours; Δh - height difference between opposite neighbours, in km;
  //   R·‖Δr‖ - ground distance between them, in km; g - dimensionless slope.
  for (const [ahead, behind] of [[node + 1, node - 1], [node - PADDED, node + PADDED]]) {
    const ax = directions[ahead * 3] - directions[behind * 3];
    const ay = directions[ahead * 3 + 1] - directions[behind * 3 + 1];
    const az = directions[ahead * 3 + 2] - directions[behind * 3 + 2];

    const span = ax * ax + ay * ay + az * az;
    const slope = (heights[ahead] - heights[behind]) / (MOON_RADIUS_KM * span);

    normal.x -= slope * ax;
    normal.y -= slope * ay;
    normal.z -= slope * az;
  }
  return normal.normalize();
}

/**
 * A copy of each edge pushed below the surface, hiding hairline gaps between neighbouring tiles
 * of different detail. Copies follow the node grid: top, bottom, left, then right edge.
 */
function addSkirt(attributes: TileAttributes, depthKm: number) {
  const edgeVertex = [
    (k: number) => k,
    (k: number) => CELLS * SIDE + k,
    (k: number) => k * SIDE,
    (k: number) => k * SIDE + CELLS,
  ];

  edgeVertex.forEach((vertexOf, edge) => {
    for (let k = 0; k < SIDE; k++) {
      const from = vertexOf(k);
      const to = SIDE * SIDE + edge * SIDE + k;

      attributes.positions.copyWithin(to * 3, from * 3, from * 3 + 3);
      attributes.normals.copyWithin(to * 3, from * 3, from * 3 + 3);
      attributes.uvs.copyWithin(to * 2, from * 2, from * 2 + 2);
      attributes.elevations[to] = attributes.elevations[from] - depthKm;
    }
  });
}
