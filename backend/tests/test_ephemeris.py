"""SPICE positions stay within 1 km of the JPL Horizons positions the application used before."""

from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from lunascout.ephemeris.states import kernel_paths, load_ephemerides_at

DATA_DIR = Path(__file__).resolve().parents[2] / "DATA"

# Moon-fixed Sun and Earth positions in metres, LT+S corrected, from Horizons (DE441) replies
# saved in November 2026 and rotated with the same lunar kernels.
HORIZONS = {
    "2026-11-16T12:00:00+00:00": (
        (-15870142280.2, 146963628348.3, -4012722925.1),
        (399815161.2, -32293410.2, 9809592.1),
    ),
    "2027-05-30T13:31:00+00:00": (
        (-73454726814.8, -132446098834.2, 3736657677.5),
        (386793381.3, -45175108.5, -33181887.5),
    ),
    "2028-01-25T15:23:00+00:00": (
        (-142659160975.0, -34962819897.3, 249232224.4),
        (402879082.4, 20746363.8, 6613933.5),
    ),
}


@pytest.mark.skipif(
    not all(path.is_file() for path in kernel_paths(DATA_DIR)),
    reason="Needs the SPICE kernels from lunascout-science fetch-data.",
)
def test_spice_matches_horizons_to_within_a_kilometre():
    times = tuple(datetime.fromisoformat(text) for text in HORIZONS)
    samples = load_ephemerides_at(times, data_dir=DATA_DIR, correction="LT+S").samples

    for sample, (sun_m, earth_m) in zip(samples, HORIZONS.values(), strict=True):
        assert np.linalg.norm(sample.sun_m - np.array(sun_m)) < 1000.0
        assert np.linalg.norm(sample.earth_m - np.array(earth_m)) < 1000.0
