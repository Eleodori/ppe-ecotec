/**
 * Netlify Function: push-subscribe — gestione subscription Web Push per-device.
 *
 *   GET                                  → { configured: bool, publicKey?: string }
 *   POST { code, deviceId, deviceLabel?, subscription }  → registra subscription
 *   DELETE ?code=XXXX&deviceId=YYY                       → revoca subscription
 *
 * Senza env VAPID_* configurate, GET ritorna `configured: false`: il client
 * nasconde il toggle. POST/DELETE rispondono 503 in quel caso.
 *
 * Vedi docs/operations.md per setup VAPID.
 */

import { getStore } from '@netlify/blobs';
import { makeBlobsDao } from '../../src/server/dao/blobs.js';
import { route, json, empty, ApiError } from '../../src/server/api/http.js';
import { pushSubscribePostBody, pushSubscribeDeleteQuery } from '../../src/server/api/schemas.js';
import { makeRateLimiter } from '../../src/server/api/rate-limit.js';
import { isConfigured, getPublicKey } from '../../src/server/push/web-push-sender.js';
import reporterMod from '../../src/core/reporter.js';
const { report } = reporterMod;

const dao = makeBlobsDao();

const limiter = makeRateLimiter({
  scope: 'push-subscribe',
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

export default route({
  GET: {
    handler: async () => {
      const configured = isConfigured();
      return json({
        configured,
        publicKey: configured ? getPublicKey() : null,
      });
    },
  },

  POST: {
    before: [rateLimit],
    body: pushSubscribePostBody,
    handler: async ({ body }) => {
      if (!isConfigured()) {
        throw new ApiError(503, 'PUSH_NOT_CONFIGURED', 'Push notifications non configurate sul server');
      }
      const { code, deviceId, deviceLabel, subscription } = body;
      await dao.pushSubAdd(code, deviceId, {
        deviceId,
        subscription,
        deviceLabel,
        createdAt: Date.now(),
      });
      report.info('push subscription registered', { code: code.slice(0, 4) + '…', deviceId: deviceId.slice(0, 6) + '…' });
      return json({ ok: true });
    },
  },

  DELETE: {
    before: [rateLimit],
    query: pushSubscribeDeleteQuery,
    handler: async ({ query }) => {
      await dao.pushSubRemove(query.code, query.deviceId);
      return empty(204);
    },
  },
});
