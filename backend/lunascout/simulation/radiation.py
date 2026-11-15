"""Direct irradiance from a sampled solar disk and a spherical Earth limb."""

from dataclasses import dataclass
from math import pi, sqrt

import numpy as np
from numpy.typing import NDArray

from ..terrain import mesh
from ..terrain.horizon import HorizonMap, ray_visibility
from ..terrain.model import Terrain
from .frames import FloatArray

# IAU 2015 nominal solar radius and irradiance. The AU is exact in SI metres.
SUN_RADIUS_M = 695_700_000.0
SOLAR_IRRADIANCE_AT_AU_W_M2 = 1361.0
AU_M = 149_597_870_700.0
EARTH_MEAN_RADIUS_M = 6_371_008.8
_RAYS_PER_BATCH = 200_000


@dataclass(frozen=True)
class DiskSamples:
    """Equal-solid-angle directions across an apparent spherical disk.

    `directions` has shape (observers, samples, 3); `separation_cos` holds the
    cosine of each sample's angle from the disk centre, shape (observers, samples).
    """

    directions: FloatArray
    separation_cos: FloatArray
    distances_m: FloatArray


def direct_sunlight(
    terrain: Terrain,
    origins_m: FloatArray,
    normals: FloatArray,
    sun_m: FloatArray,
    earth_m: FloatArray,
    disk_samples: int,
    horizons: HorizonMap | None = None,
) -> tuple[FloatArray, FloatArray, FloatArray, FloatArray]:
    """Return lower/upper bounds on visible disk fraction and irradiance at each origin.

    `sun_m` and `earth_m` are Moon-fixed positions in metres, either shared (3,)
    or one per receiver (receivers, 3). A missing terrain intersection contributes
    only to the upper bound. The Earth is an opaque sphere for solar occultation,
    with no atmospheric transmission. With `horizons`, each ray is classified from
    the precomputed terrain horizon and only rays near it are traced exactly.
    """
    sun_positions_m = np.broadcast_to(sun_m, origins_m.shape)
    earth_positions_m = np.broadcast_to(earth_m, origins_m.shape)

    fractions_lower = np.empty(len(origins_m))
    fractions_upper = np.empty(len(origins_m))
    irradiance_lower = np.empty(len(origins_m))
    irradiance_upper = np.empty(len(origins_m))
    batch_size = max(1, _RAYS_PER_BATCH // disk_samples)
    for start in range(0, len(origins_m), batch_size):
        batch = slice(start, start + batch_size)
        origins = origins_m[batch]

        # Observer translation: v☉ = r☉ − x
        #   v☉ (sun_vectors_m) - Receiver-to-Sun vectors, Moon-fixed metres.
        #   r☉ (sun_positions_m) - Moon-centered Sun position, in metres.
        #   x (origins) - Receiver origins, in Moon-fixed metres.
        sun_vectors_m = sun_positions_m[batch] - origins
        disk = disk_directions(sun_vectors_m, SUN_RADIUS_M, disk_samples)

        if horizons is None:
            visibility = terrain.trace_rays(origins, disk.directions)
        else:
            visibility = ray_visibility(terrain, horizons, batch, origins, disk.directions)

        # Earth translation: vₑ = rₑ − x
        #   vₑ - Receiver-to-Earth vectors passed to the occultation solver, in metres.
        #   rₑ (earth_positions_m), x (origins) - Earth center and receiver positions, in metres.
        eclipsed = _earth_occultation_mask(
            earth_positions_m[batch] - origins, disk.directions, disk.distances_m
        )

        guaranteed = (visibility == mesh.CLEAR) & ~eclipsed
        possible = (visibility != mesh.BLOCKED) & ~eclipsed
        # Lambert cosine projection: cᵢⱼ = max(0, nᵢ · ωᵢⱼ)
        #   cᵢⱼ (incidence) - Dimensionless projected receiving factor.
        #   nᵢ (normals[batch]) - Unit receiver normal, Moon-fixed XYZ.
        #   ωᵢⱼ (disk.directions) - Unit ray direction, Moon-fixed XYZ.
        #   Arrays have receiver × ray axes; normals have receiver × XYZ axes.
        incidence = np.maximum(0, np.einsum("ni,nri->nr", normals[batch], disk.directions))

        # Inverse-square irradiance with finite-disk normalization:
        #   S = S₁ (AU/d)²; F = S / ⟨cos θ⟩
        #   S (sun_normal_flux) - Unobstructed Sun-facing flux, in W/m².
        #   S₁ (SOLAR_IRRADIANCE_AT_AU_W_M2) - IAU nominal flux, 1361 W/m².
        #   AU (AU_M) - Exact astronomical unit, in metres.
        #   d (disk.distances_m) - Receiver-to-Sun center distance, in metres.
        #   θ (disk.separation_cos) - Ray separation angle from the disk centre, in radians.
        #   F (flux_scale) - Quadrature flux scale, in W/m².
        sun_normal_flux = SOLAR_IRRADIANCE_AT_AU_W_M2 * (AU_M / disk.distances_m) ** 2
        flux_scale = sun_normal_flux / disk.separation_cos.mean(axis=1)

        # Equal-weight disk integration: f = Σⱼ Vⱼ/N; G = F Σⱼ(cⱼ Vⱼ)/N
        #   f (fractions_lower/upper) - Dimensionless visible solar fraction.
        #   G (irradiance_lower/upper) - Direct receiving flux, in W/m².
        #   F (flux_scale) - Disk-normalized unobstructed flux, in W/m².
        #   cⱼ (incidence) - Dimensionless receiving factor of ray j.
        #   Vⱼ (guaranteed/possible) - Clear-ray mask for each coverage bound.
        #   N (disk_samples) - Number of equal-weight rays, dimensionless.
        fractions_lower[batch] = guaranteed.mean(axis=1)
        fractions_upper[batch] = possible.mean(axis=1)
        irradiance_lower[batch] = np.mean(incidence * guaranteed, axis=1) * flux_scale
        irradiance_upper[batch] = np.mean(incidence * possible, axis=1) * flux_scale

    return fractions_lower, fractions_upper, irradiance_lower, irradiance_upper


def earth_visibility(
    terrain: Terrain,
    origins_m: FloatArray,
    earth_m: FloatArray,
    disk_samples: int,
    horizons: HorizonMap | None = None,
) -> tuple[FloatArray, FloatArray]:
    """Lower and upper bounds on the visible fraction of Earth's disk at each origin.

    `earth_m` is Earth's Moon-fixed position in metres. Earth's apparent disk is sampled
    with equal-solid-angle rays like the Sun's. Only terrain blocks it; this is geometric
    line of sight, not a radio link budget. With `horizons`, which must have been built for
    exactly these origins, rays are classified from the terrain horizon.
    """
    fractions_lower = np.empty(len(origins_m))
    fractions_upper = np.empty(len(origins_m))
    batch_size = max(1, _RAYS_PER_BATCH // disk_samples)
    for start in range(0, len(origins_m), batch_size):
        batch = slice(start, start + batch_size)
        origins = origins_m[batch]
        disk = disk_directions(earth_m[None, :] - origins, EARTH_MEAN_RADIUS_M, disk_samples)
        if horizons is None:
            visibility = terrain.trace_rays(origins, disk.directions)
        else:
            visibility = ray_visibility(terrain, horizons, batch, origins, disk.directions)

        # Equal-weight disk visibility: f₋ = Σⱼ[clearⱼ]/N; f₊ = Σⱼ[not blockedⱼ]/N
        #   f₋, f₊ - Dimensionless visible-disk bounds; unresolved rays count only in f₊.
        #   N (disk_samples) - Equal-solid-angle rays across Earth's apparent disk.
        fractions_lower[batch] = (visibility == mesh.CLEAR).mean(axis=1)
        fractions_upper[batch] = (visibility != mesh.BLOCKED).mean(axis=1)

    return fractions_lower, fractions_upper


def disk_directions(
    target_vectors_m: FloatArray, body_radius_m: float, sample_count: int
) -> DiskSamples:
    """Sample a spherical body's apparent disk with equal-solid-angle directions.

    `target_vectors_m` has shape (observers, 3) and points from each observer to
    the body's centre in Moon-fixed metres. One sample uses the disk centre.
    """
    # Equal-solid-angle golden-angle quadrature:
    #   fᵢ = (i + ½)/N; ψᵢ = iπ(3 − √5)
    #
    #   fᵢ (radii) - Dimensionless radial solid-angle fraction of sample i.
    #   i (sample_index) - Zero-based sample index, dimensionless.
    #   N (sample_count) - Number of equal-weight directions, dimensionless.
    #   ψᵢ (azimuth) - Sample angle around the disk-centre axis, in radians.
    #   Assumption: Uniform apparent radiance; N = 1 uses the centre instead.
    sample_index = np.arange(sample_count)
    radii = (sample_index + 0.5) / sample_count if sample_count > 1 else np.zeros(1)
    azimuth = sample_index * (pi * (3 - sqrt(5)))
    azimuth_cos = np.cos(azimuth)
    azimuth_sin = np.sin(azimuth)

    # Vector normalization: d = ‖v‖; s = v/d
    #   v (target_vectors_m) - Observer-to-body vectors, Moon-fixed metres.
    #   d (distances_m) - Body-center distance per observer, in metres.
    #   s (center) - Unit body-center direction per observer, dimensionless.
    distances_m = np.linalg.norm(target_vectors_m, axis=1)
    center = target_vectors_m / distances_m[:, None]

    reference_axis = np.zeros_like(center)
    near_axis = np.abs(center[:, 2]) > 0.9
    reference_axis[near_axis, 0] = 1
    reference_axis[~near_axis, 2] = 1
    # Orthonormal disk basis: e = (a × s)/‖a × s‖; n = s × e
    #   a (reference_axis) - Unit auxiliary axis chosen away from s.
    #   s (center) - Unit body-center direction, Moon-fixed XYZ.
    #   e (sky_east) - First unit transverse disk axis, Moon-fixed XYZ.
    #   n (sky_north) - Second unit transverse disk axis, Moon-fixed XYZ.
    sky_east = np.cross(reference_axis, center)
    sky_east /= np.linalg.norm(sky_east, axis=1)[:, None]
    sky_north = np.cross(center, sky_east)

    # Equal-solid-angle separation:
    #   sin α = R_b/d; cos α = √(1 − sin²α)
    #   δ = f sin²α/(1 + cos α); cos θ = 1 − δ; sin θ = √(δ(2 − δ))
    #
    #   α - Apparent angular radius of the body, in radians.
    #   R_b (body_radius_m) - Spherical body radius, in metres.
    #   d (distances_m) - Observer-to-body center distance, in metres.
    #   f (radii) - Dimensionless sample solid-angle fraction.
    #   δ (offsets) - Dimensionless stable value of 1 − cos θ.
    #   θ - Sample separation from disk center, in radians.
    #   sin²α/(1 + cos α) avoids cancellation in 1 − cos α.
    sin_radius = body_radius_m / distances_m
    cos_radius = np.sqrt(1 - sin_radius**2)
    offsets = radii * (sin_radius**2 / (1 + cos_radius))[:, None]
    cos_separation = 1 - offsets
    sin_separation = np.sqrt(offsets * (2 - offsets))

    # Disk direction: r = cos ψ e + sin ψ n; ω = cos θ s + sin θ r
    #   ψ (azimuth_cos/azimuth_sin) - Sample azimuth, in radians.
    #   e, n (sky_east, sky_north) - Unit transverse disk axes.
    #   θ (cos_separation/sin_separation) - Separation angle, in radians.
    #   s (center) - Unit body-center direction, Moon-fixed XYZ.
    #   r (radial) - Unit transverse sample direction, Moon-fixed XYZ.
    #   ω (directions) - Unit directions, observer × sample × XYZ.
    radial = (
        azimuth_cos[:, None] * sky_east[:, None, :] + azimuth_sin[:, None] * sky_north[:, None, :]
    )
    directions = cos_separation[..., None] * center[:, None, :] + sin_separation[..., None] * radial

    return DiskSamples(directions, cos_separation, distances_m)


def _earth_occultation_mask(
    earth_vectors_m: FloatArray,
    directions: FloatArray,
    sun_distances_m: FloatArray,
) -> NDArray[np.bool_]:
    """Mask solar rays intersecting the forward spherical Earth limb.

    Vectors have shape (receivers, 3), directions (receivers, rays, 3),
    and distances (receivers,). The returned mask is (receivers, rays).
    Earth is opaque; atmospheric transmission is excluded.
    """
    # Ray-sphere screening: q = v · ω; b² = v · v − q²
    #   q (earth_along_ray_m) - Forward Earth-center projection, in metres.
    #   v (earth_vectors_m) - Receiver-to-Earth vector, Moon-fixed metres.
    #   ω (directions) - Unit solar ray, Moon-fixed XYZ, dimensionless.
    #   b² (perpendicular_sq_m2) - Squared distance to the ray line, in m².
    earth_along_ray_m = np.einsum("ni,nri->nr", earth_vectors_m, directions)
    earth_distance_sq_m2 = np.sum(earth_vectors_m**2, axis=1)
    perpendicular_sq_m2 = earth_distance_sq_m2[:, None] - earth_along_ray_m**2

    # Occultation criterion: 0 < q < d and b² ≤ Rₑ²
    #   q (earth_along_ray_m) - Forward Earth-center projection, in metres.
    #   d (sun_distances_m) - Receiver-to-Sun center distance, in metres.
    #   b² (perpendicular_sq_m2) - Squared ray-line separation, in m².
    #   Rₑ (EARTH_MEAN_RADIUS_M) - Assumed spherical Earth radius, in metres.
    return (
        (earth_along_ray_m > 0)
        & (earth_along_ray_m < sun_distances_m[:, None])
        & (perpendicular_sq_m2 <= EARTH_MEAN_RADIUS_M**2)
    )
