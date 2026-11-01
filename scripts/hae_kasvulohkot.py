"""
Hakee Ruokaviraston avoimen kasvulohkoaineiston (INSPIRE GSAA, CC BY 4.0)
ja rajaa siitä niittovelvoitteiset lohkot (luonnonhoitonurmet, viherlannoitus-
nurmet, monimuotoisuuskasvit) valitulle alueelle.

Käyttö:
    pip install geopandas pyogrio requests
    python hae_kasvulohkot.py --vuodet 2023 2024 2025 --alue etela-pohjanmaa

Tuloste: niittolohkot_<vuosi>.gpkg (EPSG:3067) ja yhteenveto ruudulle.
Lähde: Ruokavirasto, INSPIRE-latauspalvelu. Mainitse lähde aineistoa käyttäessäsi.

Huom: koko maan tiedosto on suuri (satoja megatavuja). Skripti lataa sen
kerran kansioon data/ ja käyttää välimuistia.
"""
import argparse
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


def main():
    import geopandas as gpd
    import pyogrio

    ap = argparse.ArgumentParser()
    ap.add_argument("--vuodet", nargs="+", type=int, default=[2023, 2024, 2025])
    ap.add_argument("--alue", choices=ALUEET.keys(), default="etela-pohjanmaa")
    ap.add_argument("--data", default="data")
    a = ap.parse_args()

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
