import { Color, DoubleSide, ShaderMaterial, Vector3, Vector4 } from "three";
import type { Texture } from "three";
import { CAP_LATITUDE_DEG, MOON_RADIUS_KM } from "./geodesy";

/** Site circles one tile can draw. Sites are small, so few ever share a tile. */
export const RING_LIMIT = 8;
/** The NAC mosaic holds data inside this stereographic radius (85.5°S), fading out at its edge. */
export const DETAIL_RADIUS_KM = 136.526;
const DETAIL_FEATHER_KM = 6;

/** Values every tile shares. Changing one here changes it for the whole Moon. */
export type SharedUniforms = ReturnType<typeof sharedUniforms>;

export function sharedUniforms() {
  return {
    // Vertical exaggeration of the relief; 1 is true scale.
    uExaggeration: { value: 1 },
    // Unit Moon-fixed direction to the Sun, and whether it lights the terrain (1) or not (0).
    uSunDirection: { value: new Vector3(1, 0, 0) },
    uSunShading: { value: 0 },
    // The simulation's result grid for one site, drawn on the ground around `uOverlayOffset`.
    uOverlay: { value: null as Texture | null },
    uOverlayOpacity: { value: 0.62 },
    uOverlayHalfKm: { value: 1 },
    uSiteEast: { value: new Vector3(1, 0, 0) },
    uSiteNorth: { value: new Vector3(0, 1, 0) },
    uRingColour: { value: new Color("#dde4ea") },
    uSelectedRingColour: { value: new Color("#a2e0d4") },
  };
}

const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform vec3 uCentre;
uniform float uExaggeration;
attribute float aHeight;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSphere;

void main() {
  // Radial displacement: p = p₀ + k·h·r
  //   p₀ (position) - Point on the reference sphere, relative to the tile centre, in km.
  //   r (radial) - Unit radial direction; h (aHeight) - height above the sphere, in km.
  //   k (uExaggeration) - Dimensionless vertical exaggeration.
  vec3 radial = normalize(position + uCentre);
  vec3 displaced = position + radial * (aHeight * uExaggeration);

  // Normal of an exaggerated height field: n_k ∝ k·(n − (n·r)r) + (n·r)r
  //   n (normal) - True-scale unit surface normal; its tangential part grows with k.
  float upward = dot(normal, radial);
  vNormal = uExaggeration * (normal - upward * radial) + upward * radial;

  vUv = uv;
  vSphere = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uCentre;
uniform int uKind;
uniform sampler2D uBase;
uniform vec4 uBaseUv;
uniform float uHasBase;
uniform sampler2D uDetail;
uniform vec4 uDetailUv;
uniform float uDetailMix;
uniform vec3 uSunDirection;
uniform float uSunShading;
uniform sampler2D uOverlay;
uniform float uOverlayOn;
uniform float uOverlayOpacity;
uniform float uOverlayHalfKm;
uniform vec3 uOverlayOffset;
uniform vec3 uSiteEast;
uniform vec3 uSiteNorth;
uniform vec4 uRings[RING_LIMIT];
uniform int uRingCount;
uniform int uSelectedRing;
uniform vec3 uRingColour;
uniform vec3 uSelectedRingColour;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSphere;

void main() {
  #include <logdepthbuf_fragment>

  // The polar tiles (kind 0) own everything south of the cap latitude and the global
  // tiles (kind 1) everything north of it, so the two meet in one clean line.
  vec3 radial = normalize(vSphere + uCentre);
  if (uKind == 0 ? radial.z > CAP_SINE : radial.z < CAP_SINE) discard;

  vec3 colour = vec3(0.1);
  if (uHasBase > 0.5) colour = texture2D(uBase, uBaseUv.xy + vUv * uBaseUv.zw).rgb;
  if (uDetailMix > 0.0) {
    // Stereographic radius: ρ = 2R·√(r_x² + r_y²)/(1 − r_z), in km.
    // Smoothstep fade to the edge of the sharp mosaic: w = t²(3 − 2t), t = (R_d − ρ)/F.
    float rho = 2.0 * MOON_RADIUS_KM * length(radial.xy) / (1.0 - radial.z);
    float t = clamp((DETAIL_RADIUS_KM - rho) / DETAIL_FEATHER_KM, 0.0, 1.0);
    vec4 detail = texture2D(uDetail, uDetailUv.xy + vUv * uDetailUv.zw);
    colour = mix(colour, detail.rgb, detail.a * uDetailMix * t * t * (3.0 - 2.0 * t));
  }

  // Shading is for reading the relief only: no shadows are cast here. Sunlit and shadowed
  // ground comes from the simulation's grid, drawn below.
  vec3 normal = normalize(vNormal);
  float sunlit = 0.2 + 0.95 * pow(max(dot(normal, uSunDirection), 0.0), 0.45);
  float even = 0.55 + 0.45 * pow(max(dot(normal, radial), 0.0), 6.0);
  colour *= mix(even, sunlit, uSunShading);

  if (uOverlayOn > 0.5) {
    // East and north offsets from the site centre, as fractions of the grid's width.
    vec3 fromSite = vSphere - uOverlayOffset;
    vec2 cell = vec2(dot(fromSite, uSiteEast), dot(fromSite, uSiteNorth)) / (2.0 * uOverlayHalfKm) + 0.5;
    if (cell.x >= 0.0 && cell.x <= 1.0 && cell.y >= 0.0 && cell.y <= 1.0) {
      vec4 result = texture2D(uOverlay, cell);
      colour = mix(colour, result.rgb, result.a * uOverlayOpacity);
    }
  }

  for (int index = 0; index < RING_LIMIT; index++) {
    if (index >= uRingCount) break;
    // A line about 1.5 pixels wide where the distance from the site centre equals its radius.
    float fromCentre = distance(vSphere, uRings[index].xyz);
    float pixel = max(fwidth(fromCentre), 1e-7);
    float line = 1.0 - smoothstep(0.75 * pixel, 1.75 * pixel, abs(fromCentre - uRings[index].w));
    colour = mix(colour, index == uSelectedRing ? uSelectedRingColour : uRingColour, line * 0.95);
  }

  gl_FragColor = vec4(colour, 1.0);
  #include <colorspace_fragment>
}
`;

/** The material of one terrain tile: its photos, its place on the Moon and nearby sites. */
export function terrainMaterial(shared: SharedUniforms, kind: "polar" | "global", centre: Vector3) {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: DoubleSide,
    defines: {
      RING_LIMIT,
      MOON_RADIUS_KM: MOON_RADIUS_KM.toFixed(1),
      CAP_SINE: Math.sin(CAP_LATITUDE_DEG * Math.PI / 180).toFixed(8),
      DETAIL_RADIUS_KM: DETAIL_RADIUS_KM.toFixed(3),
      DETAIL_FEATHER_KM: DETAIL_FEATHER_KM.toFixed(1),
    },
    uniforms: {
      ...shared,
      uCentre: { value: centre },
      uKind: { value: kind === "polar" ? 0 : 1 },
      uBase: { value: null as Texture | null },
      // Photo address of a tile corner and extent: uv = offset.xy + tileUv × scale.zw.
      uBaseUv: { value: new Vector4(0, 0, 1, 1) },
      uHasBase: { value: 0 },
      uDetail: { value: null as Texture | null },
      uDetailUv: { value: new Vector4(0, 0, 1, 1) },
      uDetailMix: { value: 0 },
      uOverlayOn: { value: 0 },
      uOverlayOffset: { value: new Vector3() },
      uRings: { value: Array.from({ length: RING_LIMIT }, () => new Vector4()) },
      uRingCount: { value: 0 },
      uSelectedRing: { value: -1 },
    },
  });
}
