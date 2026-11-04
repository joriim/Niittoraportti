"""
Hakee Ruokaviraston avoimen kasvulohkoaineiston (INSPIRE GSAA, CC BY 4.0)
ja rajaa siitä niittovelvoitteiset lohkot (luonnonhoitonurmet, viherlannoitus-
nurmet, monimuotoisuuskasvit) valitulle alueelle.

Käyttö:
    pip install geopandas pyogrio requests
    python hae_kasvulohkot.py --vuodet 2023 2024 2025 --alue etela-pohjanmaa

Tuloste: niittolohkot_<vuosi>.gpkg (EPSG:3067) ja yhteenveto ruudulle.

Yksittäisen lohkon rajaus peruslohkotunnuksella (Niittoraportin lohkon rajaukseksi):
    python hae_kasvulohkot.py --peruslohko 1641431471 --vuodet 2025
    python hae_kasvulohkot.py --peruslohko 1641431471-2 --vuodet 2025
Tuloste: lohko_<tunnus>.geojson (WGS84) jokaisesta kasvulohkosta. Liitä tiedosto sovellukseen
(Avaa tiedosto) tai hae_havainnot.py:n --lohko-parametriksi.
Lähde: Ruokavirasto, INSPIRE-latauspalvelu. Mainitse lähde aineistoa käyttäessäsi.

Huom: koko maan tiedosto on suuri (satoja megatavuja). Skripti lataa sen
kerran kansioon data/ ja käyttää välimuistia.
"""
import argparse
import json
import pathlib
import re

import requests

URL = "https://download.inspire.ruokavirasto-awsa.com/data/{v}/LandUse.ExistingLandUse.GSAAAgriculturalParcel.gpkg"

# Likimääräinen rajaus EPSG:3067-koordinaateissa (xmin, ymin, xmax, ymax).
# Tarkista ja korvaa tarvittaessa maakuntarajalla (esim. MML:n avoin aineisto).
ALUEET = {
    "etela-pohjanmaa": (210000, 6880000, 380000, 7060000),
    "koko-suomi": None,
}

# Kasvin nimen hakusanat (kirjainkoko ei merkitse). Tarkista tulostetut
# kasvinimet ja täydennä tarvittaessa.
HAKU = re.compile(r"luonnonhoito|viherlannoitus|monimuotoisuus|niitty|riista|maisema|pölyttäjä", re.I)


def lataa(vuosi: int, kansio: pathlib.Path) -> pathlib.Path:
    kansio.mkdir(exist_ok=True)
    polku = kansio / f"GSAA_{vuosi}.gpkg"
    if polku.exists() and polku.stat().st_size > 0:
        return polku
    print(f"Ladataan {vuosi} ...")
    with requests.get(URL.format(v=vuosi), stream=True, timeout=120) as r:
        r.raise_for_status()
        tmp = polku.with_suffix(".part")
        with open(tmp, "wb") as f:
            for osa in r.iter_content(chunk_size=1 << 20):
                f.write(osa)
        tmp.rename(polku)
    return polku


def kasvisarake(gdf):
    """Etsii tekstisarakkeen, jossa on kasvin nimi."""
    for c in gdf.columns:
        if gdf[c].dtype == object and gdf[c].astype(str).str.contains("nurmi", case=False, na=False).any():
            return c
    raise SystemExit(f"Kasvin nimeä sisältävää saraketta ei löytynyt. Sarakkeet: {list(gdf.columns)}")


def sarake(gdf, kuvio):
    for c in gdf.columns:
        if re.search(kuvio, c, re.I):
            return c
    return None


def rajaus_tunnuksella(polku, taso, tunnus, vuosi):
    """Kirjoittaa peruslohkon kasvulohkot GeoJSON-tiedostoiksi (WGS84)."""
    import geopandas as gpd

    m = re.fullmatch(r"\s*(\d{10})(?:\s*[-/ ]\s*(\w+))?\s*", tunnus)
    if not m:
        raise SystemExit("Anna peruslohkotunnus kymmenellä numerolla, esim. 1641431471 tai 1641431471-2.")
    plt, nro = m.group(1), m.group(2)
    otos = gpd.read_file(polku, layer=taso, engine="pyogrio", rows=1)
    pcol = sarake(otos, r"peruslohko")
    if not pcol:
        raise SystemExit(f"Peruslohkotunnuksen saraketta ei löytynyt. Sarakkeet: {list(otos.columns)}")
    gdf = gpd.read_file(polku, layer=taso, engine="pyogrio", where=f"CAST({pcol} AS TEXT) = '{plt}'")
    if gdf.empty:
        print(f"{vuosi}: peruslohkoa {plt} ei löytynyt.")
        return 0
    ncol, kcol = sarake(gdf, r"^lohkonumero$|kasvulohko"), sarake(gdf, r"selite_fi|^kasvi$")
    if nro and ncol:
        gdf = gdf[gdf[ncol].astype(str) == nro]
    gdf = gdf.to_crs(4326)
    for _, r in gdf.iterrows():
        tun = f"{plt}-{r[ncol]}" if ncol else plt
        kasvi = str(r[kcol]) if kcol else None
        feat = {"type": "Feature", "properties": {"tunnus": tun, "kasvi": kasvi, "vuosi": vuosi,
                                                  "lahde": f"Ruokavirasto, kasvulohkot {vuosi} (CC BY 4.0)"},
                "geometry": r.geometry.__geo_interface__}
        out = pathlib.Path(f"lohko_{tun}.geojson")
        out.write_text(json.dumps(feat, ensure_ascii=False), encoding="utf-8")
        ala = gpd.GeoSeries([r.geometry], crs=4326).to_crs(3067).area.iloc[0] / 1e4
        print(f"{vuosi}: {tun} · {kasvi} · {ala:.2f} ha → {out}")
    return len(gdf)


def main():
    import geopandas as gpd
    import pyogrio

    ap = argparse.ArgumentParser()
    ap.add_argument("--vuodet", nargs="+", type=int, default=[2023, 2024, 2025])
    ap.add_argument("--alue", choices=ALUEET.keys(), default="etela-pohjanmaa")
    ap.add_argument("--data", default="data")
    ap.add_argument("--peruslohko", help="kirjoita tämän peruslohkon kasvulohkojen rajaukset GeoJSONina")
    a = ap.parse_args()

    if a.peruslohko:
        for v in sorted(a.vuodet, reverse=True):
            polku = lataa(v, pathlib.Path(a.data))
            if rajaus_tunnuksella(polku, pyogrio.list_layers(polku)[0][0], a.peruslohko, v):
                return
        raise SystemExit(f"Peruslohkoa {a.peruslohko} ei löytynyt vuosilta {a.vuodet}.")

    for v in a.vuodet:
        polku = lataa(v, pathlib.Path(a.data))
        tasot = pyogrio.list_layers(polku)
        taso = tasot[0][0]
        print(f"{v}: taso {taso}, tasoja {len(tasot)}")
        gdf = gpd.read_file(polku, layer=taso, bbox=ALUEET[a.alue], engine="pyogrio")
        if gdf.crs is not None and gdf.crs.to_epsg() != 3067:
            gdf = gdf.to_crs(3067)
        col = kasvisarake(gdf)
        sel = gdf[gdf[col].astype(str).str.contains(HAKU, na=False)].copy()
        sel["pinta_ala_ha"] = sel.geometry.area / 1e4
        out = pathlib.Path(f"niittolohkot_{v}.gpkg")
        sel.to_file(out, driver="GPKG")
        print(f"  lohkoja yhteensä {len(gdf)}, niittovelvoitteisia {len(sel)}, {sel.pinta_ala_ha.sum():.0f} ha → {out}")
        print(sel.groupby(col)["pinta_ala_ha"].agg(["count", "sum"]).sort_values("sum", ascending=False).round(1).to_string())


if __name__ == "__main__":
    main()
