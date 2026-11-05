"""
Hakee lohkon HLS-, PlanetScope- ja Sentinel-1-havainnot ja kirjoittaa ne Niittoraportin CSV-tuontimuotoon
(päivä; lähde; tunniste; NDVI-mediaani; kelvolliset %; muuttunut %).

Laskenta on sama kuin selainsovelluksessa (datahaku.js):
  - pikseli kuuluu lohkoon, jos sen keskipiste on vähintään reunapuskurin päässä reunasta
  - HLS: Fmask hylkää sirruksen, pilven, pilven viereiset pikselit, varjon, lumen ja korkean aerosolin
  - PlanetScope: UDM2 clear -kaista, 4-kaistainen SR harmonisoituna Sentinel-2:een, lohkoon rajattuna
  - Sentinel-1: VV/VH-takaisinsironta γ⁰ (maastokorjattu) lohkon keskiarvona Copernicus Data Space
    Ecosystemin Statistical API:sta, nousevat ja laskevat radat erikseen (lähde "Sentinel-1 VH", arvo dB)
  - kuvat, joissa lohkolla ei ole yhtään kelvollista pikseliä, kirjoitetaan tyhjällä NDVI:llä ja 0 %:lla,
    jotta sovellus näyttää ne pois jätettyjen listassa
  - muuttunut % = osuus pikseleistä, joissa NDVI laski ≥ kynnys edellisestä saman sensoriperheen
    havainnosta, jossa kelvollisia pikseleitä oli vähintään raja-arvon verran

Asennus:
    pip install requests rasterio numpy pyproj shapely

Esimerkkejä:
    # HLS Planetary Computerista (ei tunnusta)
    python hae_havainnot.py --lohko lohko.geojson --alku 2026-05-01 --loppu 2026-09-30

    # Lisäksi PlanetScope (Planet-API-avain); tilaus kuluttaa kiintiötä ja kysyy vahvistuksen
    export PL_API_KEY=...
    python hae_havainnot.py --lohko lohko.geojson --alku 2026-05-01 --loppu 2026-09-30 --planet

    # Sentinel-1-tutka (CDSE OAuth -asiakas, ks. README)
    export CDSE_CLIENT_ID=... CDSE_CLIENT_SECRET=...
    python hae_havainnot.py --lohko lohko.geojson --alku 2026-05-01 --loppu 2026-10-15 --sentinel1

    # Jatka aiemmin tehtyä Planet-tilausta
    python hae_havainnot.py --lohko lohko.geojson --planet-tilaus <tilauksen-id> --hls-lahde ei

Lohko: GeoJSON (Feature, FeatureCollection tai geometria) WGS84- tai ETRS-TM35FIN-koordinaateissa.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests

PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
PC_SAS = "https://planetarycomputer.microsoft.com/api/sas/v1/token"
PL_DATA = "https://api.planet.com/data/v1"
PL_ORDERS = "https://api.planet.com/compute/ops/orders/v2"
CDSE_TOKEN = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
CDSE_STATS = "https://sh.dataspace.copernicus.eu/statistics/v1"
CDSE_CATALOG = "https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search"
S1_EVAL = """//VERSION=3
function setup(){return{input:[{bands:["VV","VH","dataMask"]}],output:[{id:"s1",bands:2,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){return{s1:[s.VV,s.VH],dataMask:[s.dataMask]}}"""

HLS = {"hls2-s30": ("B04", "B8A", "HLS-S30"), "hls2-l30": ("B04", "B05", "HLS-L30")}

# ---------------------------------------------------------------- lohko


def lue_lohko(polku):
    from pyproj import Transformer
    from shapely.geometry import shape
    from shapely.ops import transform, unary_union

    g = json.load(open(polku, encoding="utf-8"))
    feats = g["features"] if g.get("type") == "FeatureCollection" else [g]
    geoms = [shape(f["geometry"] if f.get("type") == "Feature" else f) for f in feats]
    geom = unary_union([x for x in geoms if x.geom_type in ("Polygon", "MultiPolygon")])
    if geom.is_empty:
        sys.exit("Lohkon GeoJSONista ei löytynyt monikulmiota.")
    crs = (g.get("crs") or {}).get("properties", {}).get("name", "")
    if "3067" in crs or (not crs and abs(geom.bounds[0]) > 180):
        epsg = 3067
    elif crs and "4326" not in crs and "CRS84" not in crs and "4258" not in crs:
        epsg = int(crs.split(":")[-1])
    else:
        epsg = 4326
    wgs = geom if epsg == 4326 else transform(Transformer.from_crs(epsg, 4326, always_xy=True).transform, geom)
    tm = transform(Transformer.from_crs(4326, 3067, always_xy=True).transform, wgs)
    props = feats[0].get("properties") or {} if feats and feats[0].get("type") == "Feature" else {}
    return {"wgs": wgs, "geojson": json.loads(json.dumps(wgs.__geo_interface__)), "ala_m2": tm.area, "properties": props}


# ---------------------------------------------------------------- rasterilaskenta


def fmask_kelpaa(fm):
    fm = fm.astype(np.uint16)
    return ((fm & 0x1F) == 0) & (((fm >> 6) & 3) != 3)


def ikkuna(ds, lohko, puskuri):
    """Lohkon ikkuna ja maski rasterin ruudukossa (keskipiste ≥ puskuri reunasta)."""
    from pyproj import Transformer
    from rasterio import features, windows
    from shapely.ops import transform

    g = transform(Transformer.from_crs(4326, ds.crs, always_xy=True).transform, lohko["wgs"])
    sis = g.buffer(-puskuri) if puskuri else g
    minx, miny, maxx, maxy = g.bounds
    t = ds.transform  # pohjoinen ylös: t.e < 0
    c0 = max(0, int(np.floor((minx - t.c) / t.a)))
    c1 = min(ds.width, int(np.ceil((maxx - t.c) / t.a)))
    r0 = max(0, int(np.floor((maxy - t.f) / t.e)))
    r1 = min(ds.height, int(np.ceil((miny - t.f) / t.e)))
    if c1 <= c0 or r1 <= r0 or sis.is_empty:
        return None
    w = windows.Window(c0, r0, c1 - c0, r1 - r0)
    tr = ds.window_transform(w)
    maski = features.geometry_mask([sis], out_shape=(int(w.height), int(w.width)), transform=tr, invert=True)
    return {"w": w, "tr": tr, "crs": ds.crs, "maski": maski, "n": int(maski.sum())}


def tilastot(ndvi, iw, edel, pudotus):
    from pyproj import Transformer

    kelv = ~np.isnan(ndvi) & iw["maski"]
    arvot = ndvi[kelv]
    vert = muutt = 0
    if edel is not None and arvot.size:
        rr, cc = np.nonzero(kelv)
        xs, ys = iw["tr"] * (cc + 0.5, rr + 0.5)
        if edel["iw"]["crs"] != iw["crs"]:
            xs, ys = Transformer.from_crs(iw["crs"], edel["iw"]["crs"], always_xy=True).transform(xs, ys)
        pc, pr = ~edel["iw"]["tr"] * (np.asarray(xs), np.asarray(ys))
        pc, pr = np.floor(pc).astype(int), np.floor(pr).astype(int)
        h, w = edel["ndvi"].shape
        ok = (pc >= 0) & (pr >= 0) & (pc < w) & (pr < h)
        pv = np.full(arvot.shape, np.nan)
        pv[ok] = edel["ndvi"][pr[ok], pc[ok]]
        on = ~np.isnan(pv)
        vert = int(on.sum())
        muutt = int(((pv[on] - arvot[on]) >= pudotus - 1e-9).sum())
    return {
        "arvo": round(float(np.median(arvot)), 3) if arvot.size else None,
        "kelvolliset": round(arvot.size / iw["n"] * 100) if iw["n"] else 0,
        "muuttunut": round(muutt / vert * 100) if vert >= max(3, arvot.size * 0.5) else None,
        "n": int(arvot.size),
    }


def viimeistele(raaka, a):
    paras = {}
    for o in raaka:
        if not o:
            continue
        k = (o["perhe"], o["pvm"])
        cur = paras.get(k)
        if cur is None or (cur["arvo"] is None and o["arvo"] is not None) or (o["arvo"] is not None and o["n"] > cur["n"]):
            paras[k] = o
    edel, ulos = {}, []
    for o in sorted(paras.values(), key=lambda x: x["pvm"]):
        if o["arvo"] is None:  # ei yhtään kelvollista pikseliä → näkyy sovelluksessa pois jätettynä
            ulos.append({"pvm": o["pvm"], "lahde": o["lahde"], "id": o["id"], "arvo": None, "kelvolliset": 0, "muuttunut": None, "n": 0})
            continue
        s = tilastot(o["ndvi"], o["iw"], edel.get(o["perhe"]), a.pudotus)
        if s["kelvolliset"] >= a.kelvolliset:
            edel[o["perhe"]] = o
        if s["arvo"] is not None:
            ulos.append({"pvm": o["pvm"], "lahde": o["lahde"], "id": o["id"], **s})
    return ulos


def ndvi(red, nir, ehto):
    red, nir = red.astype("float64"), nir.astype("float64")
    ok = ehto & (red > 0) & (nir > 0)
    out = np.full(red.shape, np.nan)
    out[ok] = (nir[ok] - red[ok]) / (nir[ok] + red[ok])
    return out


# ---------------------------------------------------------------- HLS


def hls_kuva(lahde, pvm, kuvaid, urls, lohko, a, gdal_env=None):
    """urls = (punainen, nir, Fmask) – polut tai osoitteet."""
    import rasterio

    with rasterio.Env(**(gdal_env or {})):
        with rasterio.open(urls[0]) as r0:
            iw = ikkuna(r0, lohko, a.puskuri)
            if not iw or not iw["n"]:
                return None
            red = r0.read(1, window=iw["w"])
        with rasterio.open(urls[1]) as r1:
            nir = r1.read(1, window=iw["w"])
        with rasterio.open(urls[2]) as r2:
            fm = r2.read(1, window=iw["w"])
    v = ndvi(red, nir, iw["maski"] & fmask_kelpaa(fm) & (red != -9999) & (nir != -9999))
    s = tilastot(v, iw, None, 0)
    return {"pvm": pvm, "lahde": lahde, "perhe": "HLS", "id": kuvaid, "ndvi": v, "iw": iw, **s}


def stac_haku(url, body, headers=None):
    kuvat, req = [], {"json": body}
    for _ in range(20):
        r = requests.post(url, headers=headers, timeout=60, **req) if "json" in req else requests.get(url, headers=headers, timeout=60)
        r.raise_for_status()
        js = r.json()
        kuvat += js.get("features", [])
        nx = next((l for l in js.get("links", []) if l.get("rel") == "next"), None)
        if not nx:
            break
        url = nx["href"]
        req = {"json": {**body, **(nx.get("body") or {})}} if nx.get("method") == "POST" else {}
    return kuvat


_sas = {}


def pc_allekirjoita(href):
    if ".blob.core.windows.net/" not in href:
        return href
    tili = href.split("//")[1].split(".")[0]
    kontti = href.split(".blob.core.windows.net/")[1].split("/")[0]
    k = f"{tili}/{kontti}"
    if k not in _sas or _sas[k][1] < time.time() + 300:
        js = requests.get(f"{PC_SAS}/{k}", timeout=30).json()
        exp = dt.datetime.fromisoformat(js.get("msft:expiry", "").replace("Z", "+00:00")).timestamp() if js.get("msft:expiry") else time.time() + 1800
        _sas[k] = (js["token"], exp)
    return href + ("&" if "?" in href else "?") + _sas[k][0]


def hae_hls(lohko, a):
    kok = HLS
    body = {"collections": list(kok), "intersects": lohko["geojson"], "datetime": f"{a.alku}T00:00:00Z/{a.loppu}T23:59:59Z", "limit": 250,
            "query": {"eo:cloud_cover": {"lte": a.pilvisyys}}}
    kuvat = stac_haku(f"{PC_STAC}/search", body)
    print(f"HLS (Planetary Computer): {len(kuvat)} kuvaa", file=sys.stderr)
    env = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "GDAL_HTTP_MAX_RETRY": "3", "GDAL_HTTP_RETRY_DELAY": "2"}

    def yksi(k):
        try:
            red, nir, src = kok[k["collection"]]
            hrefs = [k["assets"][x]["href"] for x in (red, nir, "Fmask")]
            urls = [pc_allekirjoita(h) for h in hrefs]
            return hls_kuva(src, k["properties"]["datetime"][:10], k["id"], urls, lohko, a, dict(env))
        except Exception as ex:  # noqa: BLE001
            print(f"  ohitettu {k.get('id')}: {ex}", file=sys.stderr)
            return None

    with ThreadPoolExecutor(4) as ex:
        return list(ex.map(yksi, kuvat))


# ---------------------------------------------------------------- PlanetScope


def ps_kuva(kuvaid, sr_polku, udm_polku, lohko, a):
    import rasterio

    with rasterio.open(sr_polku) as sr:
        iw = ikkuna(sr, lohko, a.puskuri)
        if not iw or not iw["n"]:
            return None
        red, nir = sr.read(3, window=iw["w"]), sr.read(4, window=iw["w"])
    with rasterio.open(udm_polku) as u:
        clear = u.read(1, window=iw["w"]) == 1
    v = ndvi(red, nir, iw["maski"] & clear)
    s = tilastot(v, iw, None, 0)
    pvm = f"{kuvaid[:4]}-{kuvaid[4:6]}-{kuvaid[6:8]}"
    return {"pvm": pvm, "lahde": "PlanetScope", "perhe": "PS", "id": kuvaid, "ndvi": v, "iw": iw, **s}


def ps_haku(lohko, a, avain):
    body = {"item_types": ["PSScene"], "filter": {"type": "AndFilter", "config": [
        {"type": "GeometryFilter", "field_name": "geometry", "config": lohko["geojson"]},
        {"type": "DateRangeFilter", "field_name": "acquired", "config": {"gte": f"{a.alku}T00:00:00Z", "lte": f"{a.loppu}T23:59:59Z"}},
        {"type": "RangeFilter", "field_name": "cloud_cover", "config": {"lte": min(1, a.pilvisyys / 100)}},
        {"type": "AssetFilter", "config": ["ortho_analytic_4b_sr"]},
        {"type": "PermissionFilter", "config": ["assets:download"]}]}}
    r = requests.post(f"{PL_DATA}/quick-search?_page_size=250", json=body, auth=(avain, ""), timeout=60)
    if r.status_code in (401, 403):
        sys.exit(f"Planet: HTTP {r.status_code}. Tarkista PL_API_KEY ja tilin PlanetScope-oikeudet.")
    r.raise_for_status()
    js, kaikki = r.json(), []
    kaikki += js.get("features", [])
    while js.get("_links", {}).get("_next"):
        js = requests.get(js["_links"]["_next"], auth=(avain, ""), timeout=60).json()
        kaikki += js.get("features", [])
    paras = {}
    for f in kaikki:
        p = f["properties"]
        d = p["acquired"][:10]
        pis = p.get("clear_percent", 100 * (1 - p.get("cloud_cover", 0)))
        if d not in paras or pis > paras[d][1]:
            paras[d] = (f["id"], pis)
    return [paras[d][0] for d in sorted(paras)], len(kaikki)


def ps_tilaa(lohko, ids, avain, nimi):
    body = {"name": nimi, "products": [{"item_ids": ids, "item_type": "PSScene", "product_bundle": "analytic_sr_udm2"}],
            "tools": [{"clip": {"aoi": lohko["geojson"]}}, {"harmonize": {"target_sensor": "Sentinel-2"}}]}
    r = requests.post(PL_ORDERS, json=body, auth=(avain, ""), timeout=60)
    if not r.ok:
        sys.exit(f"Planet-tilaus epäonnistui: HTTP {r.status_code} {r.text[:300]}")
    return r.json()["id"]


def ps_odota(tilaus, avain, minuutit):
    loppu = time.time() + minuutit * 60
    while True:
        js = requests.get(f"{PL_ORDERS}/{tilaus}", auth=(avain, ""), timeout=60).json()
        tila = js.get("state")
        print(f"Tilaus {tilaus}: {tila}", file=sys.stderr)
        if tila in ("success", "partial"):
            return js["_links"]["results"]
        if tila in ("failed", "cancelled"):
            sys.exit(f"Tilaus päättyi tilaan {tila}: {js.get('error_hints') or ''}")
        if time.time() > loppu:
            sys.exit(f"Tilaus ei valmistunut {minuutit} minuutissa. Jatka myöhemmin: --planet-tilaus {tilaus}")
        time.sleep(30)


def ps_kasittele(tulokset, lohko, a, kansio):
    parit = {}
    for t in tulokset:
        nimi = t.get("name", "")
        if not nimi.lower().endswith(".tif"):
            continue
        tiedosto = pathlib.Path(nimi).name
        kuvaid = tiedosto.split("_3B_")[0]
        laji = "udm" if "udm2" in tiedosto.lower() else "sr" if "AnalyticMS_SR" in tiedosto else None
        if not laji:
            continue
        polku = pathlib.Path(kansio) / tiedosto
        if not polku.exists():
            with requests.get(t["location"], stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(polku, "wb") as f:
                    for osa in r.iter_content(1 << 20):
                        f.write(osa)
        parit.setdefault(kuvaid, {})[laji] = polku
    raaka = []
    for kuvaid, p in sorted(parit.items()):
        if "sr" in p and "udm" in p:
            try:
                raaka.append(ps_kuva(kuvaid, p["sr"], p["udm"], lohko, a))
            except Exception as ex:  # noqa: BLE001
                print(f"  ohitettu {kuvaid}: {ex}", file=sys.stderr)
    return raaka


# ---------------------------------------------------------------- pääohjelma


# ---------------------------------------------------------------- Sentinel-1 (CDSE)


def cdse_token(asiakas, salaisuus):
    r = requests.post(CDSE_TOKEN, data={"grant_type": "client_credentials", "client_id": asiakas, "client_secret": salaisuus}, timeout=60)
    if r.status_code in (400, 401):
        sys.exit("Copernicus Data Space hylkäsi tunnuksen: tarkista CDSE_CLIENT_ID ja CDSE_CLIENT_SECRET.")
    r.raise_for_status()
    return r.json()["access_token"]


def seuraava_paiva(p):
    return (dt.date.fromisoformat(p) + dt.timedelta(days=1)).isoformat()


def s1_radat(kuvaukset):
    """(päivä, suunta) → "rata N" tai "klo HH:MM" (kellonajat ryhmitellään ± 3 min), kuten datahaku.js s1Tracks."""
    ulos = {}
    for suunta in ("ASCENDING", "DESCENDING"):
        lista = sorted((k for k in kuvaukset if k["suunta"] == suunta), key=lambda k: k["min"])
        ryhmat = []
        for k in lista:
            if ryhmat and k["min"] - ryhmat[-1]["viim"] <= 3:
                ryhmat[-1]["k"].append(k); ryhmat[-1]["viim"] = k["min"]
            else:
                ryhmat.append({"eka": k["min"], "viim": k["min"], "k": [k]})
        for r in ryhmat:
            m = round((r["eka"] + r["viim"]) / 2)
            for k in r["k"]:
                leima = f"rata {k['rata']}" if k["rata"] is not None else f"klo {m // 60 % 24:02d}:{m % 60:02d}"
                avain = (k["pvm"], suunta)
                ulos[avain] = "sekoitus" if avain in ulos and ulos[avain] != leima else leima
    return ulos


def s1_luettelo(lohko, alku, loppu, tok):
    kuvaukset, seuraava = [], None
    for _ in range(20):
        body = {"collections": ["sentinel-1-grd"], "datetime": f"{alku}T00:00:00Z/{seuraava_paiva(loppu)}T00:00:00Z",
                "intersects": lohko["geojson"], "limit": 100}
        if seuraava is not None:
            body["next"] = seuraava
        r = requests.post(CDSE_CATALOG, json=body, headers={"Authorization": f"Bearer {tok}"}, timeout=120)
        r.raise_for_status()
        js = r.json()
        for f in js.get("features", []):
            p = f.get("properties", {})
            pol = p.get("sar:polarizations") or p.get("s1:polarization")
            if p.get("sar:instrument_mode", "IW") != "IW" or (pol and "VH" not in str(pol)):
                continue
            t, tila = str(p.get("datetime", "")), str(p.get("sat:orbit_state", "")).upper()
            suunta = "ASCENDING" if tila.startswith("ASC") else "DESCENDING" if tila.startswith("DESC") else None
            if suunta and len(t) >= 19:
                kuvaukset.append({"pvm": t[:10], "suunta": suunta, "rata": p.get("sat:relative_orbit"),
                                  "min": int(t[11:13]) * 60 + int(t[14:16]) + int(t[17:19]) / 60})
        seuraava = (js.get("context") or {}).get("next")
        if seuraava is None:
            break
    return kuvaukset


def s1_pyynto(lohko, alku, loppu, suunta):
    from pyproj import Transformer
    from shapely.ops import transform

    lon = (lohko["wgs"].bounds[0] + lohko["wgs"].bounds[2]) / 2
    epsg = 32600 + min(60, max(1, int((lon + 180) // 6) + 1))
    g = transform(Transformer.from_crs(4326, epsg, always_xy=True).transform, lohko["wgs"])
    return {
        "input": {"bounds": {"geometry": json.loads(json.dumps(g.__geo_interface__)), "properties": {"crs": f"http://www.opengis.net/def/crs/EPSG/0/{epsg}"}},
                  "data": [{"type": "sentinel-1-grd",
                            "dataFilter": {"acquisitionMode": "IW", "polarization": "DV", "resolution": "HIGH", "orbitDirection": suunta},
                            "processing": {"backCoeff": "GAMMA0_TERRAIN", "orthorectify": True, "demInstance": "COPERNICUS_30"}}]},
        "aggregation": {"timeRange": {"from": f"{alku}T00:00:00Z", "to": f"{seuraava_paiva(loppu)}T00:00:00Z"},
                        "aggregationInterval": {"of": "P1D", "lastIntervalBehavior": "SHORTEN"},
                        "evalscript": S1_EVAL, "resx": 10, "resy": 10},
        "calculations": {"default": {}},
    }


def s1_jasenna(js, suunta, kelv_min=50, radat=None):
    """Statistical API -vastaus → havainnot (sama muunnos kuin datahaku.js s1Parse)."""
    import math

    tag = "ASC" if suunta == "ASCENDING" else "DESC"
    ulos = []
    for d in js.get("data", []):
        pvm = d["interval"]["from"][:10]
        b = (d.get("outputs") or {}).get("s1", {}).get("bands", {})
        vv, vh = (b.get("B0") or {}).get("stats"), (b.get("B1") or {}).get("stats")
        if d.get("error") or not vv or not vh:
            continue
        n, nd = vh.get("sampleCount", 0), vh.get("noDataCount", 0)
        try:
            m_vh, m_vv = float(vh["mean"]), float(vv["mean"])
        except (TypeError, ValueError):
            continue
        if n - nd <= 0 or not math.isfinite(m_vh) or m_vh <= 0:
            continue
        kelv = round((n - nd) / n * 100)
        if kelv < kelv_min:
            continue
        rata = (radat or {}).get((pvm, suunta))
        if rata == "sekoitus":
            continue
        tag2 = f"{tag} {rata}" if rata else tag
        vv_db = round(10 * math.log10(m_vv), 2) if math.isfinite(m_vv) and m_vv > 0 else None
        ulos.append({"pvm": pvm, "lahde": "Sentinel-1 VH", "id": f"S1 GRD {tag2} {pvm}" + (f" VV {vv_db:.2f} dB" if vv_db is not None else ""),
                     "arvo": round(10 * math.log10(m_vh), 2), "kelvolliset": kelv, "muuttunut": None, "n": n - nd})
    return ulos


def hae_s1(lohko, a):
    asiakas, salaisuus = os.environ.get("CDSE_CLIENT_ID"), os.environ.get("CDSE_CLIENT_SECRET")
    if not (asiakas and salaisuus):
        sys.exit("Aseta Copernicus Data Space -tunnus: export CDSE_CLIENT_ID=... CDSE_CLIENT_SECRET=... (ohjeet README:ssä).")
    tok = cdse_token(asiakas, salaisuus)
    try:
        radat = s1_radat(s1_luettelo(lohko, a.alku, a.loppu, tok))
    except requests.RequestException as e:
        print(f"Sentinel-1: ratatietoa ei saatu ({e}); erotellaan vain suunnan mukaan.", file=sys.stderr)
        radat = None
    ulos = []
    for suunta in ("ASCENDING", "DESCENDING"):
        r = requests.post(CDSE_STATS, json=s1_pyynto(lohko, a.alku, a.loppu, suunta), headers={"Authorization": f"Bearer {tok}"}, timeout=300)
        r.raise_for_status()
        ulos += s1_jasenna(r.json(), suunta, a.kelvolliset, radat)
    print(f"Sentinel-1: {len(ulos)} havaintoa", file=sys.stderr)
    return sorted(ulos, key=lambda o: (o["pvm"], o["id"]))


def kirjoita(havainnot, polku):
    rivit = ["# päivä;lähde;tunniste;arvo (NDVI tai VH dB);kelvolliset %;muuttunut %"]
    for o in havainnot:
        arvo = "" if o["arvo"] is None else (f"{o['arvo']:.2f}" if o["lahde"] == "Sentinel-1 VH" else f"{o['arvo']:.3f}")
        rivit.append(";".join([o["pvm"], o["lahde"], o["id"], arvo, str(o["kelvolliset"]),
                               "" if o["muuttunut"] is None else str(o["muuttunut"])]))
    teksti = "\n".join(rivit) + "\n"
    if polku == "-":
        sys.stdout.write(teksti)
    else:
        pathlib.Path(polku).write_text(teksti, encoding="utf-8")
        print(f"{len(havainnot)} havaintoa → {polku}. Liitä sisältö sovelluksen Liitä CSV -kenttään.", file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Niittoraportin havaintojen haku (HLS, PlanetScope, Sentinel-1)")
    ap.add_argument("--lohko", required=True, help="lohkon GeoJSON (WGS84 tai EPSG:3067)")
    ap.add_argument("--alku", help="alkupäivä VVVV-KK-PP")
    ap.add_argument("--loppu", help="loppupäivä VVVV-KK-PP")
    ap.add_argument("--hls-lahde", choices=["pc", "ei"], default="pc", help="pc = Planetary Computer (oletus), ei = ei HLS-hakua")
    ap.add_argument("--planet", action="store_true", help="hae ja tilaa PlanetScope (PL_API_KEY)")
    ap.add_argument("--planet-tilaus", help="käsittele aiemman tilauksen tulokset")
    ap.add_argument("--sentinel1", action="store_true", help="hae Sentinel-1 VH/VV-takaisinsironta (CDSE_CLIENT_ID, CDSE_CLIENT_SECRET)")
    ap.add_argument("--kylla", action="store_true", help="tilaa kysymättä vahvistusta")
    ap.add_argument("--odota", type=int, default=60, help="Planet-tilauksen enimmäisodotus minuutteina")
    ap.add_argument("--puskuri", type=float, default=10, help="reunapuskuri m")
    ap.add_argument("--pudotus", type=float, default=0.12, help="muuttuneen pikselin NDVI-pudotus")
    ap.add_argument("--kelvolliset", type=float, default=50, help="vertailuhavainnon kelvolliset pikselit ≥ %%")
    ap.add_argument("--pilvisyys", type=float, default=80, help="kuvan kokonaispilvisyys enintään %%")
    ap.add_argument("--ulos", default="havainnot.csv", help="CSV-tiedosto tai - (tulosta)")
    a = ap.parse_args(argv)

    lohko = lue_lohko(a.lohko)
    print(f"Lohko {lohko['ala_m2'] / 1e4:.2f} ha", file=sys.stderr)
    tarvitsee_ajan = a.hls_lahde != "ei" or a.planet or a.sentinel1
    if tarvitsee_ajan and not (a.alku and a.loppu):
        sys.exit("Anna --alku ja --loppu.")

    raaka = []
    if a.hls_lahde != "ei":
        raaka += hae_hls(lohko, a)

    if a.planet or a.planet_tilaus:
        avain = os.environ.get("PL_API_KEY")
        if not avain:
            sys.exit("Aseta Planet-API-avain: export PL_API_KEY=... (ohjeet README:ssä).")
        tilaus = a.planet_tilaus
        if not tilaus:
            ids, kaikki = ps_haku(lohko, a, avain)
            km2 = len(ids) * lohko["ala_m2"] / 1e6
            print(f"PlanetScope: {kaikki} kuvaa, {len(ids)} päivää. Tilattava ala ≈ {km2:.2f} km².", file=sys.stderr)
            if not ids:
                ids = []
            elif not a.kylla and input(f"Tilataanko {len(ids)} kuvaa (≈ {km2:.2f} km²)? [k/E] ").strip().lower() not in ("k", "kyllä", "y"):
                print("Tilausta ei tehty.", file=sys.stderr)
                ids = []
            if ids:
                nimi = f"Niittoraportti {lohko['properties'].get('tunnus', '')} {dt.date.today()}".strip()
                tilaus = ps_tilaa(lohko, ids, avain, nimi)
                print(f"Tilaus {tilaus} lähetetty.", file=sys.stderr)
        if tilaus:
            tulokset = ps_odota(tilaus, avain, a.odota)
            with tempfile.TemporaryDirectory() as kansio:
                raaka += ps_kasittele(tulokset, lohko, a, kansio)

    tulos = viimeistele(raaka, a)
    if a.sentinel1:
        tulos = sorted(tulos + hae_s1(lohko, a), key=lambda o: o["pvm"])
    kirjoita(tulos, a.ulos)


if __name__ == "__main__":
    main()
