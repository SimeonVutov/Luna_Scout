"""NASA's candidate landing sites, as the website lists them, for precomputing their results.

The list and the default settings must match the website exactly (`referenceSites.ts` and
`defaultOptions` in `useScience.ts`): a run is reused only when every input is identical. A test
compares them.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ReferenceSite:
    name: str
    latitude_deg: float
    longitude_deg: float


# Centres from NASA's Lunar Surface Data Book, ACD-50044 Rev A, Table A2-2 (east-positive longitude).
REFERENCE_SITES = (
    ReferenceSite("Malapert Massif", -85.9948, -0.2358),
    ReferenceSite("Haworth", -86.7639, -22.777),
    ReferenceSite("Nobile Rim 1", -85.4381, 37.3667),
    ReferenceSite("Nobile Rim 2", -83.954, 58.8221),
    ReferenceSite("de Gerlache Rim 2", -88.23, -64.6284),
    ReferenceSite("Shackleton Rim", -89.7668, -171.87),
    ReferenceSite("Connecting Ridge", -89.4632, -137.49),
    ReferenceSite("Connecting Ridge Extension", -89.0324, -101.999),
    ReferenceSite("Peak near Shackleton", -88.811, 123.6901),
    ReferenceSite("de Gerlache Rim 1", -88.6834, -67.9321),
    ReferenceSite("de Gerlache–Kocher Massif", -85.8296, -116.322),
    ReferenceSite("Faustini Rim A", -87.8897, 90),
    ReferenceSite("Leibnitz Beta Plateau", -85.4266, 31.7428),
    ReferenceSite("Amundsen Rim", -84.2287, 69.444),
    ReferenceSite("IM-2 Athena target (Mons Mouton)", -84.78, 29.13),
)
REFERENCE_RADIUS_M = 500

# The website's defaults. Precomputed runs use exactly these, so a visitor who keeps them reuses
# the precomputed samples.
DEFAULT_OPTIONS = {
    "grid_spacing_m": 20.0,
    "solar_disk_samples": 37,
    "integration_minutes": 15,
    "mast_height_m": 2.0,
    "collector_height_m": 2.0,
    "receiver": "vertical_tracking",
    "ray_method": "horizon",
}
DEFAULT_SNAPSHOT_MINUTES = 60
# The session that requests precomputed runs. Visitors pausing or cancelling only withdraw their own
# requests, so they never stop the precompute.
PRECOMPUTE_OWNER = "precompute"
