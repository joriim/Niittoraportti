/*
 * Niittoraportin asetukset.
 *
 * rvProxy: Ruokaviraston INSPIRE-rajapinnan välityspalvelimen (Cloudflare Worker) osoite.
 * Ruokaviraston palvelin ei salli kutsuja selaimesta (ei CORSia eikä JSONP:tä), joten
 * peruslohkotunnushaku ja kartan klikkaus tarvitsevat välityspalvelimen. Ohjeet: worker/README.md.
 * Esimerkki: 'https://niittoraportti-rv.oma-tili.workers.dev'
 * Osoitteen voi antaa myös URL-parametrina: index.html?rvproxy=https://… (tallentuu selaimeen).
 */
window.NIITTO_CONFIG = {
  rvProxy: ''
};
