"""Calculate a single timestamp of direct sunlight and Earth visibility."""

from dataclasses import dataclass
from datetime import datetime
from math import asin, atan2, cos, degrees, hypot, isfinite, radians, sin
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from ..ephemeris.horizons import EphemerisSample
from ..terrain import mesh
from ..terrain.horizon import HorizonMap
from ..terrain.model import Terrain
from .frames import (
    MOON_RADIUS_M,
    FloatArray,
    SiteFootprint,
    local_axes,
    site_directions,
)
from .radiation import EARTH_MEAN_RADIUS_M, SUN_RADIUS_M, direct_sunlight, disk_directions

# A millimetre above the geometric surface avoids re-hitting the source triangle.
_RAY_ORIGIN_OFFSET_M = 0.001
_MAX_GRID_WIDTH = 1001
# Earth spans about 1.9° from the Moon; 37 equal-solid-angle rays resolve partial views.
EARTH_DISK_SAMPLES = 37

Visibility = Literal["clear", "blocked", "unknown"]
_VISIBILITY_LABEL: dict[int, Visibility] = {
    mesh.CLEAR: "clear",
    mesh.BLOCKED: "blocked",
    mesh.UNKNOWN: "unknown",
}

# What receives the sunlight at each grid point:
#   vertical_tracking - A vertical panel turned toward the Sun's azimuth (typical lander arrays).
#   terrain - The local terrain triangle (ground illumination, thermal studies).
#   horizontal - A level plate.
#   fixed - A plane with an explicit tilt and azimuth.
Receiver = Literal["vertical_tracking", "terrain", "horizontal", "fixed"]
# horizon - Precomputed terrain horizons with exact re-tracing near the skyline.
# direct - Trace every solar-disk ray against the terrain (the reference method).
RayMethod = Literal["horizon", "direct"]


@dataclass(frozen=True)
class SimulationSettings:
    """Sampling and receiver settings for a snapshot.

    Heights are metres above the DEM along the local radial vertical. A fixed
    receiver's tilt is from local horizontal, with azimuth clockwise from north.
    """

    grid_spacing_m: float = 20.0
    solar_disk_samples: int = 37
    mast_height_m: float = 2.0
    collector_height_m: float = 2.0
    receiver: Receiver = "vertical_tracking"
    collector_tilt_deg: float | None = None
    collector_azimuth_deg: float = 0.0
    ray_method: RayMethod = "horizon"

    def __post_init__(self) -> None:
        if not isfinite(self.grid_spacing_m) or self.grid_spacing_m <= 0:
            raise ValueError("Grid spacing must be positive and finite.")
        if type(self.solar_disk_samples) is not int or self.solar_disk_samples <= 0:
            raise ValueError("Solar disk sample count must be a positive integer.")
        for height in (self.mast_height_m, self.collector_height_m):
            if not isfinite(height) or height < 0:
                raise ValueError("Mast and collector heights must be finite and nonnegative.")
        if self.receiver not in ("vertical_tracking", "terrain", "horizontal", "fixed"):
            raise ValueError(f"Unknown receiver: {self.receiver}.")
        if self.ray_method not in ("horizon", "direct"):
            raise ValueError(f"Unknown ray method: {self.ray_method}.")

        if self.receiver == "fixed":
            if self.collector_tilt_deg is None or not 0 <= self.collector_tilt_deg <= 90:
                raise ValueError("A fixed receiver needs a tilt between 0° and 90°.")
            if not 0 <= self.collector_azimuth_deg < 360:
                raise ValueError("Collector azimuth must be in [0°, 360°).")
        elif self.collector_tilt_deg is not None or self.collector_azimuth_deg != 0:
            raise ValueError("Collector tilt and azimuth apply only to a fixed receiver.")


@dataclass(frozen=True)
class Bounds:
    """Lower and upper estimates attributable to terrain coverage."""

    lower: float
    upper: float


@dataclass(frozen=True)
class BodyView:
    """Topocentric angles and distance, using radial up for the local sky."""

    azimuth_deg: float | None
    elevation_deg: float
    distance_m: float
    angular_radius_deg: float


@dataclass(frozen=True)
class SnapshotGrid:
    """Rows increase north, columns increase east. The axes share offsets_m.

    Numeric entries outside the circle or with unknown ground are NaN. Ray
    coverage uncertainty at known ground is represented by pairs of bounds.
    """

    offsets_m: FloatArray
    inside_site: NDArray[np.bool_]
    dem_spacing_m: FloatArray
    height_m: FloatArray
    visible_sun_fraction_lower: FloatArray
    visible_sun_fraction_upper: FloatArray
    irradiance_lower_w_m2: FloatArray
    irradiance_upper_w_m2: FloatArray


@dataclass(frozen=True)
class SnapshotSummary:
    sample_count: int
    ground_sample_count: int
    ground_covered_area_fraction: float
    sun_resolved_area_fraction: float
    lit_area_fraction: Bounds
    mean_visible_sun_fraction: Bounds
    mean_irradiance_on_known_ground_w_m2: Bounds | None
    # Stricter threshold: at least half the solar disk visible. None in runs
    # saved before model revision 2.
    half_disk_lit_area_fraction: Bounds | None = None


@dataclass(frozen=True)
class Snapshot:
    """One UTC result, including geometry at the site-centre instruments."""

    at_utc: datetime
    center_ground_height_m: float | None
    sun_at_collector: BodyView | None
    earth_at_mast: BodyView | None
    earth_center_visibility: Visibility
    summary: SnapshotSummary
    grid: SnapshotGrid
    # Fraction of Earth's apparent disk visible from the mast; None without ground.
    earth_disk_visible_fraction: Bounds | None = None


@dataclass(frozen=True)
class PreparedSite:
    """Terrain, grid and instruments reused across every time in a run.

    Receiver arrays (`solar_origins_m`, `receiver_up`, `collector_normals`) list
    the reporting points with known ground, in row-major grid order.
    """

    terrain: Terrain
    settings: SimulationSettings
    offsets_m: FloatArray
    inside: NDArray[np.bool_]
    weights: FloatArray
    heights_m: FloatArray
    dem_spacing_m: FloatArray
    solar_origins_m: FloatArray
    receiver_up: FloatArray
    collector_normals: FloatArray
    axes: tuple[FloatArray, FloatArray, FloatArray]
    center_height_m: float | None
    mast_origin_m: FloatArray | None
    center_collector_m: FloatArray | None


def grid_half_width(site: SiteFootprint, settings: SimulationSettings) -> int:
    """Validate the requested circular reporting grid size."""
    extent = site.radius_m / settings.grid_spacing_m
    if extent >= (_MAX_GRID_WIDTH + 1) // 2:
        raise ValueError(
            f"The site grid can span at most {_MAX_GRID_WIDTH} cells per axis. Increase grid spacing."
        )
    return int(extent)


def prepare_site(
    site: SiteFootprint, terrain: Terrain, settings: SimulationSettings
) -> PreparedSite:
    """Sample ground and place all observers once for a simulation run."""
    half_width = grid_half_width(site, settings)
    # Regular circular reporting grid: Eⱼ = j s; Nₖ = k s; Eⱼ² + Nₖ² ≤ r²
    #   Eⱼ, Nₖ (east_m, north_m) - Local geodesic reporting offsets, in metres.
    #   j, k - Integer grid offsets from −half_width to +half_width.
    #   s (settings.grid_spacing_m) - Reporting spacing, in metres.
    #   r (site.radius_m) - Geodesic reporting radius, in metres.
    offsets = np.arange(-half_width, half_width + 1, dtype=np.float64) * settings.grid_spacing_m
    east_m, north_m = np.meshgrid(offsets, offsets)
    inside = np.hypot(east_m, north_m) <= site.radius_m
    directions, weights = site_directions(site, east_m[inside], north_m[inside])

    heights = np.full(inside.shape, np.nan)
    spacing = np.full(inside.shape, np.nan)
    origins: list[FloatArray] = []
    ups: list[FloatArray] = []
    normals: list[FloatArray] = []
    rows, columns = np.nonzero(inside)
    for row, column, up in zip(rows, columns, directions, strict=True):
        ground = terrain.surface_at(up)
        if ground is None:
            continue

        # Spherical radial elevation: h = ‖x‖ − R
        #   h (heights) - Terrain height above datum, in metres.
        #   x (ground.position_m) - Terrain point, Moon-fixed metres.
        #   R (MOON_RADIUS_M) - Spherical datum radius, in metres.
        heights[row, column] = np.linalg.norm(ground.position_m) - MOON_RADIUS_M
        spacing[row, column] = ground.dem_spacing_m
        origins.append(_receiver_origin(ground.position_m, up, settings.collector_height_m))
        ups.append(up)
        normals.append(_collector_normal(ground.normal, up, settings))

    axes = local_axes(site.latitude_deg, site.longitude_deg)
    up = axes[2]
    center = terrain.surface_at(up)
    center_height = None
    mast_origin = None
    collector_origin = None
    if center is not None:
        # Spherical radial elevation: h₀ = ‖x₀‖ − R
        #   h₀ (center_height) - Center terrain elevation, in metres.
        #   x₀ (center.position_m) - Center terrain point, Moon-fixed metres.
        #   R (MOON_RADIUS_M) - Spherical datum radius, in metres.
        center_height = float(np.linalg.norm(center.position_m) - MOON_RADIUS_M)
        mast_origin = _receiver_origin(center.position_m, up, settings.mast_height_m)
        collector_origin = _receiver_origin(center.position_m, up, settings.collector_height_m)

    return PreparedSite(
        terrain=terrain,
        settings=settings,
        offsets_m=offsets,
        inside=inside,
        weights=weights,
        heights_m=heights,
        dem_spacing_m=spacing,
        solar_origins_m=np.asarray(origins),
        receiver_up=np.asarray(ups),
        collector_normals=np.asarray(normals),
        axes=axes,
        center_height_m=center_height,
        mast_origin_m=mast_origin,
        center_collector_m=collector_origin,
    )


def calculate_snapshot(
    site: SiteFootprint,
    ephemeris: EphemerisSample,
    terrain: Terrain,
    settings: SimulationSettings = SimulationSettings(),
) -> Snapshot:
    """Sample and trace a stand-alone snapshot."""
    prepared = prepare_site(site, terrain, settings)
    return trace_snapshot(prepared, ephemeris)


def trace_snapshot(
    prepared: PreparedSite, ephemeris: EphemerisSample, horizons: HorizonMap | None = None
) -> Snapshot:
    """Trace a timestamp against an already sampled site.

    `horizons`, built for `prepared.solar_origins_m`, replaces most solar-disk
    traces with horizon lookups; without it every ray is traced directly.
    """
    if ephemeris.frame != prepared.terrain.frame:
        raise ValueError("The ephemeris and terrain must use the same lunar frame.")

    visible_lower, visible_upper, flux_lower, flux_upper = (
        np.full(prepared.inside.shape, np.nan) for _ in range(4)
    )
    if len(prepared.solar_origins_m):
        known_ground = np.isfinite(prepared.heights_m)
        (
            visible_lower[known_ground],
            visible_upper[known_ground],
            flux_lower[known_ground],
            flux_upper[known_ground],
        ) = direct_sunlight(
            prepared.terrain,
            prepared.solar_origins_m,
            receiver_normals(prepared, ephemeris.sun_m),
            ephemeris.sun_m,
            ephemeris.earth_m,
            prepared.settings.solar_disk_samples,
            horizons,
        )

    grid = SnapshotGrid(
        offsets_m=prepared.offsets_m,
        inside_site=prepared.inside,
        dem_spacing_m=prepared.dem_spacing_m,
        height_m=prepared.heights_m,
        visible_sun_fraction_lower=visible_lower,
        visible_sun_fraction_upper=visible_upper,
        irradiance_lower_w_m2=flux_lower,
        irradiance_upper_w_m2=flux_upper,
    )
    summary = _summarize(grid, prepared.weights)
    if prepared.mast_origin_m is None or prepared.center_collector_m is None:
        return Snapshot(
            at_utc=ephemeris.at_utc,
            center_ground_height_m=None,
            sun_at_collector=None,
            earth_at_mast=None,
            earth_center_visibility="unknown",
            summary=summary,
            grid=grid,
        )

    # Observer translation and normalization: v = r − x; ω = v/‖v‖
    #   r (ephemeris.earth_m/sun_m) - Moon-centered body position, in metres.
    #   x (mast_origin_m/center_collector_m) - Instrument origin, in metres.
    #   v (earth_vector_m/sun_vector_m) - Topocentric Moon-fixed vector, in metres.
    #   ω (earth_direction) - Unit mast-to-Earth direction, dimensionless.
    earth_vector_m = ephemeris.earth_m - prepared.mast_origin_m
    sun_vector_m = ephemeris.sun_m - prepared.center_collector_m
    earth_direction = earth_vector_m / np.linalg.norm(earth_vector_m)

    mast_status = prepared.terrain.visibility(prepared.mast_origin_m, earth_direction)
    return Snapshot(
        at_utc=ephemeris.at_utc,
        center_ground_height_m=prepared.center_height_m,
        sun_at_collector=_body_view(sun_vector_m, SUN_RADIUS_M, *prepared.axes),
        earth_at_mast=_body_view(earth_vector_m, EARTH_MEAN_RADIUS_M, *prepared.axes),
        earth_center_visibility=_VISIBILITY_LABEL[mast_status],
        summary=summary,
        grid=grid,
        earth_disk_visible_fraction=_earth_disk_fraction(
            prepared.terrain, prepared.mast_origin_m, earth_vector_m
        ),
    )


def receiver_normals(prepared: PreparedSite, sun_m: FloatArray) -> FloatArray:
    """Unit receiving-plane normals for each receiver at the Sun position `sun_m`.

    Fixed receivers use their prepared normals. A vertical tracking panel turns
    about the local vertical to face the Sun, so its normal changes with time.
    """
    if prepared.settings.receiver != "vertical_tracking":
        return prepared.collector_normals

    sun_vectors_m = sun_m - prepared.solar_origins_m
    sun_directions = sun_vectors_m / np.linalg.norm(sun_vectors_m, axis=1)[:, None]
    up = prepared.receiver_up

    # Single-axis tracking normal: n = (s − (s·u)u)/‖s − (s·u)u‖
    #   n - Unit normal of a vertical panel facing the Sun's azimuth, Moon-fixed XYZ.
    #   s (sun_directions) - Unit receiver-to-Sun-centre direction, Moon-fixed XYZ.
    #   u (up) - Unit local radial vertical at the receiver.
    #   Assumption: The panel stays vertical. If the Sun were at the zenith (never
    #   south of 60°S) the panel would have no preferred azimuth; the Sun direction is used.
    rise = np.einsum("ni,ni->n", sun_directions, up)
    horizontal = sun_directions - rise[:, None] * up
    horizontal_length = np.linalg.norm(horizontal, axis=1)
    at_zenith = horizontal_length < 1e-9
    horizontal[at_zenith] = sun_directions[at_zenith]
    horizontal_length[at_zenith] = 1.0
    return horizontal / horizontal_length[:, None]


def _earth_disk_fraction(
    terrain: Terrain, mast_origin_m: FloatArray, earth_vector_m: FloatArray
) -> Bounds:
    """Bounds on the fraction of Earth's apparent disk that clears the terrain."""
    earth_disk = disk_directions(earth_vector_m[None, :], EARTH_MEAN_RADIUS_M, EARTH_DISK_SAMPLES)
    statuses = terrain.trace_rays(mast_origin_m[None, :], earth_disk.directions)[0]

    # Equal-weight disk visibility: f₋ = Σⱼ[clearⱼ]/N; f₊ = Σⱼ[not blockedⱼ]/N
    #   f₋, f₊ - Dimensionless visible-disk bounds; unresolved rays count only in f₊.
    #   N (EARTH_DISK_SAMPLES) - Equal-solid-angle rays across Earth's apparent disk.
    #   Assumption: Earth is a uniform sphere of mean radius; this is geometry, not a radio link.
    return Bounds(
        float(np.mean(statuses == mesh.CLEAR)),
        float(np.mean(statuses != mesh.BLOCKED)),
    )


def _summarize(grid: SnapshotGrid, weights: FloatArray) -> SnapshotSummary:
    """Aggregate the circular footprint, retaining separate coverage denominators."""
    inside = grid.inside_site
    ground = np.isfinite(grid.height_m[inside])
    visible_lower = grid.visible_sun_fraction_lower[inside]
    visible_upper = grid.visible_sun_fraction_upper[inside]
    flux_lower = grid.irradiance_lower_w_m2[inside]
    flux_upper = grid.irradiance_upper_w_m2[inside]
    total_weight = weights.sum()

    # Known-ground mean: Ḡ = Σᵢ(wᵢ Gᵢ)/Σᵢwᵢ, over known ground only
    #   Ḡ (mean_flux) - Mean direct irradiance bounds, in W/m².
    #   Gᵢ (flux_lower/upper) - Per-point receiving irradiance bounds, in W/m².
    #   wᵢ (weights) - Dimensionless spherical area weights.
    #   i - Index of a reporting point with a known receiving height.
    mean_flux = None
    if ground.any():
        mean_flux = Bounds(
            float(np.average(flux_lower[ground], weights=weights[ground])),
            float(np.average(flux_upper[ground], weights=weights[ground])),
        )

    # Coverage fraction: C = Σᵢ∈K wᵢ / W; W = Σᵢwᵢ
    #   C (ground_coverage/resolved_coverage) - Dimensionless footprint coverage.
    #   K - Known-ground or equal-visibility-bound sample indices.
    #   wᵢ (weights) - Dimensionless spherical area weights inside the circle.
    #   W (total_weight) - Total reporting weight, including missing ground.
    ground_coverage = float(weights[ground].sum() / total_weight)
    resolved = visible_lower == visible_upper
    resolved_coverage = float(weights[resolved].sum() / total_weight)

    # Lit-area bounds: L₋ = Σᵢ∈B wᵢ/W; L₊ = Σᵢ∈P wᵢ/W
    #   L₋, L₊ (lit_area) - Dimensionless footprint lit-area bounds.
    #   B (definitely_lit) - Samples with positive lower irradiance.
    #   P (possibly_lit) - Samples with positive upper irradiance or unknown ground.
    #   wᵢ (weights), W (total_weight) - Sample weights and total reporting weight.
    #   Assumption: One spatial sample per grid point; threshold is strictly > 0 W/m².
    definitely_lit = flux_lower > 0
    possibly_lit = (flux_upper > 0) | ~ground
    lit_area = Bounds(
        float(weights[definitely_lit].sum() / total_weight),
        float(weights[possibly_lit].sum() / total_weight),
    )

    # Half-disk lit-area bounds: H₋ = Σᵢ∈B½ wᵢ/W; H₊ = Σᵢ∈P½ wᵢ/W
    #   H₋, H₊ (half_disk_lit_area) - Dimensionless footprint fraction with ≥ ½ of the Sun visible.
    #   B½ (half_lit_lower) - Samples whose lower visible-disk bound is ≥ 0.5.
    #   P½ (half_lit_upper) - Samples whose upper bound is ≥ 0.5, or with unknown ground.
    #   wᵢ (weights), W (total_weight) - Sample weights and total reporting weight.
    #   The "> 0 W/m²" definition above counts a point lit when one of N rays is clear.
    half_lit_lower = visible_lower >= 0.5
    half_lit_upper = (visible_upper >= 0.5) | ~ground
    half_disk_lit_area = Bounds(
        float(weights[half_lit_lower].sum() / total_weight),
        float(weights[half_lit_upper].sum() / total_weight),
    )

    # Footprint mean disk visibility: f̄ = Σᵢ(wᵢ fᵢ)/Σᵢwᵢ
    #   f̄ (mean_visibility) - Dimensionless mean solar-disk visibility bounds.
    #   fᵢ (disk_lower/upper) - Dimensionless per-point visibility bound.
    #   wᵢ (weights) - Dimensionless spherical area weights inside the circle.
    #   Unknown receiving ground contributes 0 to the lower and 1 to the upper bound.
    disk_lower = np.nan_to_num(visible_lower, nan=0)
    disk_upper = np.nan_to_num(visible_upper, nan=1)
    mean_visibility = Bounds(
        float(np.average(disk_lower, weights=weights)),
        float(np.average(disk_upper, weights=weights)),
    )

    return SnapshotSummary(
        sample_count=len(weights),
        ground_sample_count=int(np.count_nonzero(ground)),
        ground_covered_area_fraction=ground_coverage,
        sun_resolved_area_fraction=resolved_coverage,
        lit_area_fraction=lit_area,
        mean_visible_sun_fraction=mean_visibility,
        mean_irradiance_on_known_ground_w_m2=mean_flux,
        half_disk_lit_area_fraction=half_disk_lit_area,
    )


def _receiver_origin(ground_m: FloatArray, up: FloatArray, height_m: float) -> FloatArray:
    """Place a receiver radially above ground, retaining the self-hit tolerance."""
    # Radial instrument placement: x = g + (h + ε)u
    #   x (receiver) - Instrument position, Moon-fixed metres.
    #   g (ground_m) - Terrain intersection, Moon-fixed metres.
    #   h (height_m) - Instrument height above ground, in metres.
    #   ε (_RAY_ORIGIN_OFFSET_M) - Numerical self-hit offset, in metres.
    #   u (up) - Unit local radial vertical, dimensionless.
    receiver = ground_m + (height_m + _RAY_ORIGIN_OFFSET_M) * up
    if not np.linalg.norm(receiver) < mesh.OUTER_RADIUS_M:
        raise ValueError(
            "Instrument height puts the ray origin outside the supported terrain shell."
        )
    return receiver


def _collector_normal(
    normal: FloatArray, up: FloatArray, settings: SimulationSettings
) -> FloatArray:
    """Time-independent receiving normal for terrain, horizontal and fixed receivers.

    A vertical tracking receiver's normal depends on the Sun; `receiver_normals`
    computes it per timestamp, and the radial vertical is stored here unused.
    """
    if settings.receiver == "terrain":
        return normal
    if settings.receiver in ("horizontal", "vertical_tracking"):
        return up
    assert settings.collector_tilt_deg is not None

    # Spherical inverse coordinates: φ = atan2(u_z, √(u_x² + u_y²)); λ = atan2(u_y, u_x)
    #   u (up) - Unit radial Moon-fixed vector, dimensionless.
    #   φ, λ (latitude, longitude) - Latitude and east longitude, converted to degrees.
    latitude = degrees(atan2(up[2], hypot(up[0], up[1])))
    longitude = degrees(atan2(up[1], up[0]))
    east, north, _ = local_axes(latitude, longitude)
    tilt = radians(settings.collector_tilt_deg)
    azimuth = radians(settings.collector_azimuth_deg)
    # Tilted receiving normal: n = cos β u + sin β(cos A north + sin A east)
    #   n - Returned unit receiving normal, Moon-fixed XYZ.
    #   β (tilt) - Tilt from horizontal, in radians.
    #   A (azimuth) - Normal azimuth clockwise from north, in radians.
    #   u (up), north, east - Unit local axes, dimensionless.
    return cos(tilt) * up + sin(tilt) * (cos(azimuth) * north + sin(azimuth) * east)


def _body_view(
    position_m: FloatArray, radius_m: float, east: FloatArray, north: FloatArray, up: FloatArray
) -> BodyView:
    """Resolve a body vector into radial sky angles; leave zenith azimuth undefined."""
    # Local Cartesian projection: E = v·e; N = v·n; U = v·u
    #   v (position_m) - Observer-to-body Moon-fixed vector, in metres.
    #   e, n, u (east, north, up) - Dimensionless unit local axes.
    #   E, N, U (east_m, north_m, up_m) - Local components, in metres.
    east_m = float(position_m @ east)
    north_m = float(position_m @ north)
    up_m = float(position_m @ up)

    # Sky geometry: H = √(E² + N²); d = √(H² + U²)
    #   H (horizontal_m) - Horizontal component length, in metres.
    #   E, N, U (east_m, north_m, up_m) - Local components, in metres.
    #   d (distance_m) - Observer-to-body distance, in metres.
    horizontal_m = hypot(east_m, north_m)
    distance_m = hypot(horizontal_m, up_m)

    # Azimuth: A = atan2(E, N) mod 2π, defined only when H > εd
    #   A (azimuth_deg) - Clockwise-from-north angle, converted to degrees.
    #   E, N (east_m, north_m) - Local horizontal components, in metres.
    #   H (horizontal_m), d (distance_m) - Component and total lengths, in metres.
    #   ε - Dimensionless zenith tolerance, fixed at 10⁻¹².
    azimuth_deg = None
    if horizontal_m > distance_m * 1e-12:
        azimuth_deg = degrees(atan2(east_m, north_m)) % 360

    # Elevation and spherical angular radius: el = atan2(U, H); ρ = asin(R/d)
    #   el (elevation_deg) - Elevation above radial horizontal, converted to degrees.
    #   U (up_m), H (horizontal_m) - Vertical and horizontal components, in metres.
    #   ρ (angular_radius_deg) - Apparent angular radius, converted to degrees.
    #   R (radius_m), d (distance_m) - Spherical body radius and distance, in metres.
    elevation_deg = degrees(atan2(up_m, horizontal_m))
    angular_radius_deg = degrees(asin(radius_m / distance_m))

    return BodyView(
        azimuth_deg=azimuth_deg,
        elevation_deg=elevation_deg,
        distance_m=distance_m,
        angular_radius_deg=angular_radius_deg,
    )
