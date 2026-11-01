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

## Lisenssi

Niittoraportti julkaistaan [PolyForm Small Business 1.0.0](LICENSE.md) -lisenssillä. Lisenssi ei ole OSI:n määritelmän mukainen avoimen lähdekoodin lisenssi, vaan lähdekoodi on nähtävillä ja maksutonta käyttää pienille toimijoille.

**Maksutonta, kun**

- käytät sovellusta omaan tai oman yrityksesi hyväksi ja yrityksessäsi on alle 100 työntekijää ja ulkopuolista tekijää ja edellisen tilikauden liikevaihto alle 1 000 000 USD (vuoden 2019 rahassa, inflaatiokorjattuna). Lähes kaikki maatilat täyttävät ehdon. Konsernin osana toimivan yrityksen luvut lasketaan koko konsernista.
- käyttö kuuluu alla olevan lisäluvan piiriin.

Maksuttomaan käyttöön sisältyy oikeus muokata koodia ja jakaa sitä eteenpäin, kunhan lisenssiehdot ja `Required Notice` -rivi kulkevat mukana.

**Muut tarvitsevat erillisen kaupallisen lisenssin.** Tällaisia ovat esimerkiksi kokorajat ylittävät yritykset, ohjelmistotoimittajat ja konsernit, jotka haluavat käyttää koodia tai rakentaa sen päälle palvelun. Lisenssiä voi tiedustella osoitteesta https://github.com/joriim/Niittoraportti/issues.

### Lisälupa: viranomaiset, tutkimus ja opetus

PolyForm-ehtojen lisäksi lisenssinantaja myöntää maksuttoman, ei-siirrettävän luvan käyttää ja muokata ohjelmistoa seuraaviin tarkoituksiin toimijan koosta riippumatta:

1. viranomainen käyttää ohjelmistoa sille toimitetun niittoraportin tarkistamiseen ja laskennan toistamiseen
2. tutkimus- ja oppilaitokset käyttävät ohjelmistoa ei-kaupalliseen tutkimukseen ja opetukseen.

Lisälupaan sovelletaan PolyForm-lisenssin Notices-, Patent Defense-, Violations- ja No Liability -kohtia.

Tämä suomenkielinen kuvaus on tiivistelmä. Sitovat ehdot ovat [LICENSE.md](LICENSE.md)-tiedostossa ja yllä olevassa lisäluvassa.
