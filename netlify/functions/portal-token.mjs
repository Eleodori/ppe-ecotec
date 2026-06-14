/**
 * Netlify Function: portal-token — gestione token del portale gestori PV.
 *
 *   POST   { code, pvId, snapshot }    → genera un token e lo indicizza nel DAO
 *   DELETE ?code=XXX&token=YYY         → revoca il token
 *
 * Il `code` è il syncCode: chi non lo possiede non può generare link per quei
 * PV. Authz "soft" prima della Fase 4 (auth reale multi-tenant).
 *
 * Vedi pv-public.mjs per la lettura anonima del link.
 */

import { getStore } from '@netlify/blobs';
import { randomBytes } from 'crypto';
import { makeBlobsDao } from '../../src/server/dao/blobs.js';
import { route, json, empty, ApiError } from '../../src/server/api/http.js';
import { portalTokenPostBody, portalTokenDeleteQuery } from '../../src/server/api/schemas.js';
import { makeRateLimiter } from '../../src/server/api/rate-limit.js';
import reporterMod from '../../src/core/reporter.js';
const { report } = reporterMod;

const dao = makeBlobsDao();

const limiter = makeRateLimiter({
  scope: 'portal-token',
  capacity: 20,
  refillPerSec: 10 / 60,
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

function generateToken() {
  // 16 byte random = 32 hex char = 128 bit entropy (bruteforce-resistente)
  return randomBytes(16).toString('hex');
}

export default route({
  POST: {
    before: [rateLimit],
    body: portalTokenPostBody,
    handler: async ({ body }) => {
      const { code, pvId, snapshot } = body;
      const token = generateToken();
      await dao.portalTokenSet(token, {
        code,
        pvId,
        snapshot,
        createdAt: Date.now(),
      });
      report.info('portal token created', { pvId, codeShort: code.slice(0, 4) + '…' });
      return json({ token });
    },
  },

  DELETE: {
    before: [rateLimit],
    query: portalTokenDeleteQuery,
    handler: async ({ query }) => {
      // Verifica che il chiamante possieda il code del token (semplice authz
      // pre-Fase 4): se il token esiste ma è di un altro code, 403.
      const existing = await dao.portalTokenGet(query.token);
      if (existing && existing.code !== query.code) {
        throw new ApiError(403, 'FORBIDDEN', 'token non appartiene a questo codice');
      }
      await dao.portalTokenDelete(query.token);
      return empty(204);
    },
  },
});
