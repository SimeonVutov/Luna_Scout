"""Download and verify the data files listed in backend/manifests/*.json into DATA/.

Usage (from backend/):
    python scripts/fetch_data.py              # required files only
    python scripts/fetch_data.py --all        # also optional files
    python scripts/fetch_data.py --verify     # only check files already on disk

Files already present with the right size and checksum are skipped.
Interrupted downloads resume where they stopped.
"""
import argparse
import hashlib
import json
import shutil
import sys
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
MANIFESTS = BACKEND / "manifests"
ROOT = BACKEND.parent  # repository root; manifest paths (DATA/...) are relative to it
CHUNK = 8 * 1024 * 1024


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(CHUNK):
            h.update(block)
    return h.hexdigest()


def remote_size(url: str) -> int | None:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "lunascout-fetch"})
    with urllib.request.urlopen(req, timeout=60) as r:
        n = r.headers.get("Content-Length")
        return int(n) if n else None


def download(url: str, dest: Path, size: int | None) -> None:
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": "lunascout-fetch"}
    if have:
        headers["Range"] = f"bytes={have}-"
    free = shutil.disk_usage(dest.parent).free
    if size and size - have > free:
        sys.exit(f"Not enough disk space for {dest.name}: need {(size - have) / 1e9:.1f} GB, have {free / 1e9:.1f} GB")
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        if have and r.status != 206:  # server ignored the resume request
            have = 0
        mode = "ab" if have else "wb"
        done = have
        with open(part, mode) as f:
            while block := r.read(CHUNK):
                f.write(block)
                done += len(block)
                if size:
                    print(f"\r  {done / 1e9:6.2f} / {size / 1e9:.2f} GB", end="", flush=True)
    print()
    part.replace(dest)


def check(entry: dict, path: Path) -> bool:
    if entry.get("size_bytes") and path.stat().st_size != entry["size_bytes"]:
        print(f"  size mismatch: {path.stat().st_size} != {entry['size_bytes']}")
        return False
    digest = sha256_of(path)
    if entry.get("sha256"):
        if digest != entry["sha256"]:
            print(f"  CHECKSUM MISMATCH: {digest}")
            return False
        print("  ok (size and sha256 match)")
    else:
        print(f"  no checksum in manifest yet; add this: \"sha256\": \"{digest}\", \"size_bytes\": {path.stat().st_size}")
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="include optional files")
    ap.add_argument("--verify", action="store_true", help="only verify files already on disk")
    args = ap.parse_args()

    ok = True
    for manifest in sorted(MANIFESTS.glob("*.json")):
        for entry in json.loads(manifest.read_text())["files"]:
            if not entry.get("required") and not args.all:
                continue
            path = ROOT / entry["path"]
            print(f"{entry['id']}: {entry['path']}")
            if path.exists():
                ok &= check(entry, path)
                continue
            if args.verify:
                print("  missing")
                ok = False
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            size = entry.get("size_bytes") or remote_size(entry["url"])
            download(entry["url"], path, size)
            ok &= check(entry, path)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
