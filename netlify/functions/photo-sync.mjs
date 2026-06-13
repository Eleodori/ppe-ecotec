/**
 * Netlify Function: photo-sync — storage delle foto PV.
 *
 *   GET    ?code=XXX&id=HASH       → image/jpeg
 *   POST   { code, id, mime, b64 } → salva blob (idempotente)
 *   DELETE ?code=XXX&id=HASH       → cancella blob
 */

import { getStore } from '@netlify/blobs';
import { makeBlobsDao } from '../../src/server/dao/blobs.js';
import { route, json, empty, ApiError } from '../../src/server/api/http.js';
import { photoSyncGetQuery, photoSyncPostBody, photoSyncDeleteQuery } from '../../src/server/api/schemas.js';
import { makeRateLimiter } from '../../src/server/api/rate-limit.js';

const dao = makeBlobsDao();
const MAX_SIZE = 2_000_000; // 2 MB hard cap (compresso lato client ~250 KB)

// Limiti più stretti per POST (upload, consuma storage) rispetto a GET (read).
const uploadLimiter = makeRateLimiter({ scope: 'photo-w', capacity: 30, refillPerSec: 20 / 60, getStore: () => getStore('rate-limit') });
const readLimiter   = makeRateLimiter({ scope: 'photo-r', capacity: 80, refillPerSec: 60 / 60, getStore: () => getStore('rate-limit') });

const make429 = (r) => json(
  { error: 'RATE_LIMITED', message: `Troppe richieste. Riprova tra ~${r.retryAfterSec}s.` },
  { status: 429, headers: { 'Retry-After': String(r.retryAfterSec) } }
);
async function rateLimitRead(ctx)  { const r = await readLimiter.check(ctx.req);   if (!r.allowed) return make429(r); }
async function rateLimitWrite(ctx) { const r = await uploadLimiter.check(ctx.req); if (!r.allowed) return make429(r); }

export default route({
  GET: {
    before: [rateLimitRead],
    query: photoSyncGetQuery,
    handler: async ({ query }) => {
      const data = await dao.photoGet(query.code, query.id);
      if (!data) return empty(404);
      return new Response(data, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'private, max-age=86400',
        },
      });
    },
  },

  DELETE: {
    before: [rateLimitWrite],
    query: photoSyncDeleteQuery,
    handler: async ({ query }) => {
      await dao.photoDelete(query.code, query.id);
      return empty(204);
    },
  },

  POST: {
    before: [rateLimitWrite],
    body: photoSyncPostBody,
    handler: async ({ body }) => {
      const { code, id, mime, b64 } = body;
      // Check size pre-decode (base64 ~+33% overhead)
      if (b64.length > MAX_SIZE * 1.4) {
        throw new ApiError(413, 'TOO_LARGE', 'Foto troppo grande (limite ~2 MB compressa)');
      }
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 0 || buf.length > MAX_SIZE) {
        throw new ApiError(413, 'TOO_LARGE', 'Foto troppo grande o vuota');
      }
      await dao.photoSet(code, id, buf, {
        mime: typeof mime === 'string' ? mime : 'image/jpeg',
        uploadedAt: Date.now(),
      });
      return json({ ok: true, id, size: buf.length });
    },
  },
});
