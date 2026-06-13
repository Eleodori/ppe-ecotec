/**
 * Core geo — funzioni geografiche pure (nessuna dipendenza, nessun DOM/STATE).
 *
 * Caricabile in 3 modi senza build step (pattern UMD-lite):
 *  - Browser:           <script src="src/core/geo.js">  → funzioni su globalThis
 *  - Test Node (CJS):   require('./src/core/geo.js')
 *  - Netlify/ESM:       import geo from '../../src/core/geo.js'  (default = oggetto api)
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(global, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EARTH_R_KM = 6371;
  const toRad = x => x * Math.PI / 180;

  // Distanza in km tra due punti {lat,lng} (formula dell'emisenoverso).
  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.sqrt(s));
  }

  // True se il punto {lat,lng} è dentro il poligono (array di {lat,lng}).
  // Ray casting; il poligono è considerato chiuso (ultimo→primo).
  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].lng, yi = poly[i].lat;
      const xj = poly[j].lng, yj = poly[j].lat;
      if (((yi > pt.lat) !== (yj > pt.lat)) &&
          (pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  return { haversine, pointInPolygon };
});
