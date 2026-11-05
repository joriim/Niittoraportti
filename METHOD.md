# Niittoraportti – menetelmäkuvaus

Versio 2.2.0 · 5.11.2026 · koodi: [`core.js`](core.js), [`datahaku.js`](datahaku.js) · testit: [`test/`](test/)

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
| Päivä | kuvauspäivä | kuvauspäivä (VH) tai koherenssiparin jälkimmäinen päivä |
| Lähde | HLS-S30, HLS-L30, Sentinel-2, PlanetScope | Sentinel-1 VH, Sentinel-1 koherenssi |
| Kuvatunniste | HLS granule id / PlanetScope item id | `S1 GRD ASC\|DESC päivä VV x dB` tai kuvaparin tunniste; ASC/DESC tai `rata N` erottaa kuvausgeometriat |
| Arvo | lohkon NDVI-mediaani; tyhjä, jos kelvollisia pikseleitä ei ole | VH-takaisinsironta γ⁰ dB / VH-koherenssin keskiarvo |
| Kelvolliset % | pilvettömien pikselien osuus (HLS: Fmask, Sentinel-2: SCL + sininen kanava, PlanetScope: UDM2 clear); 0 % -rivit näytetään pois jätettyinä | VH: pikselit, joilla on dataa |
| Muuttunut % | pikselien osuus, joissa NDVI laski ≥ kynnyksen edellisestä havainnosta | – |

Havainnot voi syöttää käsin, tuoda CSV:nä tai hakea työkalun datahaulla (ks. alla). Lohko kutistetaan ennen laskentaa reunapuskurin verran (oletus 10 m), koska kutistettu lohko parantaa tunnistusta [L4] ja Sen4CAP käyttää vain kokonaan lohkon sisällä olevia pikseleitä [L2].

## Datahaku

Pikselitason laskennan tekevät selaimessa [`datahaku.js`](datahaku.js) ja komentorivillä [`scripts/hae_havainnot.py`](scripts/hae_havainnot.py). Molemmat laskevat saman tuloksen, ja testit varmistavat sen samoilla synteettisillä kuvilla.

| Vaihe | HLS v2.0 (S30, L30) | PlanetScope |
| --- | --- | --- |
| Lähde | Microsoft Planetary Computer (`hls2-s30`, `hls2-l30`), ei tunnusta. Skriptissä vaihtoehtona NASA LP DAAC (`HLSS30_2.0`, `HLSL30_2.0`) Earthdata-tokenilla. | Planet Data API (`PSScene`, `ortho_analytic_4b_sr`), tilaus Orders API:lla: `analytic_sr_udm2`, työkalut `clip` (lohko) ja `harmonize` (Sentinel-2) |
| Kuvavalinta | kuvan pilvisyys ≤ raja (oletus 80 %) | päivää kohden suurin `clear_percent` |
| Lohkon pikselit | pikselin keskipiste lohkon sisällä ja vähintään reunapuskurin päässä reunasta | sama |
| Kelvollinen pikseli | Fmask: ei sirrusta, pilveä, pilven viereistä, varjoa eikä lunta (bitit 0–4), aerosoli ei korkea (bitit 6–7 ≠ 11); punainen ja NIR > 0 | UDM2 clear = 1; punainen ja NIR > 0 |
| NDVI | S30 (B8A − B04)/(B8A + B04), L30 (B05 − B04)/(B05 + B04) | (NIR − R)/(NIR + R), kaistat 4 ja 3 |
| Arvo | kelvollisten pikselien NDVI-mediaani | sama |
| Kelvolliset % | kelvolliset / lohkon pikselit | sama |
| Muuttunut % | osuus kelvollisista pikseleistä, joissa NDVI laski ≥ kynnyksen (oletus 0,12) verrattuna edelliseen saman perheen havaintoon, jossa kelvollisia oli ≥ raja (oletus 50 %). Vertailu tehdään pikselin keskipisteen kohdalta edellisen kuvan ruudukossa, tarvittaessa koordinaatistomuunnoksen kautta. Arvo jätetään tyhjäksi, jos verrattavia pikseleitä on alle puolet. | sama |
| Saman päivän kuvat | pidetään kuva, jossa on eniten kelvollisia pikseleitä | sama |

Haku lukee jokaisesta kuvasta ensin pilvimaskin (HLS: Fmask, Sentinel-2: SCL) lohkon kohdalta. Jos lohkolla ei ole yhtään kelvollista pikseliä, muita kaistoja ei avata, ja päivä kirjataan pois jätetyksi (kelvolliset 0 %). Tulos on sama kuin ennen, mutta suomalaisen kesän pilvisistä kuvista luetaan vain maski. HLS ja Sentinel-2 haetaan rinnakkain, ja saman istunnon toistuva haku samalle lohkolle ja aikavälille käyttää aiempaa tulosta.

**Sentinel-2 L2A ilman HLS:ää.** Sovellus hakee myös ESA:n Sentinel-2 L2A -kuvat Planetary Computerista (`sentinel-2-l2a`, ei tunnusta). NDVI lasketaan 10 metrin kaistoista (B08 − B04)/(B08 + B04). Pilvet poistetaan Scene Classification -kerroksella (SCL, 20 m): kelvollisia ovat luokat 4 kasvillisuus ja 5 paljas maa. Luokka 6 (vesi) hylätään, koska pellolla se on yleensä pilven varjo tai usva. Lisäksi hylätään pikselit, joiden sininen heijastus (B02) on yli 0,10, mikä poistaa ohuen pilven ja usvan, jota SCL ei tunnista. Pilvitodennäköisyyskerrosta (MSK_CLDPRB) Planetary Computerissa ei ole. Jokaiselle 10 m pikselille haetaan sen 20 m SCL-solu. Prosessointiversiosta 04.00 alkaen (25.1.2022) heijastusarvoista vähennetään siirtymä 1000 ennen NDVI:n laskemista. Lohkon pikselit, muuttunut osuus ja saman päivän valinta lasketaan kuten HLS:lle. Sentinel-2 on oma sensoriperheensä (S2).

**HLS:n ja L2A:n yhdistäminen** (`core.fuse`). Sentinel-2 L2A ja HLS S30 perustuvat samoihin kuviin, joten niitä ei lasketa toisistaan riippumattomiksi lähteiksi. Kun molemmat on haettu, ne yhdistetään päivämäärittäin yhdeksi sarjaksi (perhe HLS):

- HLS (S30 + L30) on pääsarja. L2A täyttää päivät, joilta HLS-S30-granuli puuttuu tai on maskin hylkäämä.
- Jos saman päivän maskit ovat ristiriidassa (toinen hylkää kuvan pilvenä, toinen pitää sitä selkeänä) tai arvot poikkeavat yli 0,15, havainto merkitään epävarmaksi. Pudotus, jonka toisena päänä on epävarma havainto, saa huomautuksen ja luottamus kerrotaan 0,85:llä.
- Ilman HLS-havaintoja L2A on pääsarja sellaisenaan.

**Sentinel-1 VH-takaisinsironta.** Sovellus hakee Sentinel-1 GRD -kuvien maastokorjatun takaisinsironnan (γ⁰, `GAMMA0_TERRAIN`, Copernicus DEM 30 m) Copernicus Data Space Ecosystemin Statistical API:sta lohkon keskiarvona kuvauspäivittäin (`P1D`). Nousevat ja laskevat radat haetaan erikseen. Aikaväli päättyy loppupäivää seuraavan vuorokauden alkuun, jotta viimeinen päivä tulee mukaan kokonaan. Arvo muunnetaan desibeleiksi: 10·log₁₀(VH), ja VV tallennetaan tunnisteeseen.

Suomessa samaan suuntaan kuvataan useilta suhteellisilta radoilta, joiden tulokulma eroaa, ja ratojen tasoero voi olla useita desibelejä. Sovellus hakee siksi Catalog API:sta kuvausluettelon ja merkitsee jokaisen kuvauksen radan: ratanumeron (`sat:relative_orbit`), jos se on luettelossa, ja muuten kellonajan (`klo 16:05`). Sama rata ohittaa lohkon samaan aikaan (± muutama sekunti) 6–12 vrk välein satelliitista riippumatta, joten kellonajat ryhmitellään ± 3 minuutin tarkkuudella. Päivä, jona samasta suunnasta on kaksi rataa, jätetään pois, koska päivän mosaiikki sekoittaisi geometriat. Jos luettelo ei vastaa, erotellaan vain suunnan mukaan. Haku varoittaa, jos lohkolla on alle 30 tutkapikseliä (≈ 0,3 ha) tai radalla alle 4 kuvausta. Haku vaatii maksuttoman CDSE OAuth -asiakkaan. Jos selain ei saa kutsua suoraan, se kulkee välityspalvelimen polkujen `/cdse/token` ja `/cdse/statistics` kautta. Ruokaviraston käyttämää 12 vrk koherenssia CDSE ei laske. Itse laskettuna (esim. ASF HyP3) sen voi tuoda CSV:nä.

**Määräpäivän yli.** Oletusjakso päättyy 15.10., jotta 15.9. jälkeen saadaan 1–2 selkeää kuvaa. Niiton puuttumista ei todeta, jos määräpäivän jälkeen on alle 2 selkeää kuvaa, ja määräpäivää lähellä olevaan niittoon tulee huomautus.

Datahaussa lohkon rajaus lähetetään hakupalveluun. Planet-API-avain on vain selaimen muistissa (valinnaisesti välilehden istuntomuistissa), eikä sitä tallenneta raporttiin. Jos Planet ei salli kutsua selaimesta (CORS), käytetään skriptiä.

## Algoritmi

| # | Vaihe | Sääntö | Oletus | Peruste |
| --- | --- | --- | --- | --- |
| 1 | Karsinta | Optinen havainto hylätään, jos kelvollisia pikseleitä on alle rajan | 50 % | oma |
| 2 | Sensoriperheet | Ilmaisin ajetaan erikseen HLS-, S2-, PlanetScope- ja S1-sarjoille. HLS S30 ja L30 ovat yksi sarja. | – | HLS-harmonisointi [L1]; PlanetScopen ja S2:n kaistaerot [L6] |
| 3 | Optinen ilmaisin | Pudotus edelliseen saman perheen havaintoon on vähintään kynnyksen suuruinen | 0,12 | pohjoisten maiden kynnys [L2] |
| 3b | Väli | Enimmäisväli kahden havainnon välillä | 60 vrk | Δt<sub>max</sub> [L2] |
| 4 | Pysyvyys | Seuraavan ≤ 10 vrk:n sisällä olevan havainnon on pysyttävä matalana tai palauduttava asteittain. Pudotus hylätään pilvenä tai varjona, jos havainto palaa alle puolen kynnyksen päähän lähtötasosta (c > ennen − kynnys/2) tai NDVI nousee yli 0,03/vrk. Jos havaintoa ei ole, luottamus kerrotaan 0,85:llä. | 10 vrk, 0,03/vrk | Ruokaviraston pysyvyysperiaate [R5]; ikkuna ja nopeus omia |
| 4c | Uskottavuus | Nurmen niitto laskee NDVI:tä tyypillisesti ≥ 0,2. Pienempi pudotus saa huomautuksen ja luottamus kerrotaan 0,8:lla, joten se ei yksin ylitä rajaa. | 0,2 | oma |
| 4d | Määräpäivä | Jos niitto päättyy alle 21 vrk ennen määräpäivää ja määräpäivän jälkeen on alle 2 selkeää kuvaa, tulee huomautus | 2 kuvaa | oma |
| 4b | Hidas muutos | Yli 14 vrk:n välillä luottamus kerrotaan 0,9:llä (tuleentuminen tai kuivuus mahdollinen) | 14 vrk | oma |
| 5b | Tutka, takaisinsironta | VH (dB) laskee saman radan kuuden edellisen arvon lineaarisovitteesta vähintään 1 dB ja 2σ (σ ≥ 0,5 dB); vähintään 3 aiempaa arvoa. Luottamus 0,2–0,4. Jos VV laskee samaan trendiin verrattuna ≥ 0,7 × VH:n lasku, muutos hylätään kosteutena (kuivuminen laskee molempia, niitto lähinnä VH:ta). Jos VH/VV-suhde laskee ≥ 1 dB, luottamukseen lisätään 0,05 (enintään 0,45). | 1 dB, 2σ, 0,7 | niitto vähentää tilavuussirontaa; kynnykset omia |
| 5 | Tutkailmaisin | VH-koherenssi ylittää kuuden edellisen arvon lineaarisovitteen ennusteen (hetkelle t−1) kσ:lla; vähintään 4 aiempaa arvoa | k = 5,0 | CFAR, P<sub>fa</sub> = 3·10⁻⁷ [L2]; koherenssi nousee niiton jälkeen [L5] |
| 6 | Luottamus | Optinen: 0,5 + 0,5·min(1, (pudotus − kynnys)/0,25). Tutka: 0,25 + 0,25·min(1, (z − k)/k). | – | asteikot optinen 0,5–1, tutka 0–0,5 [L2]; kaava oma |
| 7 | Yhdistäminen | Päällekkäiset tunnistukset yhdistetään ja väli tarkennetaan leikkaukseen. Jokainen uusi sensoriperhe lisää luottamusta 0,15·(c/0,5). | – | S1+S2-yhdistäminen [L2]; lisäys oma |
| 8 | Tapahtumat | Alle 28 vrk:n päässä toisistaan olevista pidetään varmempi; enintään 4 | 28 vrk, 4 | Δt<sub>min</sub> ja enimmäismäärä [L2] |
| 9 | Todennäköisyysraja | Tapahtuma hyväksytään, kun luottamus ≥ raja. Tutka yksin (≤ 0,5) ei riitä. | 0,6 | oma; vrt. status-kohtainen raja [R5] |
| 10 | Tukiehto | Niittoväliä verrataan toimenpiteen päivämääriin, ja suurimman muuttuneen osuuden on oltava ≥ raja | 90 % | päivämäärät [R4]; osuus oma |

### Ruokaviraston kaltainen seuranta (`core.monitor`)

Ruokaviraston ja CGI:n julkisten kuvausten mukaan seuranta käyttää Sentinel-1:n takaisinsirontaa ja koherenssia (12 vrk välein) sekä Sentinel-2:n NDVI:tä (2–4 vrk välein, 10 m). Lohkon aikasarjasta etsitään NDVI:n pudotusta, joka on riittävä suhteessa trendiin. Tulos lasketaan päivittäin ja annetaan liikennevalona luotettavuustason kanssa [R5][R6]. Koneoppimismallia ei ole julkaistu, joten Niittoraportti toteuttaa rakenteen avoimilla säännöillä:

| Vaihe | Sääntö |
| --- | --- |
| Trendi | Kunkin havainnon kohdalla sovitetaan suora saman perheen edellisen 30 vrk:n havaintoihin (≥ 3). Sitä jatketaan enintään 10 vrk viimeisestä havainnosta, ja se rajataan aiempien arvojen maksimiin. Alle kolmella havainnolla verrataan edelliseen. |
| Signaali | Pudotus trendistä ≥ max(0,12; 2σ), σ ≥ 0,03. Pysyvyys, palautumisnopeus, uskottavuus ja maskiristiriidat kuten yllä. Hidas lasku (tuleentuminen) siirtää trendiä eikä laukaise ilmaisinta. |
| Tutka | VH-takaisinsironta ja koherenssi kuten vaiheet 5 ja 5b; tukevat ja tarkentavat optista tapahtumaa. Tutka yksin jää keltaiseksi. |
| Katve | Optinen väli > 14 vrk määräpäivään asti: niitto voi jäädä näkemättä, koska nurmi ehtii vihertyä. |
| Liikennevalo | **Vihreä**: hyväksytty niitto täyttää ehdon. **Punainen**: niitto ehdon vastainen, tai lohko kuvattiin koko jakson ajan ilman katvetta ja ≥ 2 selkeää kuvaa määräpäivän jälkeen eikä niittoa näkynyt. **Keltainen**: mahdollinen niitto alle rajan, katvejakso, ei optisia kuvia tai jakso kesken. |
| Luotettavuus | Vihreä: **korkea**, kun luottamus ≥ 0,8, pysyvyys varmistettu tai useampi lähde, eikä ajoitushuomautusta; **matala**, kun ajoitus epävarma tai luottamus < 0,7; muuten keskitaso. Punainen ilman niittoa: korkea, kun pisin väli ≤ 10 vrk, muuten keskitaso. Keltainen: matala. |
| Päivittäin | Luokitus lasketaan jokaisen havaintopäivän tiedoilla, ja muutokset näytetään (esim. 1.8. keltainen → 17.8. vihreä). Aikajana näyttää jaksot seurannassa, katve, niitto ja niitetty. |

Sama seuranta ajetaan rinnakkain: Sentinel-2 + Sentinel-1 (perustaso, Ruokaviraston aineisto), pelkkä Sentinel-2, pelkkä Sentinel-1, HLS + Sentinel-1, PlanetScope + Sentinel-1 ja kaikki lähteet. Taulukosta näkyy, missä lähteessä niitto näkyi aiemmin, millä luotettavuudella ja kuinka paljon katvetta jäi.

### Lähdevertailu

Lähdevertailu vastaa kysymykseen, tuovatko lisälähteet paremman näkymän niittotapahtumaan. Sama tunnistus ajetaan erikseen kullekin saatavilla olevalle lähdeyhdistelmälle: Sentinel-2 L2A, HLS ilman Landsatia (S30), HLS (Sentinel-2 + Landsat), PlanetScope, Sentinel-2 + PlanetScope, HLS + PlanetScope ja HLS + PlanetScope + Sentinel-1. Kustakin raportoidaan:

| Mittari | Merkitys |
| --- | --- |
| Kelvollisia päiviä | päivät, joilta lohkosta saatiin vähintään rajan verran pilvettömiä pikseleitä |
| Kuvaväli (mediaani, pisin) | kelvollisten päivien väli; pitkä väli peittää niittoja ja hidastaa muutoksen havaitsemista |
| Niittoväli | viimeisen niittoa edeltävän ja ensimmäisen niiton jälkeisen kelvollisen kuvan väli (vrk): niiton ajoituksen epävarmuus |
| Luottamus | parhaan hyväksytyn tapahtuman luottamus |

Perustaso on pelkkä Sentinel-2, koska se vastaa Ruokaviraston seurannan optista aineistoa (puuttuessa HLS S30). Lisälähteiden katsotaan parantaneen havaintoa, jos niitto tunnistetaan vain lisälähteillä, jos niittoväli lyhenee vähintään 2 vrk tai jos luottamus nousee yli 0,05. Yhden lohkon vertailu kuvaa vain sitä lohkoa ja kautta. Yleisen johtopäätöksen tekeminen vaatii vertailun useilla lohkoilla ja maastossa todetuilla niittopäivillä.

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
- Sade alentaa koherenssia ja voi peittää niiton [L5]. Sade ja maan kosteus muuttavat myös takaisinsirontaa, joten VH-signaali on vain tukinäyttöä.
- Ruokaviraston seurannan koneoppimismalli, sen raja-arvot ja liikennevalojen tarkat määritelmät eivät ole julkisia. Ruokaviraston kaltainen seuranta jäljittelee rakennetta, ei mallia.
- Laidunnus ja niitto erottuvat huonosti.
- Työkalu luottaa käyttäjän syöttämiin NDVI- ja osuuslukuihin. Toistettavuus perustuu siihen, että tunnisteet ja parametrit raportoidaan.
- Datahaku on testattu synteettisillä kuvilla ja mockatuilla rajapinnoilla, ei vielä oikeita palveluita vasten. Ensimmäiset oikeat haut kannattaa tarkistaa käsin, esimerkiksi vertaamalla yhden kuvan NDVI-mediaania QGIS:ssä laskettuun.
- Planetary Computerin HLS-kopio voi olla NASAn alkuperäistä jäljessä. Tuoreimmat kuvat saa tarvittaessa skriptillä NASAlta (`--hls-lahde nasa`).

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
- Ruokaviraston kaltainen seuranta: trendipudotus, tutka yksin, tuleentuminen, katve, myöhäinen niitto, määräpäivän jälkeiset kuvat, lähteiden rinnakkaisvertailu
- uskottavuusraja, palautumisnopeus, 0 % havainnot ja HLS + L2A -yhdistäminen

Datahaun testit (`npm install` kerran):

- `node test/datahaku.test.js`: projektio (verrattu pyprojiin), lohkon luku, Fmask, reunapuskuri, HLS-, Sentinel-2- (SCL ja sininen kanava), Sentinel-1- (CDSE) ja PlanetScope-ketju mockatuilla rajapinnoilla
- `python test/test_hae_havainnot.py`: skriptin laskenta samoilla kuvilla; tulosten on oltava samat kuin selaimessa
- `node test/selain.test.js`: käyttöliittymä Chromiumissa (vaatii Playwrightin)
- Testikuvat tuotetaan skriptillä `test/fixtures/make_fixtures.py`.

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
