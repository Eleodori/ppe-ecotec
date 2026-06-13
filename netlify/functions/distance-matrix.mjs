/**
 * Netlify Function: distance-matrix — proxy a OpenRouteService con cache DAO.
 *
 * POST { sources: [{lat,lng}], destinations: [{lat,lng}] }
 * → { distances: [[m]], durations: [[s]], cached?: true }
 *
 * ENV richieste: ORS_API_KEY (free tier: 2000 req/giorno, 40/min)
 */

import { getStore } from '@netlify/blobs';
import { makeBlobsDao } from '../../src/server/dao/blobs.js';
import { route, json, ApiError } from '../../src/server/api/http.js';
import { distanceMatrixBody } from '../../src/server/api/schemas.js';
import { makeRateLimiter } from '../../src/server/api/rate-limit.js';
import reporterMod from '../../src/core/reporter.js';
const { report } = reporterMod;

const dao = makeBlobsDao();
const ORS_MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/driving-car';

// Rate-limit aggressivo: distance-matrix spende soldi/quota reali (ORS free tier:
// 2000 req/giorno, 40/min globalmente). Capacity=20 burst + ricarica 10/min per IP.
// Un client "normale" che usa l'app per pianificare anche 10 cluster di fila resta
// dentro; uno script che brute-forza viene fermato subito.
const orsLimiter = makeRateLimiter({
  scope: 'ors',
  capacity: 20,
  refillPerSec: 10 / 60,
  getStore: () => getStore('rate-limit'),
});

async function rateLimit(ctx) {
  const r = await orsLimiter.check(ctx.req);
  if (!r.allowed) {
    return json(
      { error: 'RATE_LIMITED', message: `Troppe richieste. Riprova tra ~${r.retryAfterSec}s.` },
      { status: 429, headers: { 'Retry-After': String(r.retryAfterSec) } }
    );
  }
}

export default route({
  POST: {
    before: [rateLimit],
    body: distanceMatrixBody,
    handler: async ({ body }) => {
      const { sources, destinations } = body;

      const apiKey = process.env.ORS_API_KEY;
      if (!apiKey) {
        throw new ApiError(500, 'ORS_MISSING_KEY',
          'ORS_API_KEY non configurata. Site config → Environment variables → ORS_API_KEY');
      }

      // Cache hit
      try {
        const cached = await dao.distanceCacheGet({ sources, destinations });
        if (cached) return json({ ...cached, cached: true });
      } catch (e) {
        report.warn('cache read failed', { error: e.message });
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
          throw new ApiError(500, 'ORS_MISSING_KEY', `Chiave ORS non valida o non autorizzata (HTTP ${orsResp.status})`);
        }
        if (orsResp.status === 429) {
          throw new ApiError(429, 'ORS_QUOTA', 'Quota ORS esaurita (limite: 2000/giorno, 40/minuto). Riprova più tardi.');
        }
        if (!orsResp.ok) {
          const errText = await orsResp.text().catch(() => '(nessun body)');
          throw new ApiError(500, 'ORS_ERROR', `ORS HTTP ${orsResp.status}: ${errText.slice(0, 300)}`);
        }
        orsResult = await orsResp.json();
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(503, 'ORS_NETWORK', `Errore di rete verso OpenRouteService: ${err.message}`);
      }

      const result = { distances: orsResult.distances, durations: orsResult.durations };
      try { await dao.distanceCacheSet({ sources, destinations }, result); }
      catch (e) { report.warn('cache write failed', { error: e.message }); }

      return json(result);
    },
  },
});
