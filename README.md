# Niittoraportti

**Kun satelliitti ei näe niittoa.** Yksisivuinen selainsovellus, joka sisältää:

- kuvauksen siitä, miten Ruokavirasto todentaa luonnonhoitonurmien niiton satelliittiseurannalla ja Vipu-mobiilin kuvalla
- oikeusperustan, johon vaatimus vastata Vipu-mobiilin kameralla perustuu: EU-asetukset (EU) 2021/2116 ja 2022/1173 sekä laki 1334/2022, 21 §
- ehdotuksen porrastetusta todentamisesta HLS:llä ja PlanetScopella
- **niiton tunnistuksen**, joka seuraa Ruokaviraston satelliittiseurannan rakennetta (aikasarja → muutos → pysyvyys → todennäköisyysraja). Tunnistus toteutetaan avoimella Sen4CAP-niittoalgoritmilla (De Vroey ym. 2022), ja lähteinä ovat HLS, Sentinel-2, PlanetScope ja Sentinel-1-koherenssi. Tuloksena saadaan lisätietoteksti Vipu-mobiiliin ja toistettava JSON-raportti.
- **datahaun**, joka hakee lohkolle HLS-kuvat (ilman tunnusta) ja PlanetScope-kuvat (Planet-API-avaimella) ja laskee niistä havaintotaulukon suoraan selaimessa

Kaikki laskenta tapahtuu selaimessa. Vain datahaussa lohkon rajaus lähetetään hakupalveluun (Microsoft Planetary Computer tai Planet). Muuta tietoa ei lähetetä minnekään.

| Tiedosto | Sisältö |
| --- | --- |
| `index.html` | sovellus |
| `core.js` | tunnistuslogiikka ilman DOM-riippuvuuksia |
| `datahaku.js` | HLS- ja PlanetScope-haku sekä pikselilaskenta selaimessa |
| `vendor/geotiff.js` | [geotiff.js](https://github.com/geotiffjs/geotiff.js) 2.1.3 GeoTIFF-kuvien lukuun (MIT, `vendor/geotiff.LICENSE`) |
| `scripts/hae_havainnot.py` | sama haku komentoriviltä; tukee myös NASA Earthdataa, tuottaa CSV:n |
| `scripts/hae_kasvulohkot.py` | niittovelvoitteiset lohkot Ruokaviraston avoimesta kasvulohkoaineistosta |
| `METHOD.md` | menetelmä, raja-arvot ja niiden lähteet, rajoitukset |
| `test/` | testit: `npm install && npm test`, `python test/test_hae_havainnot.py`, `node test/selain.test.js` |

## Käyttö

Avaa `index.html` selaimessa tai julkaise repo GitHub Pagesilla (Settings → Pages → Deploy from branch → `main` / root). Datahaku vaatii, että sivu avataan verkko-osoitteesta (GitHub Pages tai paikallinen palvelin, esim. `python -m http.server`). Suoraan tiedostona (`file://`) avattuna selain voi estää haut.

## Datahaku ja tunnukset

Niittoraportti-välilehdellä on osio *Hae havainnot satelliittikuvista*. Liitä siihen lohkon rajaus GeoJSONina (WGS84 tai ETRS-TM35FIN, esim. `hae_kasvulohkot.py`:n tuottamasta tiedostosta yksi lohko), valitse aikaväli ja hae.

### HLS: ei tunnusta

Sovellus hakee NASAn HLS v2.0 -aineiston (S30 ja L30) Microsoftin Planetary Computerista. Lukuoikeus (SAS-token) haetaan automaattisesti.

### HLS suoraan NASAlta: Earthdata-token (vain skripti)

NASAn latauspalvelu ohjaa kirjautumiseen toiseen osoitteeseen, joten sitä ei voi käyttää selaimesta.

1. Luo maksuton tunnus: https://urs.earthdata.nasa.gov/users/new
2. Kirjaudu ja valitse *Generate Token*. Kopioi token. Voimassaoloaika näkyy samalla sivulla.
3. Aja skripti:
   ```
   pip install requests rasterio numpy pyproj shapely
   export EARTHDATA_TOKEN="token-tähän"
   python scripts/hae_havainnot.py --lohko lohko.geojson --alku 2026-05-01 --loppu 2026-09-30 --hls-lahde nasa
   ```
4. Liitä tuloksena syntyvän `havainnot.csv`:n sisältö sovelluksen *Liitä CSV* -kenttään.

### PlanetScope: Planet-API-avain

1. **Käyttöoikeus.** Tarvitset Planet-tilin, jolla on PlanetScope-latausoikeus: organisaation maksullisen tilauksen tai tutkijana Planetin [Education and Research](https://www.planet.com/markets/education-and-research/) -ohjelman. Planetin 30 päivän kokeilutilillä ei voi tilata PlanetScope-kuvia omalle alueelle.
2. **Avain.** Kirjaudu osoitteessa https://www.planet.com/account/ → *My Settings*. API-avain näkyy siellä. Voimassa voi olla yksi avain kerrallaan.
3. **Syöttäminen sovellukseen.** Liitä avain kenttään *Planet-API-avain*. Avain on vain sivun muistissa. Valinnalla *Muista tämän välilehden ajan* se tallentuu istuntomuistiin (sessionStorage) ja poistuu, kun välilehti suljetaan. Avainta ei tallenneta raporttiin, ja se lähetetään vain osoitteeseen api.planet.com.
4. **Hae kuvalista → Tilaa kuvat.** Sovellus valitsee kultakin päivältä selkeimmän kuvan ja näyttää arvion tilattavasta alasta (kuvia × lohkon ala). Tilaus rajataan lohkoon, harmonisoidaan Sentinel-2:een ja kuluttaa tilisi kiintiötä. Tilauksen tila tarkistetaan 30 sekunnin välein. Tunnuksella voi jatkaa myöhemmin painikkeella *Tarkista ja käsittele*.
5. **Skriptillä**, jos selain estää Planetin kutsut (virheilmoitus mainitsee CORSin):
   ```
   export PL_API_KEY="avain-tähän"
   python scripts/hae_havainnot.py --lohko lohko.geojson --alku 2026-05-01 --loppu 2026-09-30 --planet
   ```

API-avain on yhtä arka kuin salasana. Älä tallenna sitä jaetulle koneelle. Jos avain vuotaa, vaihda se Planetin tilisivulla.

### Testaus

Datahaku on testattu synteettisillä kuvilla ja mockatuilla rajapinnoilla, ei vielä oikeita palveluita vasten. Ensimmäiset oikeat haut kannattaa tarkistaa käsin.

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
