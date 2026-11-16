"""File checksums that survive restarts.

Run identities include the checksum of every NASA input file, about 1 GB in all. Hashing them
on the first request after each start made submitting a simulation hang on a slow disk, so a
checksum is saved with the file's size and modification time and only recomputed when either
changes. The API and the worker share the saved file.
"""

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock

_lock = Lock()


def file_sha256(path: Path, saved: Path | None = None) -> str:
    """SHA-256 of `path`, reusing a checksum saved in the JSON file `saved` when it is current."""
    details = path.stat()
    return _checksum(path.resolve(), details.st_size, details.st_mtime_ns, saved)


@lru_cache(maxsize=128)
def _checksum(path: Path, size: int, modified_ns: int, saved: Path | None) -> str:
    key = str(path)
    stamp = [size, modified_ns]
    known = _read(saved) if saved else {}
    entry = known.get(key)
    if isinstance(entry, dict) and entry.get("stamp") == stamp and isinstance(entry.get("sha256"), str):
        return entry["sha256"]

    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if saved:
        _remember(saved, key, {"stamp": stamp, "sha256": digest})
    return digest


def _read(saved: Path) -> dict[str, object]:
    try:
        content = json.loads(saved.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return content if isinstance(content, dict) else {}


def _remember(saved: Path, key: str, entry: dict[str, object]) -> None:
    """Add one checksum. Written to a temporary file and renamed, so a reader never sees half a file."""
    with _lock:
        content = _read(saved)
        content[key] = entry
        saved.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile("w", dir=saved.parent, delete=False, encoding="utf-8") as staging:
            json.dump(content, staging)
        os.replace(staging.name, saved)
