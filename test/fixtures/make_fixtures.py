"""
Tuottaa datahaun testien synteettiset GeoTIFF-kuvat (keksittyä dataa, ei oikeita kuvia).

    pip install rasterio pyproj numpy
    python test/fixtures/make_fixtures.py

Lohko: suorakaide EPSG:3067 E 290000–290300, N 6965000–6965200 (field.geojson).
"""
import json
import pathlib

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.transform import from_origin

D = pathlib.Path(__file__).parent
E0, E1, N0, N1 = 290000, 290300, 6965000, 6965200


def refl(ndvi, red=1000):
    """Punainen ja NIR-heijastus (×10 000), joilla saadaan haluttu NDVI."""
    return red, int(round(red * (1 + ndvi) / (1 - ndvi)))


def write(name, arrays, crs, transform, dtype, nodata=None):
    arr = np.stack(arrays).astype(dtype)
    with rasterio.open(D / name, "w", driver="GTiff", width=arr.shape[2], height=arr.shape[1], count=arr.shape[0],
                       dtype=dtype, crs=crs, transform=transform, nodata=nodata, compress="deflate",
                       tiled=True, blockxsize=16, blockysize=16) as ds:
        ds.write(arr)


def hls(prefix, crs, ox, oy, w, h, ndvi_fn, fmask_fn, nir_band):
    tr = from_origin(ox, oy, 30, 30)
    red = np.zeros((h, w)); nir = np.zeros((h, w)); fm = np.zeros((h, w))
    to3067 = Transformer.from_crs(crs, 3067, always_xy=True)
    for r in range(h):
        for c in range(w):
            x, y = ox + (c + 0.5) * 30, oy - (r + 0.5) * 30
            e, n = to3067.transform(x, y)
            rd, ni = refl(ndvi_fn(e, n))
            red[r, c], nir[r, c], fm[r, c] = rd, ni, fmask_fn(e, n)
    write(f"{prefix}.B04.tif", [red], crs, tr, "int16", -9999)
    write(f"{prefix}.{nir_band}.tif", [nir], crs, tr, "int16", -9999)
    write(f"{prefix}.Fmask.tif", [fm], crs, tr, "uint8", 255)


# 1) 10.7. S30, NDVI 0,80, pilvetön
hls("hls1", "EPSG:32635", 289800, 6965400, 20, 15, lambda e, n: 0.80, lambda e, n: 64, "B8A")
# 2) 20.7. L30, NDVI 0,45, pohjoisosa pilvessä (Fmask bitti 1) → kelvollisia alle 50 %
hls("hls2", "EPSG:32635", 289800, 6965400, 20, 15, lambda e, n: 0.45, lambda e, n: 2 if n > 6965080 else 0, "B05")
# 3) 5.8. S30, niitetty: NDVI 0,45, kolme pikseliä 0,80
keep = {(290025, 6965175), (290055, 6965175), (290085, 6965175)}
hls("hls3", "EPSG:32635", 289800, 6965400, 20, 15,
    lambda e, n: 0.80 if (round(e), round(n)) in keep else 0.45, lambda e, n: 0, "B8A")
# 4) 5.8. S30 toisesta ruudusta, kokonaan pilvessä → karsiutuu
hls("hls4", "EPSG:32635", 289800, 6965400, 20, 15, lambda e, n: 0.30, lambda e, n: 8, "B8A")
# 5) 15.8. L30 vyöhykkeen 34 ruudukossa, NDVI 0,55; itäreunassa korkea aerosoli (192), vesi (32) kelpaa
t = Transformer.from_crs(3067, 32634, always_xy=True)
xs, ys = zip(*[t.transform(e, n) for e in (E0, E1) for n in (N0, N1)])
ox, oy = np.floor(min(xs) / 30) * 30 - 60, np.ceil(max(ys) / 30) * 30 + 60
w, h = int((max(xs) - ox) // 30 + 3), int((oy - min(ys)) // 30 + 3)
hls("hls5", "EPSG:32634", ox, oy, w, h, lambda e, n: 0.55, lambda e, n: 192 if e > 290240 else 32, "B05")

# PlanetScope: 3 m, 4 kaistaa (B, G, R, NIR) ja UDM2 (8 kaistaa, 1 = clear), rajattu lohkoon
def ps(name, ndvi, clear_fn):
    ox, oy, w, h = E0 - 6, N1 + 6, 104, 71
    tr = from_origin(ox, oy, 3, 3)
    b = np.zeros((4, h, w)); u = np.zeros((8, h, w))
    for r in range(h):
        for c in range(w):
            x, y = ox + (c + 0.5) * 3, oy - (r + 0.5) * 3
            if not (E0 < x < E1 and N0 < y < N1):
                continue  # rajauksen ulkopuolella nodata 0
            rd, ni = refl(ndvi)
            b[:, r, c] = (500, 800, rd, ni)
            u[0, r, c] = 1 if clear_fn(x, y) else 0
            u[2, r, c] = 0 if clear_fn(x, y) else 1
    write(f"{name}_3B_AnalyticMS_SR_harmonized_clip.tif", list(b), "EPSG:32635", tr, "uint16", 0)
    write(f"{name}_3B_udm2_clip.tif", list(u), "EPSG:32635", tr, "uint8")


ps("20260801_093000_00_2475", 0.83, lambda x, y: True)
ps("20260810_093100_00_2475", 0.40, lambda x, y: x < 290270)  # itäreuna pilvessä

json.dump({"type": "Feature", "properties": {"tunnus": "TESTI-1"},
           "geometry": {"type": "Polygon", "coordinates": [[[E0, N0], [E1, N0], [E1, N1], [E0, N1], [E0, N0]]]}},
          open(D / "field.geojson", "w"))
print("valmis:", sorted(p.name for p in D.glob("*.tif")))
