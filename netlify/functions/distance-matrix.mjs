/**
 * Netlify Function: distance-matrix — proxy a OpenRouteService con cache DAO.
 *
 * POST { sources: [{lat,lng}], destinations: [{lat,lng}] }
 * → { distances: [[m]], durations: [[s]], cached?: true }
 *
 * ENV richieste:
 *   ORS_API_KEY  chiave OpenRouteService (free tier: 2000 req/giorno, 40/min)
 *
 * Configurazione: Netlify → Site configuration → Environment variables
 */

import { makeBlobsDao } from '../../src/server/dao/blobs.js';

const dao = makeBlobsDao();

const ORS_MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/driving-car';
const MAX_ELEMENTS = 3500; // limite ORS: sources × destinations

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const errorResp = (status, error, message) =>
  Response.json({ error, message }, { status, headers: corsHeaders });

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST')    return errorResp(405, 'METHOD_NOT_ALLOWED', 'Solo POST');

  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    return errorResp(500, 'ORS_MISSING_KEY',
      'ORS_API_KEY non configurata. Vai su: Netlify → tuo sito → Site configuration → Environment variables → aggiungi ORS_API_KEY');
  }

  let sources, destinations;
  try {
    const body = await req.json();
    sources = body.sources;
    destinations = body.destinations;
  } catch {
    return errorResp(400, 'INVALID_BODY', 'Il body non è JSON valido');
  }

  if (!Array.isArray(sources) || !Array.isArray(destinations) || !sources.length || !destinations.length) {
    return errorResp(400, 'INVALID_PARAMS', 'sources e destinations devono essere array non vuoti di {lat,lng}');
  }
  if (sources.length * destinations.length > MAX_ELEMENTS) {
    return errorResp(400, 'TOO_LARGE',
      `Troppi elementi: ${sources.length}×${destinations.length}=${sources.length * destinations.length} > ${MAX_ELEMENTS}. Riduci il batch.`);
  }

  // Cache hit
  try {
    const cached = await dao.distanceCacheGet({ sources, destinations });
    if (cached) return Response.json({ ...cached, cached: true }, { headers: corsHeaders });
  } catch (e) {
    // Cache non disponibile (es. blobs offline): procediamo comunque, non bloccante
    console.warn('cache read failed:', e.message);
  }

  // Chiamata ORS
  const allLocations = [...sources, ...destinations].map(c => [
    parseFloat(c.lng.toFixed(6)),
    parseFloat(c.lat.toFixed(6)),
  ]);
  const sourceIdxs = sources.map((_, i) => i);
  const destIdxs   = destinations.map((_, i) => i + sources.length);

  let orsResult;
  try {
    const orsResp = await fetch(ORS_MATRIX_URL, {
      method: 'POST',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ locations: allLocations, sources: sourceIdxs, destinations: destIdxs, metrics: ['distance', 'duration'] }),
    });
    if (orsResp.status === 401 || orsResp.status === 403) {
      return errorResp(500, 'ORS_MISSING_KEY', `Chiave ORS non valida o non autorizzata (HTTP ${orsResp.status})`);
    }
    if (orsResp.status === 429) {
      return errorResp(429, 'ORS_QUOTA', 'Quota ORS esaurita (limite: 2000 req/giorno, 40/minuto). Riprova più tardi.');
    }
    if (!orsResp.ok) {
      const errText = await orsResp.text().catch(() => '(nessun body)');
      return errorResp(500, 'ORS_ERROR', `ORS ha risposto ${orsResp.status}: ${errText.slice(0, 300)}`);
    }
    orsResult = await orsResp.json();
  } catch (err) {
    return errorResp(503, 'ORS_NETWORK', `Errore di rete verso OpenRouteService: ${err.message}`);
  }

  const result = { distances: orsResult.distances, durations: orsResult.durations };

  // Cache write (non bloccante)
  try { await dao.distanceCacheSet({ sources, destinations }, result); }
  catch (e) { console.warn('cache write failed:', e.message); }

  return Response.json(result, { headers: corsHeaders });
}
