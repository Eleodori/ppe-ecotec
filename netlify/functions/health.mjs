/**
 * Netlify Function: health — endpoint di health check + metriche.
 *
 *   GET /.netlify/functions/health           → { status, version, uptime, deps }
 *   GET /.netlify/functions/health?deep=1    → include test scrittura/lettura del DAO
 *   GET /.netlify/functions/health?metrics=1 → include snapshot metriche route in-memory
 *
 * Usato da:
 * - uptime monitor esterno (StatusCake, UptimeRobot, ecc.) per verificare che il
 *   sito risponda. Il monitor pinga ogni 1-5 min: 200 = ok, qualsiasi altro = alert.
 * - load balancer / orchestrator (in futuro AWS): readiness/liveness probe.
 *
 * Volutamente NON richiede un codice sync: deve essere accessibile in modo
 * anonimo per il monitoring. Nessun dato utente viene esposto.
 *
 * NB sui metriche: ogni Function instance ha le sue metriche in-memory perché
 * il runtime serverless ne può istanziare N in parallelo. Per metriche
 * aggregate "vere" servirebbe uno store (Blobs) o un sink esterno — per ora
 * sufficienti per il debugging on-demand di una singola istanza.
 */

import { route, json, ApiError, getMetrics } from '../../src/server/api/http.js';
import { makeBlobsDao } from '../../src/server/dao/blobs.js';
import { z } from 'zod';

const dao = makeBlobsDao();

const VERSION = process.env.COMMIT_REF || 'dev'; // Netlify popola COMMIT_REF al deploy
const STARTED_AT = Date.now();

const querySchema = z.object({
  deep: z.string().optional(),    // presenza = test DAO incluso
  metrics: z.string().optional(), // presenza = include metriche route
});

export default route({
  GET: {
    query: querySchema,
    handler: async ({ query }) => {
      const out = {
        status: 'ok',
        version: VERSION,
        uptimeMs: Date.now() - STARTED_AT,
        // Lista delle dipendenze runtime "vive". I check fini sono in deps.* sotto.
        deps: { blobs: 'unknown', ors: 'unknown' },
      };

      if (query.deep) {
        // Test scrittura/lettura DAO (un blob temporaneo): conferma che Blobs
        // è raggiungibile. Non blocca per troppo tempo (max ~2s).
        try {
          const testKey = `__health-${Date.now()}`;
          await dao.distanceCacheSet({ sources: [{ lat: 0, lng: 0 }], destinations: [{ lat: 1, lng: 1 }] }, { _health: testKey });
          const got = await dao.distanceCacheGet({ sources: [{ lat: 0, lng: 0 }], destinations: [{ lat: 1, lng: 1 }] });
          out.deps.blobs = got && got._health ? 'ok' : 'degraded';
        } catch (err) {
          out.status = 'degraded';
          out.deps.blobs = 'error';
          out.deps.blobsError = err.message;
        }

        // ORS deep-check: non chiamiamo davvero (consumeremmo quota). Verifichiamo
        // solo che la env sia configurata.
        out.deps.ors = process.env.ORS_API_KEY ? 'configured' : 'missing-key';
      }

      // Snapshot metriche per-route in-memory (count + p50/p95 per status code).
      // Solo richiesta esplicita per non gonfiare la response del monitor.
      if (query.metrics) {
        out.metrics = getMetrics();
      }

      // Status code: 200 se ok/configured, 503 se degraded/error (così uptime
      // monitor alerta automaticamente).
      const httpStatus = out.status === 'ok' ? 200 : 503;
      if (httpStatus === 503) throw new ApiError(503, 'DEGRADED', 'health check failed', out);
      return json(out);
    },
  },
});
