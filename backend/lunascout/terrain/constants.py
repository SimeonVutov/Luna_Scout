"""Project-wide constants. lunascout/terrain/CONVENTIONS.md explains each choice."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # repository root (holds DATA/)
DATA = ROOT / "DATA"

# Lunar reference sphere used by LOLA products, the IAU and JPL Horizons (metres).
# A DEM value h means the surface is at radius MOON_RADIUS_M + h.
MOON_RADIUS_M = 1_737_400.0

# Body-fixed frame for ALL Moon-fixed coordinates in this project.
# In moon_de440_250416.tf, MOON_ME is an alias of MOON_ME_DE440_ME421,
# which stays within ~0.5 m (2000-2040) of the DE421 mean-Earth frame the LOLA DEM uses.
MOON_FRAME = "MOON_ME"

# Default data locations (see backend/manifests/).
DEM_LOCAL = DATA / "raw" / "lola" / "LDEM_80S_20MPP_ADJ.TIF"
DEM_URL = "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF"
DEM_NATIVE_SPACING_M = 20.0

# Kernels that define lunar orientation and time (no planet positions: that is the
# Sun/Earth data pipeline's job; see lunascout/terrain/CONVENTIONS.md "Interface for Sun/Earth/orbit data").
SPICE_DIR = DATA / "raw" / "spice"
SPICE_KERNELS = [
    "naif0012.tls",
    "moon_pa_de440_200625.bpc",
    "moon_de440_250416.tf",
]
