"""Direct irradiance from a sampled solar disk and a spherical Earth limb."""

from math import pi, sqrt

import numpy as np
from numpy.typing import NDArray

from ..terrain import mesh
from ..terrain.model import Terrain
from .frames import FloatArray

# IAU 2015 nominal solar radius and irradiance. The AU is exact in SI metres.
SUN_RADIUS_M = 695_700_000.0
SOLAR_IRRADIANCE_AT_AU_W_M2 = 1361.0
AU_M = 149_597_870_700.0
EARTH_MEAN_RADIUS_M = 6_371_008.8
_RAYS_PER_BATCH = 200_000


def direct_sunlight(
    terrain: Terrain,
    origins_m: FloatArray,
    normals: FloatArray,
    sun_m: FloatArray,
    earth_m: FloatArray,
    disk_samples: int,
) -> tuple[FloatArray, FloatArray, FloatArray, FloatArray]:
    """Return lower/upper bounds on visible disk fraction and irradiance at each origin.

    A missing terrain intersection contributes only to the upper bound. The Earth
    is an opaque sphere for solar occultation, with no atmospheric transmission.
    """
    # Equal-solid-angle golden-angle quadrature:
    #   fᵢ = (i + ½)/N; ψᵢ = iπ(3 − √5)
    #
    #   fᵢ (radii) - Dimensionless radial solid-angle fraction of sample i.
    #   i (disk_index) - Zero-based sample index, dimensionless.
    #   N (disk_samples) - Number of equal-weight directions, dimensionless.
    #   ψᵢ (azimuth) - Sample angle around the Sun-center axis, in radians.
    #   Assumption: Uniform apparent radiance; N = 1 uses the center instead.
    disk_index = np.arange(disk_samples)
    radii = (disk_index + 0.5) / disk_samples if disk_samples > 1 else np.zeros(1)
    azimuth = disk_index * (pi * (3 - sqrt(5)))
    azimuth_cos = np.cos(azimuth)
    azimuth_sin = np.sin(azimuth)

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
        #   r☉ (sun_m) - Moon-centered Sun position, in metres.
        #   x (origins) - Receiver origins, in Moon-fixed metres.
        sun_vectors_m = sun_m - origins
        directions, flux_scale = _disk_directions(
            sun_vectors_m, radii, azimuth_cos, azimuth_sin
        )

        visibility = terrain.trace_rays(origins, directions)
        # Earth translation and Sun range: vₑ = rₑ − x; d☉ = ‖v☉‖
        #   vₑ - Receiver-to-Earth vectors passed to the occultation solver, in metres.
        #   rₑ (earth_m), x (origins) - Earth center and receiver Moon-fixed positions, in metres.
        #   d☉ - Sun-center distance per receiver, in metres.
        #   v☉ (sun_vectors_m) - Receiver-to-Sun Moon-fixed vectors, in metres.
        eclipsed = _earth_occultation_mask(
            earth_m - origins, directions, np.linalg.norm(sun_vectors_m, axis=1)
        )

        guaranteed = (visibility == mesh.CLEAR) & ~eclipsed
        possible = (visibility != mesh.BLOCKED) & ~eclipsed
        # Lambert cosine projection: cᵢⱼ = max(0, nᵢ · ωᵢⱼ)
        #   cᵢⱼ (incidence) - Dimensionless projected receiving factor.
        #   nᵢ (normals[batch]) - Unit receiver normal, Moon-fixed XYZ.
        #   ωᵢⱼ (directions) - Unit ray direction, Moon-fixed XYZ.
        #   Arrays have receiver × ray axes; normals have receiver × XYZ axes.
        incidence = np.maximum(0, np.einsum("ni,nri->nr", normals[batch], directions))

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


def _disk_directions(
    sun_vectors_m: FloatArray,
    radii: FloatArray,
    azimuth_cos: FloatArray,
    azimuth_sin: FloatArray,
) -> tuple[FloatArray, FloatArray]:
    """Build equal-solid-angle solar directions and normalized flux per receiver."""
    # Vector normalization: d = ‖v‖; s = v/d
    #   v (sun_vectors_m) - Receiver-to-Sun vectors, Moon-fixed metres.
    #   d (distances_m) - Sun-center distance per receiver, in metres.
    #   s (center) - Unit Sun-center direction per receiver, dimensionless.
    distances_m = np.linalg.norm(sun_vectors_m, axis=1)
    center = sun_vectors_m / distances_m[:, None]

    reference_axis = np.zeros_like(center)
    near_axis = np.abs(center[:, 2]) > 0.9
    reference_axis[near_axis, 0] = 1
    reference_axis[~near_axis, 2] = 1
    # Orthonormal disk basis: e = (a × s)/‖a × s‖; n = s × e
    #   a (reference_axis) - Unit auxiliary axis chosen away from s.
    #   s (center) - Unit Sun-center direction, Moon-fixed XYZ.
    #   e (sky_east) - First unit transverse disk axis, Moon-fixed XYZ.
    #   n (sky_north) - Second unit transverse disk axis, Moon-fixed XYZ.
    sky_east = np.cross(reference_axis, center)
    sky_east /= np.linalg.norm(sky_east, axis=1)[:, None]
    sky_north = np.cross(center, sky_east)

    # Equal-solid-angle separation:
    #   sin α = R☉/d; cos α = √(1 − sin²α)
    #   δ = f sin²α/(1 + cos α); cos θ = 1 − δ; sin θ = √(δ(2 − δ))
    #
    #   α - Apparent solar angular radius, in radians.
    #   R☉ (SUN_RADIUS_M) - IAU 2015 nominal solar radius, in metres.
    #   d (distances_m) - Receiver-to-Sun center distance, in metres.
    #   f (radii) - Dimensionless sample solid-angle fraction.
    #   δ (offsets) - Dimensionless stable value of 1 − cos θ.
    #   θ - Sample separation from disk center, in radians.
    #   sin²α/(1 + cos α) avoids cancellation in 1 − cos α.
    sin_radius = SUN_RADIUS_M / distances_m
    cos_radius = np.sqrt(1 - sin_radius**2)
    offsets = radii * (sin_radius**2 / (1 + cos_radius))[:, None]
    cos_separation = 1 - offsets
    sin_separation = np.sqrt(offsets * (2 - offsets))

    # Disk direction: r = cos ψ e + sin ψ n; ω = cos θ s + sin θ r
    #   ψ (azimuth_cos/azimuth_sin) - Sample azimuth, in radians.
    #   e, n (sky_east, sky_north) - Unit transverse disk axes.
    #   θ (cos_separation/sin_separation) - Separation angle, in radians.
    #   s (center) - Unit Sun-center direction, Moon-fixed XYZ.
    #   r (radial) - Unit transverse sample direction, Moon-fixed XYZ.
    #   ω (directions) - Unit solar directions, receiver × ray × XYZ.
    radial = (
        azimuth_cos[:, None] * sky_east[:, None, :] + azimuth_sin[:, None] * sky_north[:, None, :]
    )
    directions = cos_separation[..., None] * center[:, None, :] + sin_separation[..., None] * radial

    # Inverse-square irradiance with finite-disk normalization:
    #   S = S₁ (AU/d)²; F = S / ⟨cos θ⟩
    #   S (sun_normal_flux) - Unobstructed Sun-facing flux, in W/m².
    #   S₁ (SOLAR_IRRADIANCE_AT_AU_W_M2) - IAU nominal flux, 1361 W/m².
    #   AU (AU_M) - Exact astronomical unit, in metres.
    #   d (distances_m) - Receiver-to-Sun center distance, in metres.
    #   θ (cos_separation) - Ray separation angle, in radians.
    #   F - Returned quadrature flux scale, in W/m².
    sun_normal_flux = SOLAR_IRRADIANCE_AT_AU_W_M2 * (AU_M / distances_m) ** 2
    return directions, sun_normal_flux / cos_separation.mean(axis=1)
