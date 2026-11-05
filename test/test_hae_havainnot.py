"""
Skriptin hae_havainnot.py laskennan testi samoilla synteettisillä kuvilla kuin selainversiolla.
Tulosten on oltava samat kuin test/datahaku.test.js:ssä.

    pip install rasterio numpy pyproj shapely requests
    python test/test_hae_havainnot.py
"""
import argparse
import pathlib
import sys

D = pathlib.Path(__file__).parent
sys.path.insert(0, str(D.parent / "scripts"))
import hae_havainnot as H  # noqa: E402

FX = D / "fixtures"
a = argparse.Namespace(puskuri=10, pudotus=0.12, kelvolliset=50)
lohko = H.lue_lohko(FX / "field.geojson")
assert abs(lohko["ala_m2"] - 60000) < 1, lohko["ala_m2"]


def hls(src, pvm, kid, pref, nir):
    return H.hls_kuva(src, pvm, kid, [FX / f"{pref}.B04.tif", FX / f"{pref}.{nir}.tif", FX / f"{pref}.Fmask.tif"], lohko, a)


raaka = [
    hls("HLS-S30", "2026-07-10", "k1", "hls1", "B8A"),
    hls("HLS-L30", "2026-07-20", "k2", "hls2", "B05"),
    hls("HLS-S30", "2026-08-05", "k3", "hls3", "B8A"),
    hls("HLS-S30", "2026-08-05", "k4", "hls4", "B8A"),
    hls("HLS-L30", "2026-08-15", "k5", "hls5", "B05"),
]
assert raaka[0]["n"] == 54, raaka[0]["n"]
obs = {o["pvm"]: o for o in H.viimeistele(raaka, a)}
assert list(obs) == ["2026-07-10", "2026-07-20", "2026-08-05", "2026-08-15"], list(obs)
assert (obs["2026-07-10"]["arvo"], obs["2026-07-10"]["kelvolliset"], obs["2026-07-10"]["muuttunut"]) == (0.8, 100, None)
assert (obs["2026-07-20"]["arvo"], obs["2026-07-20"]["kelvolliset"]) == (0.45, 33)
assert obs["2026-08-05"]["id"] == "k3"
assert (obs["2026-08-05"]["arvo"], obs["2026-08-05"]["kelvolliset"], obs["2026-08-05"]["muuttunut"]) == (0.45, 100, 94), obs["2026-08-05"]
assert (obs["2026-08-15"]["arvo"], obs["2026-08-15"]["kelvolliset"], obs["2026-08-15"]["muuttunut"]) == (0.55, 84, 6)
print("ok HLS:", [(o["pvm"], o["arvo"], o["kelvolliset"], o["muuttunut"]) for o in obs.values()])

ps = [H.ps_kuva(i, FX / f"{i}_3B_AnalyticMS_SR_harmonized_clip.tif", FX / f"{i}_3B_udm2_clip.tif", lohko, a)
      for i in ("20260801_093000_00_2475", "20260810_093100_00_2475")]
p = H.viimeistele(ps, a)
assert [(o["pvm"], o["arvo"], o["kelvolliset"], o["muuttunut"]) for o in p][0] == ("2026-08-01", 0.83, 100, None)
assert (p[1]["pvm"], p[1]["arvo"], p[1]["kelvolliset"], p[1]["muuttunut"]) == ("2026-08-10", 0.4, 93, 100)
print("ok PlanetScope:", [(o["pvm"], o["arvo"], o["kelvolliset"], o["muuttunut"]) for o in p])

out = D / "_tmp.csv"
H.kirjoita(H.viimeistele(raaka, a), out)
rivit = out.read_text(encoding="utf-8").splitlines()
out.unlink()
assert rivit[0].startswith("#") and rivit[3] == "2026-08-05;HLS-S30;k3;0.450;100;94", rivit
print("ok CSV-muoto")

# 0 % kelvollisia: rivi säilyy tyhjällä NDVI:llä
tyhja = dict(raaka[0], pvm="2026-07-01", id="k0", arvo=None, n=0)
v = H.viimeistele([tyhja] + raaka, a)
assert (v[0]["pvm"], v[0]["arvo"], v[0]["kelvolliset"]) == ("2026-07-01", None, 0), v[0]
print("ok 0 % havainto säilyy")

# Sentinel-1: sama muunnos kuin datahaku.js:ssä
st = lambda m, n, nd: {"stats": {"mean": m, "sampleCount": n, "noDataCount": nd}}
js = {"data": [
    {"interval": {"from": "2026-07-02T00:00:00Z"}, "outputs": {"s1": {"bands": {"B0": st(0.1, 100, 0), "B1": st(0.02, 100, 0)}}}},
    {"interval": {"from": "2026-07-03T00:00:00Z"}, "outputs": {"s1": {"bands": {"B0": st("NaN", 100, 100), "B1": st("NaN", 100, 100)}}}},
    {"interval": {"from": "2026-07-08T00:00:00Z"}, "outputs": {"s1": {"bands": {"B0": st(0.1, 100, 70), "B1": st(0.02, 100, 70)}}}},
]}
s1 = H.s1_jasenna(js, "ASCENDING")
assert [(o["pvm"], o["arvo"], o["kelvolliset"], o["id"]) for o in s1] == [("2026-07-02", -16.99, 100, "S1 GRD ASC 2026-07-02 VV -10.00 dB")], s1
req = H.s1_pyynto(lohko, "2026-07-01", "2026-07-31", "DESCENDING")
assert req["input"]["data"][0]["processing"]["backCoeff"] == "GAMMA0_TERRAIN"
assert req["input"]["bounds"]["properties"]["crs"].startswith("http://www.opengis.net/def/crs/EPSG/0/326")
out = D / "_s1.csv"
H.kirjoita(s1 + [v[0]], out)
r = out.read_text(encoding="utf-8").splitlines(); out.unlink()
assert r[1] == "2026-07-02;Sentinel-1 VH;S1 GRD ASC 2026-07-02 VV -10.00 dB;-16.99;100;" and r[2] == "2026-07-01;HLS-S30;k0;;0;", r
assert req["aggregation"]["timeRange"]["to"] == "2026-08-01T00:00:00Z"
radat = H.s1_radat([{"pvm": "2026-07-02", "suunta": "ASCENDING", "rata": None, "min": 965.2}, {"pvm": "2026-07-08", "suunta": "ASCENDING", "rata": None, "min": 965.4},
                    {"pvm": "2026-07-03", "suunta": "ASCENDING", "rata": None, "min": 947.5}, {"pvm": "2026-07-04", "suunta": "DESCENDING", "rata": 22, "min": 285}])
assert radat == {("2026-07-03", "ASCENDING"): "klo 15:48", ("2026-07-02", "ASCENDING"): "klo 16:05", ("2026-07-08", "ASCENDING"): "klo 16:05", ("2026-07-04", "DESCENDING"): "rata 22"}, radat
assert H.s1_jasenna(js, "ASCENDING", radat=radat)[0]["id"] == "S1 GRD ASC klo 16:05 2026-07-02 VV -10.00 dB"
print("ok Sentinel-1")
