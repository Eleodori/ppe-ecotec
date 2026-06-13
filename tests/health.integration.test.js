'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Integration test del health-check con DAO Memory + override env.
 */
async function makeFunction(env = {}) {
  const { route, json, ApiError } = await import('../src/server/api/http.js');
  const { makeMemoryDao } = await import('../src/server/dao/memory.js');
  const { z } = await import('zod');
  const dao = makeMemoryDao();

  const VERSION = env.COMMIT_REF || 'dev';
  const STARTED_AT = Date.now();
  const querySchema = z.object({ deep: z.string().optional() });

  const handler = route({
    GET: {
      query: querySchema,
      handler: async ({ query }) => {
        const out = {
          status: 'ok',
          version: VERSION,
          uptimeMs: Date.now() - STARTED_AT,
          deps: { blobs: 'unknown', ors: 'unknown' },
        };
        if (query.deep) {
          try {
            await dao.distanceCacheSet({ sources: [{ lat: 0, lng: 0 }], destinations: [{ lat: 1, lng: 1 }] }, { _health: 'x' });
            const got = await dao.distanceCacheGet({ sources: [{ lat: 0, lng: 0 }], destinations: [{ lat: 1, lng: 1 }] });
            out.deps.blobs = got && got._health ? 'ok' : 'degraded';
          } catch (err) {
            out.status = 'degraded';
            out.deps.blobs = 'error';
            out.deps.blobsError = err.message;
          }
          out.deps.ors = env.ORS_API_KEY ? 'configured' : 'missing-key';
        }
        if (out.status !== 'ok') throw new ApiError(503, 'DEGRADED', 'health check failed', out);
        return json(out);
      },
    },
  });
  return handler;
}

const req = (url = 'http://x/.netlify/functions/health') => new Request(url);

test('health: GET shallow → 200 con status=ok', async () => {
  const h = await makeFunction();
  const resp = await h(req());
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.version, 'dev');
  assert.equal(body.deps.blobs, 'unknown', 'shallow non testa DAO');
});

test('health: GET ?deep=1 → testa DAO e segnala ORS configurato', async () => {
  const h = await makeFunction({ ORS_API_KEY: 'fake-key' });
  const resp = await h(req('http://x/?deep=1'));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.deps.blobs, 'ok');
  assert.equal(body.deps.ors, 'configured');
});

test('health: GET ?deep=1 senza ORS_API_KEY → missing-key (ma 200)', async () => {
  const h = await makeFunction({});
  const resp = await h(req('http://x/?deep=1'));
  assert.equal(resp.status, 200, 'missing-key non degrada il sito, solo segnala');
  assert.equal((await resp.json()).deps.ors, 'missing-key');
});

test('health: COMMIT_REF viene esposto come version', async () => {
  const h = await makeFunction({ COMMIT_REF: 'abc1234' });
  const resp = await h(req());
  const body = await resp.json();
  assert.equal(body.version, 'abc1234');
});

test('health: POST non supportato → 405', async () => {
  const h = await makeFunction();
  const resp = await h(new Request('http://x/', { method: 'POST' }));
  assert.equal(resp.status, 405);
});

test('health: payload include uptimeMs ragionevole', async () => {
  const h = await makeFunction();
  await new Promise(r => setTimeout(r, 10));
  const resp = await h(req());
  const body = await resp.json();
  assert.ok(body.uptimeMs >= 10, `uptime troppo basso: ${body.uptimeMs}`);
});
