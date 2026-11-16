"""Download the science inputs or run one terrain and ephemeris snapshot."""

import argparse
import json
import logging
import os
import shutil
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import URLError
from urllib.request import urlopen

import numpy as np

from .ephemeris.horizons import (
    KERNEL_NAMES,
    Ephemerides,
    EphemerisError,
    load_ephemerides_at,
)
from .simulation.engine import SimulationSettings, Snapshot, calculate_snapshot
from .simulation.frames import MOON_RADIUS_M, SiteFootprint
from .terrain.context_maps import CONTEXT_FILE_NAMES, ILLUMINATION_URL
from .terrain.diviner import COMPACT_NAME, PRP_URL, TABLE_NAME, build_compact_table
from .terrain.model import (
    LOCAL_DEM_NAMES,
    LOCAL_DEM_SITES,
    REGIONAL_DEM_NAMES,
    Terrain,
    TerrainError,
    prepare_terrain,
)

_DEFAULT_DATA_DIR = Path(__file__).resolve().parents[2] / "DATA"
_NAIF_KERNELS_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
_GODDARD_DATA_URL = "https://pgda.gsfc.nasa.gov/data"


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    parser = _argument_parser()
    arguments = parser.parse_args()
    try:
        if arguments.command == "fetch-data":
            _fetch_data(arguments.data_dir)
        elif arguments.command == "ephemeris":
            series = load_ephemerides_at(
                tuple(arguments.at), data_dir=arguments.data_dir, correction=arguments.correction
            )
            print(json.dumps(_ephemeris_report(series), indent=2, allow_nan=False))
        else:
            _run_snapshot(arguments)
    except (EphemerisError, TerrainError, ValueError, OSError) as exc:
        parser.exit(1, f"lunascout-science: {exc}\n")


def _argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(os.environ.get("LUNASCOUT_DATA_DIR", _DEFAULT_DATA_DIR)),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("fetch-data", help="Download the NASA LOLA grids and NAIF kernels.")

    ephemeris = commands.add_parser("ephemeris", help="Print Moon-fixed Sun and Earth positions.")
    ephemeris.add_argument(
        "--at", type=_timestamp, action="append", required=True, help="UTC epoch"
    )
    _correction_option(ephemeris)

    snapshot = commands.add_parser(
        "snapshot", help="Trace sunlight and Earth visibility at one UTC epoch."
    )
    snapshot.add_argument(
        "--at", type=_timestamp, required=True, help="ISO 8601 datetime with UTC offset"
    )
    snapshot.add_argument(
        "--latitude", type=float, required=True, help="spherical latitude in degrees"
    )
    snapshot.add_argument(
        "--longitude", type=float, required=True, help="east-positive longitude in degrees"
    )
    snapshot.add_argument(
        "--radius-m", type=float, required=True, help="site radius on the lunar sphere"
    )
    snapshot.add_argument("--grid-spacing-m", type=float, default=SimulationSettings.grid_spacing_m)
    snapshot.add_argument(
        "--solar-disk-samples", type=int, default=SimulationSettings.solar_disk_samples
    )
    snapshot.add_argument("--mast-height-m", type=float, default=SimulationSettings.mast_height_m)
    snapshot.add_argument(
        "--collector-height-m", type=float, default=SimulationSettings.collector_height_m
    )
    snapshot.add_argument(
        "--receiver",
        choices=("vertical_tracking", "terrain", "horizontal", "fixed"),
        help="receiving surface (default: vertical_tracking, or fixed with --collector-tilt-deg)",
    )
    snapshot.add_argument(
        "--collector-tilt-deg", type=float, help="tilt from local horizontal (fixed receiver)"
    )
    snapshot.add_argument(
        "--collector-azimuth-deg", type=float, default=0.0, help="clockwise from north"
    )
    snapshot.add_argument(
        "--local-dem", type=Path, action="append", help="replace the default local DEM set"
    )
    snapshot.add_argument(
        "--output", type=Path, required=True, help="new directory for the JSON and NPZ"
    )
    _correction_option(snapshot)
    return parser


def _correction_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--correction",
        choices=("LT+S", "NONE"),
        default="LT+S",
        help="apparent reception or geometric Horizons vectors (default: LT+S)",
    )


def _timestamp(value: str) -> datetime:
    try:
        time = datetime.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "Use an ISO 8601 timestamp, such as 2026-11-14T12:00:00Z."
        ) from exc

    if time.utcoffset() is None:
        raise argparse.ArgumentTypeError("Timestamp must include a UTC offset or Z.")
    return time


def _fetch_data(data_dir: Path) -> None:
    kernel_dir = data_dir / "raw" / "spice"
    terrain_dir = data_dir / "raw" / "terrain"
    inputs = [
        (kernel_dir / name, f"{_NAIF_KERNELS_URL}/{folder}/{name}")
        for name, folder in zip(KERNEL_NAMES, ("lsk", "fk/satellites", "pck"), strict=True)
    ]
    inputs.extend(
        (terrain_dir / name, f"{_GODDARD_DATA_URL}/LOLA_20mpp/{name}")
        for name in REGIONAL_DEM_NAMES
    )
    inputs.extend(
        (terrain_dir / name, f"{_GODDARD_DATA_URL}/LOLA_5mpp/{site}/{name}")
        for site, name in zip(LOCAL_DEM_SITES, LOCAL_DEM_NAMES, strict=True)
    )

    inputs.extend(
        (data_dir / "raw" / "context" / name, f"{ILLUMINATION_URL}/{name}")
        for name in CONTEXT_FILE_NAMES
    )

    for path, url in inputs:
        if not path.is_file():
            _download(url, path)

    _fetch_ice_table(data_dir)


def _fetch_ice_table(data_dir: Path) -> None:
    """Diviner's modelled temperatures and ice depths: a 605 MB table cut down to a small file."""
    context_dir = data_dir / "raw" / "context"
    compact_path = context_dir / COMPACT_NAME
    if compact_path.is_file():
        return

    table_path = context_dir / TABLE_NAME
    _download(PRP_URL, table_path)
    print(f"Reducing {TABLE_NAME}", file=sys.stderr, flush=True)
    build_compact_table(table_path, compact_path)
    # The text table is only an intermediate; the compact file holds what the server needs.
    table_path.unlink()


def _download(url: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {path.name}", file=sys.stderr, flush=True)
    try:
        with TemporaryDirectory(dir=path.parent, prefix=f".{path.name}-") as stage:
            staged_path = Path(stage) / path.name
            with urlopen(url, timeout=60) as response, staged_path.open("wb") as download:
                shutil.copyfileobj(response, download, length=1024 * 1024)
                expected_size = response.headers.get("Content-Length")
                if expected_size and download.tell() != int(expected_size):
                    raise OSError(f"{path.name} ended before the expected file size.")
            staged_path.replace(path)
    except (URLError, TimeoutError) as exc:
        raise OSError(f"Could not download {path.name} from NASA.") from exc


def _ephemeris_report(series: Ephemerides) -> dict[str, object]:
    return {
        "source": _ephemeris_source(series),
        "samples": [
            {
                "at_utc": sample.at_utc.isoformat(),
                "et_tdb_seconds": sample.et_tdb_seconds,
                "sun_m": sample.sun_m.tolist(),
                "earth_m": sample.earth_m.tolist(),
            }
            for sample in series.samples
        ],
    }


def _ephemeris_source(series: Ephemerides) -> dict[str, object]:
    return {
        "provider": "NASA JPL Horizons",
        "frame": series.frame,
        "correction": series.correction,
        "api_versions": series.horizons_api_versions,
        "planetary_ephemerides": series.ephemeris_sources,
        "response_sha256": series.response_sha256,
        "kernels_sha256": series.kernels_sha256,
    }


def _run_snapshot(arguments: argparse.Namespace) -> None:
    output = arguments.output
    if output.exists():
        raise ValueError(f"Output directory already exists: {output}")

    site = SiteFootprint(arguments.latitude, arguments.longitude, arguments.radius_m)
    receiver = arguments.receiver
    if receiver is None:
        receiver = "fixed" if arguments.collector_tilt_deg is not None else SimulationSettings.receiver
    # A single snapshot gains nothing from a horizon map, so every ray is traced directly.
    settings = SimulationSettings(
        grid_spacing_m=arguments.grid_spacing_m,
        solar_disk_samples=arguments.solar_disk_samples,
        mast_height_m=arguments.mast_height_m,
        collector_height_m=arguments.collector_height_m,
        receiver=receiver,
        collector_tilt_deg=arguments.collector_tilt_deg,
        collector_azimuth_deg=arguments.collector_azimuth_deg,
        ray_method="direct",
    )
    ephemerides = load_ephemerides_at(
        (arguments.at,), data_dir=arguments.data_dir, correction=arguments.correction
    )
    terrain = prepare_terrain(arguments.data_dir, site, local_dems=arguments.local_dem)
    snapshot = calculate_snapshot(site, ephemerides.samples[0], terrain, settings)
    _write_snapshot(output, site, settings, snapshot, terrain, ephemerides)
    print(output / "summary.json")
    print(output / "grid.npz")


def _write_snapshot(
    output: Path,
    site: SiteFootprint,
    settings: SimulationSettings,
    snapshot: Snapshot,
    terrain: Terrain,
    ephemerides: Ephemerides,
) -> None:
    report = {
        "schema_version": 1,
        "at_utc": snapshot.at_utc.isoformat(),
        "site": asdict(site),
        "settings": asdict(settings),
        "center_ground_height_m": snapshot.center_ground_height_m,
        "sun_at_collector": asdict(snapshot.sun_at_collector)
        if snapshot.sun_at_collector
        else None,
        "earth_at_mast": asdict(snapshot.earth_at_mast) if snapshot.earth_at_mast else None,
        "earth_center_visibility": snapshot.earth_center_visibility,
        "earth_disk_visible_fraction": asdict(snapshot.earth_disk_visible_fraction)
        if snapshot.earth_disk_visible_fraction
        else None,
        "summary": asdict(snapshot.summary),
        "ephemeris": _ephemeris_report(ephemerides),
        "terrain": {
            "datum_radius_m": MOON_RADIUS_M,
            "grid_projection": "south-polar gnomonic",
            "sources": [asdict(source) for source in terrain.sources],
        },
        "grid": "grid.npz",
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent, prefix=f".{output.name}-") as stage:
        stage_dir = Path(stage)
        (stage_dir / "summary.json").write_text(
            json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
        )
        np.savez_compressed(stage_dir / "grid.npz", **vars(snapshot.grid))
        stage_dir.rename(output)


if __name__ == "__main__":
    main()
