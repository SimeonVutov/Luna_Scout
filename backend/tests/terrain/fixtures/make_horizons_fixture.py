"""Regenerate tests/terrain/fixtures/horizons_alignment.json from the JPL Horizons API.

Stores, for a few epochs, what the Sun/Earth data pipeline would typically hand over
(Moon-centred vectors in ICRF) plus Horizons' own azimuth/elevation from a surface site.
tests/test_alignment.py checks that our frame conversion turns the first into the second.

    python tests/terrain/fixtures/make_horizons_fixture.py
"""
import json
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
SITE = {"lat": -89.45, "lon": 222.7, "height_km": 0.0}
START, STOP, STEP = "2028-01-10 00:00", "2028-01-14 00:00", "12 h"
MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}


def query(**p):
    base = {"format": "json", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES", "CSV_FORMAT": "YES",
            "START_TIME": START, "STOP_TIME": STOP, "STEP_SIZE": STEP}
    q = {k: f"'{v}'" for k, v in {**base, **p}.items() if k != "format"}
    q["format"] = "json"
    req = urllib.request.Request(API + "?" + urllib.parse.urlencode(q), headers={"User-Agent": "lunascout-fixture"})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = json.loads(r.read())["result"]
    lines = text.splitlines()
    i0, i1 = lines.index("$$SOE"), lines.index("$$EOE")
    return [[c.strip() for c in ln.split(",")] for ln in lines[i0 + 1:i1]], lines[i0 - 2], text


def main():
    out = {"site": SITE, "source": "JPL Horizons API", "bodies": {}}
    for name, cmd in (("SUN", "10"), ("EARTH", "399")):
        vec, _, vtext = query(COMMAND=cmd, EPHEM_TYPE="VECTORS", CENTER="500@301", REF_SYSTEM="ICRF",
                              REF_PLANE="FRAME", OUT_UNITS="KM-S", VEC_TABLE="2", VEC_CORR="LT+S",
                              TIME_TYPE="UT")
        obs, header, otext = query(COMMAND=cmd, EPHEM_TYPE="OBSERVER", CENTER="coord@301", COORD_TYPE="GEODETIC",
                                   SITE_COORD=f"{SITE['lon'] % 360},{SITE['lat']},{SITE['height_km']}",
                                   TIME_TYPE="UT", QUANTITIES="4", APPARENT="AIRLESS", ANG_FORMAT="DEG",
                                   EXTRA_PREC="YES", ELEV_CUT="-90")
        cols = [c.strip() for c in header.split(",")]
        c_az = next(k for k, c in enumerate(cols) if c.startswith("Azi"))
        c_el = next(k for k, c in enumerate(cols) if c.startswith("Elev"))
        times = []
        for r in obs:
            d, hm = r[0].split()
            y, mo, dd = d.split("-")
            times.append(f"{y}-{MONTHS[mo]:02d}-{dd}T{hm}:00")
        src = next(ln.strip() for ln in vtext.splitlines() if "Target body name" in ln)
        out["bodies"][name] = {
            "horizons_target": src,
            "utc": times,
            "vector_icrf_moon_centred_km_lt_s": [[float(r[2]), float(r[3]), float(r[4])] for r in vec],
            "site_azimuth_deg": [float(r[c_az]) for r in obs],
            "site_elevation_deg": [float(r[c_el]) for r in obs],
            "vector_settings": "EPHEM_TYPE=VECTORS CENTER=500@301 REF_SYSTEM=ICRF REF_PLANE=FRAME VEC_CORR=LT+S TIME_TYPE=UT",
            "observer_settings": "EPHEM_TYPE=OBSERVER CENTER=coord@301 COORD_TYPE=GEODETIC APPARENT=AIRLESS QUANTITIES=4",
        }
        assert len(vec) == len(obs)
    p = Path(__file__).with_name("horizons_alignment.json")
    p.write_text(json.dumps(out, indent=1))
    print("wrote", p)


if __name__ == "__main__":
    main()
