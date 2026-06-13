/**
 * Netlify Function: state-sync — sync userState multi-dispositivo.
 *
 *   GET  ?code=XXXX                          → state corrente
 *   GET  ?code=XXXX&snapshots=1              → elenco snapshot
 *   GET  ?code=XXXX&restore=YYYY-MM-DD       → snapshot di quella data
 *   POST { code, userState }                 → merge LWW e ritorno stato fuso
 *   POST { code, userState, replace: true }  → sovrascrive (per il restore)
 *
 * Routing/validazione/error handling in src/server/api/http.js.
 * Merge logic condivisa con il client (src/core/sync-merge.js).
 * Storage astratto via DAO (src/server/dao/blobs.js).
 */

import { getStore } from '@netlify/blobs';
import syncMerge from '../../src/core/sync-merge.js';
import { makeBlobsDao } from '../../src/server/dao/blobs.js';
import { route, json, ApiError } from '../../src/server/api/http.js';
import { dateSchema, stateSyncGetQuery, stateSyncPostBody } from '../../src/server/api/schemas.js';
import { makeRateLimiter } from '../../src/server/api/rate-limit.js';
import reporterMod from '../../src/core/reporter.js';
const { report } = reporterMod;

const { mergeStates } = syncMerge;
const dao = makeBlobsDao();

const SNAP_KEEP_DAYS = 30;
const MAX_STATE_BYTES = 2_000_000;

// Rate-limit morbido: protezione DDoS, non quota. Un utente reale fa ~10
// sync/min (push debounced 3s + visibilitychange). Capacity 60 + ricarica
// 30/min = burst tollerato + spike di sync da più dispositivi connessi.
const limiter = makeRateLimiter({
  scope: 'sync',
  capacity: 60,
  refillPerSec: 30 / 60,
  getStore: () => getStore('rate-limit'),
});

async function rateLimit(ctx) {
  const r = await limiter.check(ctx.req);
  if (!r.allowed) {
    return json(
      { error: 'RATE_LIMITED', message: `Troppe richieste. Riprova tra ~${r.retryAfterSec}s.` },
      { status: 429, headers: { 'Retry-After': String(r.retryAfterSec) } }
    );
  }
}

export default route({
  GET: {
    before: [rateLimit],
    query: stateSyncGetQuery,
    handler: async ({ query }) => {
      const { code, snapshots, restore } = query;

      if (snapshots) {
        const list = await dao.snapshotList(code);
        return json({ snapshots: list });
      }

      if (restore) {
        const parsed = dateSchema.safeParse(restore);
        if (!parsed.success) throw new ApiError(400, 'INVALID_DATE', 'Data snapshot non valida (YYYY-MM-DD)');
        const snap = await dao.snapshotGet(code, restore);
        if (!snap) throw new ApiError(404, 'SNAPSHOT_NOT_FOUND', 'Snapshot non trovato per quella data');
        return json(snap);
      }

      const doc = await dao.stateGet(code);
      return json(doc || { userState: null, syncedAt: null });
    },
  },

  POST: {
    before: [rateLimit],
    body: stateSyncPostBody,
    handler: async ({ body }) => {
      const { code, userState, replace } = body;

      if (JSON.stringify(userState).length > MAX_STATE_BYTES) {
        throw new ApiError(413, 'TOO_LARGE', 'userState troppo grande');
      }

      let merged;
      if (replace) {
        merged = userState;                              // restore esplicito
      } else {
        const existing = await dao.stateGet(code);
        merged = mergeStates(existing && existing.userState, userState);
      }
      const payload = { userState: merged, syncedAt: Date.now() };
      await dao.stateSet(code, payload);

      // Snapshot giornaliero (sovrascrive l'esistente). Pulizia probabilistica.
      try {
        const today = new Date().toISOString().slice(0, 10);
        await dao.snapshotSet(code, today, payload);
        if (Math.random() < 0.05) {
          const cutoff = new Date(Date.now() - SNAP_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
          await dao.snapshotPrune(code, cutoff);
        }
      } catch (e) {
        // Snapshot non bloccante.
        report.warn('snapshot or prune failed', { error: e.message });
      }

      return json(payload);
    },
  },
});
