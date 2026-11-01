# Niittoraportti

**Kun satelliitti ei näe niittoa.** Yksisivuinen selainsovellus, joka sisältää:

- kuvauksen siitä, miten Ruokavirasto todentaa luonnonhoitonurmien niiton satelliittiseurannalla ja Vipu-mobiilin kuvalla
- oikeusperustan, johon vaatimus vastata Vipu-mobiilin kameralla perustuu: EU-asetukset (EU) 2021/2116 ja 2022/1173 sekä laki 1334/2022, 21 §
- ehdotuksen porrastetusta todentamisesta HLS:llä ja PlanetScopella
- **niiton tunnistuksen**, joka seuraa Ruokaviraston satelliittiseurannan rakennetta (aikasarja → muutos → pysyvyys → todennäköisyysraja). Tunnistus toteutetaan avoimella Sen4CAP-niittoalgoritmilla (De Vroey ym. 2022), ja lähteinä ovat HLS, Sentinel-2, PlanetScope ja Sentinel-1-koherenssi. Tuloksena saadaan lisätietoteksti Vipu-mobiiliin ja toistettava JSON-raportti.

Kaikki laskenta tapahtuu selaimessa, eikä mitään tietoa lähetetä minnekään.

| Tiedosto | Sisältö |
| --- | --- |
| `index.html` | sovellus |
| `core.js` | tunnistuslogiikka ilman DOM-riippuvuuksia |
| `METHOD.md` | menetelmä, raja-arvot ja niiden lähteet, rajoitukset |
| `test/core.test.js` | yksikkötestit, aja komennolla `node test/core.test.js` |

## Käyttö

Avaa `index.html` selaimessa tai julkaise repo GitHub Pagesilla (Settings → Pages → Deploy from branch → `main` / root).

## Huomio

Sivu ei ole Ruokaviraston palvelu eikä oikeudellinen neuvo. Raportti ei nykyisellään korvaa Vipu-mobiilin kuvaa. Omia raja-arvoja ei ole kalibroitu Suomen maastoaineistolla. Tilanne 1.11.2026.
