# Ruokaviraston rajapinnan välityspalvelin (Cloudflare Worker)

Niittoraportin peruslohkotunnushaku ja kartan klikkaus hakevat kasvulohkon rajauksen Ruokaviraston INSPIRE-rajapinnasta (`inspire.ruokavirasto-awsa.com/geoserver`). Palvelin ei lähetä CORS-otsakkeita eikä tue JSONP:tä, joten selain ei saa lukea sen vastauksia suoraan GitHub Pagesilta. Tämä Worker välittää sovelluksen tarvitsemat kyselyt ja lisää vastauksiin CORS-otsakkeen.

Worker ei ole avoin välityspalvelin:

- se hyväksyy vain GET-kutsut polkuihin `/wfs` ja `/wms`, ja kohde on aina Ruokaviraston GeoServer
- sallitut kyselyt ovat WFS `GetFeature` ja `DescribeFeatureType` sekä WMS `GetFeatureInfo` ja `GetMap`
- `GetFeature` vaatii suodattimen (`CQL_FILTER` tai `BBOX`), ja osumia palautetaan enintään 100
- kutsu hyväksytään vain sivustoilta, jotka on lueteltu muuttujassa `ALLOWED_ORIGINS`
- vastaukset välimuistitetaan vuorokaudeksi

Cloudflaren ilmaistaso riittää: 100 000 pyyntöä vuorokaudessa.

## Käyttöönotto: selaimessa, ilman asennuksia

1. Luo maksuton tili osoitteessa https://dash.cloudflare.com/sign-up.
2. Valitse **Workers & Pages → Create → Create Worker**. Anna nimeksi `niittoraportti-rv` ja paina **Deploy**.
3. Valitse **Edit code**. Korvaa editorin sisältö tiedoston [`src/index.js`](src/index.js) sisällöllä ja paina **Deploy**.
4. Avaa Workerin **Settings → Variables and Secrets → Add** ja lisää muuttuja:
   - nimi: `ALLOWED_ORIGINS`
   - arvo: `https://joriim.github.io,http://localhost:8000,http://127.0.0.1:8000`

   Ilman muuttujaa käytetään samaa oletusta.
5. Kopioi Workerin osoite, joka on muotoa `https://niittoraportti-rv.<tilisi>.workers.dev`.

## Käyttöönotto: komentorivillä

```
cd worker
npx wrangler login
npx wrangler deploy
```

Wrangler lukee asetukset tiedostosta [`wrangler.toml`](wrangler.toml), myös muuttujan `ALLOWED_ORIGINS`, ja tulostaa lopuksi Workerin osoitteen.

## Osoite sovellukseen

Kirjoita osoite tiedostoon [`../config.js`](../config.js):

```js
window.NIITTO_CONFIG = {
  rvProxy: 'https://niittoraportti-rv.<tilisi>.workers.dev'
};
```

Commitoi ja pushaa muutos, niin GitHub Pages käyttää välityspalvelinta kaikille.

Jos haluat kokeilla ennen commitointia, avaa sovellus osoitteella `https://joriim.github.io/Niittoraportti/?rvproxy=https://niittoraportti-rv.<tilisi>.workers.dev`. Osoite tallentuu selaimeen. Tyhjä arvo (`?rvproxy=`) poistaa sen.

## Tarkistus

Avaa osoite selaimessa:

```
https://niittoraportti-rv.<tilisi>.workers.dev/
```

Vastauksen pitäisi olla: `Niittoraportti: Ruokaviraston INSPIRE-rajapinnan välityspalvelin.`

Sovelluksessa onnistunut haku näyttää valintaviestin perässä tekstin *(haettu välityspalvelimen kautta)*. Jos ilmoitus kertoo, että Origin ei ole sallittu, lisää sivuston osoite muuttujaan `ALLOWED_ORIGINS`.

## Testit

```
node worker/test.js
```

Testit ajetaan ilman verkkoa, ja Ruokaviraston vastaus korvataan niissä mockilla.
