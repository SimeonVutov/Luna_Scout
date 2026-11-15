import sqlite3
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from .models import Site, SiteSpec

# Source checkout default. Set LUNASCOUT_DATA_DIR when deploying the package.
DEFAULT_DATA_DIR = Path(__file__).resolve().parents[3] / "DATA"


def open_catalog(data_dir: Path) -> sqlite3.Connection:
    data_dir.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(data_dir / "catalog.sqlite3")
    db.row_factory = sqlite3.Row
    return db


def initialize(data_dir: Path) -> None:
    with closing(open_catalog(data_dir)) as db, db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS sites (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                latitude_deg REAL NOT NULL,
                longitude_deg REAL NOT NULL,
                radius_m INTEGER NOT NULL
            )
        """)


def list_sites(data_dir: Path) -> list[Site]:
    with closing(open_catalog(data_dir)) as db:
        return [Site(**dict(row)) for row in db.execute("SELECT * FROM sites ORDER BY rowid")]


def get_site(data_dir: Path, site_id: str) -> Site | None:
    with closing(open_catalog(data_dir)) as db:
        row = db.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
        return Site(**dict(row)) if row is not None else None


def add_site(data_dir: Path, site: SiteSpec) -> Site:
    result = Site(id=str(uuid4()), **site.model_dump())
    with closing(open_catalog(data_dir)) as db, db:
        db.execute(
            "INSERT INTO sites VALUES (:id, :name, :latitude_deg, :longitude_deg, :radius_m)",
            result.model_dump(),
        )
    return result


def update_site(data_dir: Path, site_id: str, site: SiteSpec) -> Site | None:
    result = Site(id=site_id, **site.model_dump())
    with closing(open_catalog(data_dir)) as db, db:
        updated = db.execute(
            """UPDATE sites
               SET name = :name, latitude_deg = :latitude_deg,
                   longitude_deg = :longitude_deg, radius_m = :radius_m
               WHERE id = :id""",
            result.model_dump(),
        )
        return result if updated.rowcount else None


def delete_site(data_dir: Path, site_id: str) -> bool:
    with closing(open_catalog(data_dir)) as db, db:
        return bool(db.execute("DELETE FROM sites WHERE id = ?", (site_id,)).rowcount)
