# Niittoraportti – menetelmäkuvaus

Versio 2.0.0 · 1.11.2026 · koodi: [`core.js`](core.js) · testit: [`test/core.test.js`](test/core.test.js)

## Tarkoitus

Niittoraportti tunnistaa nurmilohkon niiton satelliittihavaintojen aikasarjasta. Tulos kirjoitetaan toistettavaksi raportiksi, jonka viljelijä tai neuvoja voi liittää satelliittiseurannan selvityspyynnön lisätietoihin. Raportti ei nykyisellään korvaa Vipu-mobiilin kuvaa. Sen huomioiminen on käsittelijän harkinnassa.

## Lähtökohta: sama rakenne kuin Ruokaviraston järjestelmässä

Ruokaviraston satelliittiseuranta (CGI:n toteuttama) toimii näin:

1. Ilmatieteen laitos esikäsittelee Sentinel-1- ja Sentinel-2-kuvat analyysivalmiiksi.
2. Lohkoilta irrotetaan signaalien aikasarjat.
3. Koneoppimismalli ennustaa lohkon tilan (kasvussa, niitetty, muokattu, sadonkorjuu, tuleentuminen) eri ajankohtina.
4. Kullekin tilalle on oma todennäköisyysraja. Havainnot perustuvat signaalien muutokseen ja muutoksen pysyvyyden varmistamiseen. [R5][R6]

Ruokaviraston malli ja sen raja-arvot eivät ole julkisia. Niittoraportti toteuttaa siksi saman rakenteen avoimella, vertaisarvioidulla menetelmällä: Sen4CAP-niittotunnistuksella (De Vroey ym. 2022 [L2]). Sen4CAP on ESA:n EU:n maksajavirastoille kehittämä satelliittiseurannan järjestelmä, ja sen niittoalgoritmi käyttää samoja lähteitä kuin Ruokavirasto, eli Sentinel-1:tä ja -2:ta. Niittoraportti lisää lähteiksi HLS:n [L1] ja PlanetScopen.

## Syötteet

Käyttäjä syöttää yhden rivin havaintoa kohden.

| Kenttä | Optiset lähteet | Sentinel-1 |
| --- | --- | --- |
| Päivä | kuvauspäivä | koherenssiparin jälkimmäinen päivä |
| Lähde | HLS-S30, HLS-L30, Sentinel-2, PlanetScope | Sentinel-1 koherenssi |
| Kuvatunniste | HLS granule id / PlanetScope item id | kuvaparin tunniste |
| Arvo | lohkon NDVI-mediaani | lohkon VH-koherenssin keskiarvo |
| Kelvolliset % | pilvettömien pikselien osuus (HLS: Fmask, PlanetScope: UDM2 clear) | – |
| Muuttunut % | pikselien osuus, joissa NDVI laski ≥ kynnyksen edellisestä havainnosta | – |

Pikselitason laskenta (NDVI, maskit, osuudet) tehdään ennen työkalua, esimerkiksi hakuohjeiden skripteillä. Lohko kutistetaan ennen laskentaa reunapuskurin verran (oletus 10 m), koska kutistettu lohko parantaa tunnistusta [L4] ja Sen4CAP käyttää vain kokonaan lohkon sisällä olevia pikseleitä [L2].

## Algoritmi

| # | Vaihe | Sääntö | Oletus | Peruste |
| --- | --- | --- | --- | --- |
| 1 | Karsinta | Optinen havainto hylätään, jos kelvollisia pikseleitä on alle rajan | 50 % | oma |
| 2 | Sensoriperheet | Ilmaisin ajetaan erikseen HLS-, S2-, PlanetScope- ja S1-sarjoille. HLS S30 ja L30 ovat yksi sarja. | – | HLS-harmonisointi [L1]; PlanetScopen ja S2:n kaistaerot [L6] |
| 3 | Optinen ilmaisin | Pudotus edelliseen saman perheen havaintoon on vähintään kynnyksen suuruinen | 0,12 | pohjoisten maiden kynnys [L2] |
| 3b | Väli | Enimmäisväli kahden havainnon välillä | 60 vrk | Δt<sub>max</sub> [L2] |
| 4 | Pysyvyys | Jos seuraava ≤ 10 vrk:n sisällä oleva havainto palaa alle puolen kynnyksen päähän lähtötasosta (c > ennen − kynnys/2), pudotus hylätään pilvenä tai varjona. Jos havaintoa ei ole, luottamus kerrotaan 0,85:llä. | 10 vrk | Ruokaviraston pysyvyysperiaate [R5]; ikkuna oma |
| 4b | Hidas muutos | Yli 14 vrk:n välillä luottamus kerrotaan 0,9:llä (tuleentuminen tai kuivuus mahdollinen) | 14 vrk | oma |
| 5 | Tutkailmaisin | VH-koherenssi ylittää kuuden edellisen arvon lineaarisovitteen ennusteen (hetkelle t−1) kσ:lla; vähintään 4 aiempaa arvoa | k = 5,0 | CFAR, P<sub>fa</sub> = 3·10⁻⁷ [L2]; koherenssi nousee niiton jälkeen [L5] |
| 6 | Luottamus | Optinen: 0,5 + 0,5·min(1, (pudotus − kynnys)/0,25). Tutka: 0,25 + 0,25·min(1, (z − k)/k). | – | asteikot optinen 0,5–1, tutka 0–0,5 [L2]; kaava oma |
| 7 | Yhdistäminen | Päällekkäiset tunnistukset yhdistetään ja väli tarkennetaan leikkaukseen. Jokainen uusi sensoriperhe lisää luottamusta 0,15·(c/0,5). | – | S1+S2-yhdistäminen [L2]; lisäys oma |
| 8 | Tapahtumat | Alle 28 vrk:n päässä toisistaan olevista pidetään varmempi; enintään 4 | 28 vrk, 4 | Δt<sub>min</sub> ja enimmäismäärä [L2] |
| 9 | Todennäköisyysraja | Tapahtuma hyväksytään, kun luottamus ≥ raja. Tutka yksin (≤ 0,5) ei riitä. | 0,6 | oma; vrt. status-kohtainen raja [R5] |
| 10 | Tukiehto | Niittoväliä verrataan toimenpiteen päivämääriin, ja suurimman muuttuneen osuuden on oltava ≥ raja | 90 % | päivämäärät [R4]; osuus oma |

### Näytön taso

Arvio tehdään varmimmasta hyväksytystä tapahtumasta.

- **Ei täyty:** jokin tukiehtotarkistus hylkää (esim. niitto 15.9. jälkeen tai alle 50 % lohkosta).
- **Vahva:** ei huomautuksia.
- **Kohtalainen:** 1–2 huomautusta.
- **Heikko:** 3 tai enemmän huomautusta.

Huomautuksiksi lasketaan vain päätunnistuksen (varmimman optisen, muuten tutkan) ja tukiehdon huomautukset. Tukihavaintojen huomautukset näytetään tietona, jotta lisälähde ei heikennä tapahtumaa, jonka vahvempi lähde jo vahvistaa.

### Tukiehtojen päivämäärät (peltovalvontaohje 2026 [R4])

| Toimenpide | Aikaisintaan | Viimeistään |
| --- | --- | --- |
| Luonnonhoitonurmi | – | 15.9. (vähintään joka toinen vuosi) |
| Viherlannoitusnurmi (ekojärjestelmätuki) | – | 15.9. (vähintään joka toinen vuosi) |
| Monimuotoisuuskasvi | 1.8. (pääasiallisen kukinnan jälkeen) | – |
| Nurmi tai kesanto (niittovaatimus) | – | 15.9. |

Joka toisen vuoden vaatimusta ja kasvuston säilyttämisajan päivämääriä ei tarkisteta.

## Tulosteet

- **Lisätietoteksti** Vipu-mobiiliin (noin 350–450 merkkiä). Muotoilu on tarkoituksella varovainen ("satelliittihavainnot viittaavat niittoon"), ja tekstiin tulevat väli, luottamus, NDVI ennen ja jälkeen, muuttunut osuus, kuvatunnisteet, versio ja puskuri. Vipu-mobiilin lisätietokentän enimmäispituutta ei ole tarkistettu.
- **JSON-raportti:** kaikki havainnot, poisjätetyt havainnot syineen, hylätyt pudotukset syineen, tapahtumat tunnistuksineen, kaikki parametrit, versio ja lähdeviitteet. Näillä tiedoilla käsittelijä voi toistaa laskennan.

## Validointi ja rajoitukset

- Sen4CAP-menetelmän paras F1 oli 76 % kuuden maan Planet-validoinnissa. Wallonian maastovalidoinnissa laidunnus aiheutti suuren osan vääristä tunnistuksista, ja pelkillä niitetyillä lohkoilla F1 oli 79 % [L2]. Optisilla aikasarjoilla on tavoitettu 77 % niitoista [L4], ja yhden niiton lohkoilla puuttuvia tunnistuksia on ollut paljon [L3].
- Omia raja-arvoja (merkitty "oma") ei ole kalibroitu Suomen maastoaineistolla. Ne pitää testata pilotissa, esimerkiksi Ruokaviraston laadunarvioinnin maastoaineistoa vasten.
- Sade alentaa koherenssia ja voi peittää niiton [L5].
- Laidunnus ja niitto erottuvat huonosti.
- Työkalu luottaa käyttäjän syöttämiin NDVI- ja osuuslukuihin. Toistettavuus perustuu siihen, että tunnisteet ja parametrit raportoidaan.

## Yksikkötestit

`node test/core.test.js` testaa seuraavat tapaukset:

- usean lähteen niitto
- sensorirajan ylittävä pudotus
- palautuva pudotus (pilvi)
- vähän kelvollisia pikseleitä
- myöhäinen niitto
- liian aikainen niitto (monimuotoisuuskasvi)
- osittainen niitto
- tutka yksin ja vahvistajana
- kaksi niittoa ≥ 28 vrk välein
- raporttitekstin muotoilu
- tukihavaintojen huomautukset vahvassa tapahtumassa

## Lähteet

**Menetelmä**

- [L1] Claverie, M., Ju, J., Masek, J. G., Dungan, J. L., Vermote, E. F., Roger, J.-C., Skakun, S. V. & Justice, C. (2018). The Harmonized Landsat and Sentinel-2 surface reflectance data set. *Remote Sensing of Environment*. https://doi.org/10.1016/j.rse.2018.09.002
- [L2] De Vroey, M., de Vendictis, L., Zavagli, M., Bontemps, S., Heymans, D., Radoux, J., Koetz, B. & Defourny, P. (2022). Mowing detection using Sentinel-1 and Sentinel-2 time series for large scale grassland monitoring. *Remote Sensing of Environment* 280, 113145. https://doi.org/10.1016/j.rse.2022.113145
- [L3] Griffiths, P., Nendel, C., Pickert, J. & Hostert, P. (2020). Towards national-scale characterization of grassland use intensity from integrated Sentinel-2 and Landsat time series. *Remote Sensing of Environment*. https://doi.org/10.1016/j.rse.2019.03.017
- [L4] Kolecka, N., Ginzler, C., Pazur, R., Price, B. & Verburg, P. H. (2018). Regional scale mapping of grassland mowing frequency with Sentinel-2 time series. *Remote Sensing* 10(8), 1221. https://doi.org/10.3390/rs10081221
- [L5] Tamm, T., Zalite, K., Voormansik, K. & Talgre, L. (2016). Relating Sentinel-1 interferometric coherence to mowing events on grasslands. *Remote Sensing* 8(10), 802. https://doi.org/10.3390/rs8100802
- [L6] Baldin, C. M. & Casella, V. M. (2026). Radiometric intercalibration methodologies for high-resolution satellite imagery in precision agriculture. *ISPRS Archives* XLIX-B1-2026, 231–238. https://doi.org/10.5194/isprs-archives-XLIX-B1-2026-231-2026

**Sääntely ja hallinto**

- [R1] Asetus (EU) 2021/2116. https://eur-lex.europa.eu/eli/reg/2021/2116/oj
- [R2] Komission täytäntöönpanoasetus (EU) 2022/1173, konsolidoitu 8.9.2024. https://eur-lex.europa.eu/eli/reg_impl/2022/1173/2024-09-08/eng
- [R3] Laki 1334/2022 (alkuperäinen sanamuoto). https://faolex.fao.org/docs/pdf/fin225121.pdf
- [R4] Ruokavirasto: Peltovalvontaohje 2026. https://www.ruokavirasto.fi/globalassets/tuet/maatalous/valvonta/peltovalvontaohje.pdf
- [R5] Ruokavirasto: Kevään 2026 selvityspyynnöt ja syysilmoituksen muuttaminen (10.3.2026). https://www.ruokavirasto.fi/globalassets/yhteisot/neuvojien-aineistot/10032026_kevaan_2026_selvityspyynnot_ja_syysilmoituksen_muuttaminen_10032026.pdf
- [R6] CGI: Ruokavirasto siivittää vihreää maataloutta avaruusdatalla. https://www.cgi.com/fi/fi/asiakasesimerkki/cgi-ruokaviraston-kumppanina-avaruusdatan-hyodyntamisessa
