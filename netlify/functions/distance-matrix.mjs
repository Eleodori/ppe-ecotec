/**
 * Netlify Function: distance-matrix
 * Proxy per OpenRouteService Matrix API con cache su Netlify Blobs.
 *
 * POST /.netlify/functions/distance-matrix
 * Body: { sources: [{lat, lng}], destinations: [{lat, lng}] }
 * Returns: { distances: number[][], durations: number[][], cached?: true }
 * Errors: { error: string, message: string }
 *
 * ENV richiesta: ORS_API_KEY
 * Configurazione: Netlify → Site configuration → Environment variables → ORS_API_KEY
 */

import { getStore } from '@netlify/blobs';
import { createHash } from 'crypto';

const ORS_MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/driving-car';

export default async function handler(req) {
  // CORS — stessa origine, ma aggiungo gli header per sicurezza
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'METHOD_NOT_ALLOWED', message: 'Solo POST è supportato' }, { status: 405, headers: corsHeaders });
  }

  // Validazione chiave API
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    return Response.json({
      error: 'ORS_MISSING_KEY',
      message: 'ORS_API_KEY non configurata. Vai su: Netlify → tuo sito → Site configuration → Environment variables → aggiungi ORS_API_KEY',
    }, { status: 500, headers: corsHeaders });
  }

  // Parse body
  let sources, destinations;
  try {
    const body = await req.json();
    sources = body.sources;
    destinations = body.destinations;
  } catch {
    return Response.json({ error: 'INVALID_BODY', message: 'Il body non è JSON valido' }, { status: 400, headers: corsHeaders });
  }

  if (!Array.isArray(sources) || !Array.isArray(destinations) || sources.length === 0 || destinations.length === 0) {
    return Response.json({ error: 'INVALID_PARAMS', message: 'sources e destinations devono essere array non vuoti di {lat, lng}' }, { status: 400, headers: corsHeaders });
  }

  // Limite ORS: max 3500 elementi (sources × destinations)
  if (sources.length * destinations.length > 3500) {
    return Response.json({ error: 'TOO_LARGE', message: `Troppi elementi: ${sources.length}×${destinations.length}=${sources.length * destinations.length} > 3500. Riduci il batch.` }, { status: 400, headers: corsHeaders });
  }

  // Cache key deterministica: basata sulle coordinate arrotondate a 5 decimali
  const cacheKey = buildCacheKey(sources, destinations);

  // Controlla Netlify Blobs
  let store;
  try {
    store = getStore('ors-cache');
    const cached = await store.get(cacheKey, { type: 'json' });
    if (cached) {
      return Response.json({ ...cached, cached: true }, { headers: corsHeaders });
    }
  } catch {
    // Blobs non disponibile (es. netlify dev senza CLI auth) — procede senza cache
    store = null;
  }

  // Chiama ORS — coordinate in formato GeoJSON [lng, lat]
  const allLocations = [...sources, ...destinations].map(c => [
    parseFloat(c.lng.toFixed(6)),
    parseFloat(c.lat.toFixed(6)),
  ]);
  const sourceIdxs = sources.map((_, i) => i);
  const destIdxs = destinations.map((_, i) => i + sources.length);

  let orsResult;
  try {
    const orsResp = await fetch(ORS_MATRIX_URL, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        locations: allLocations,
        sources: sourceIdxs,
        destinations: destIdxs,
        metrics: ['distance', 'duration'],
      }),
    });

    if (orsResp.status === 401 || orsResp.status === 403) {
      return Response.json({
        error: 'ORS_MISSING_KEY',
        message: `Chiave ORS non valida o non autorizzata (HTTP ${orsResp.status}). Verifica ORS_API_KEY in Netlify.`,
      }, { status: 500, headers: corsHeaders });
    }

    if (orsResp.status === 429) {
      return Response.json({
        error: 'ORS_QUOTA',
        message: 'Quota ORS esaurita (limite: 2000 req/giorno, 40/minuto). Riprova più tardi.',
      }, { status: 429, headers: corsHeaders });
    }

    if (!orsResp.ok) {
      const errText = await orsResp.text().catch(() => '(nessun body)');
      return Response.json({
        error: 'ORS_ERROR',
        message: `ORS ha risposto ${orsResp.status}: ${errText.slice(0, 300)}`,
      }, { status: 500, headers: corsHeaders });
    }

    orsResult = await orsResp.json();
  } catch (err) {
    return Response.json({
      error: 'ORS_NETWORK',
      message: `Errore di rete verso OpenRouteService: ${err.message}`,
    }, { status: 503, headers: corsHeaders });
  }

  const result = {
    distances: orsResult.distances,  // meters
    durations: orsResult.durations,  // seconds
  };

  // Salva in cache
  if (store) {
    try {
      await store.set(cacheKey, result, { metadata: { createdAt: Date.now() } });
    } catch {
      // cache write fallita — non bloccante
    }
  }

  return Response.json(result, { headers: corsHeaders });
}

function buildCacheKey(sources, destinations) {
  const fmt = c => `${parseFloat(c.lat.toFixed(5))},${parseFloat(c.lng.toFixed(5))}`;
  const srcStr = sources.map(fmt).join(';');
  const dstStr = destinations.map(fmt).join(';');
  return createHash('sha256').update(`src:${srcStr}|dst:${dstStr}`).digest('hex');
}
