'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Integration test della Function portal-token (creazione + revoca link
 * portale gestori). Replica la route reale con DAO Memory e generatore
 * deterministico per asserzioni sul token emesso.
 */

/** @param {{ tokenGen?: () => string }} [opts] */
async function makeFunction(opts) {
  const { tokenGen } = opts || {};
  const { route, json, empty, ApiError } = await import('../src/server/api/http.js');
  const { portalTokenPostBody, portalTokenDeleteQuery } = await import('../src/server/api/schemas.js');
  const { makeMemoryDao } = await import('../src/server/dao/memory.js');
  const { randomBytes } = await import('crypto');
  const dao = makeMemoryDao();
  const gen = tokenGen || (() => randomBytes(16).toString('hex'));

  const handler = route({
    POST: {
      body: portalTokenPostBody,
      handler: async ({ body }) => {
        const token = gen();
        await dao.portalTokenSet(token, {
          code: body.code,
          pvId: body.pvId,
          snapshot: body.snapshot,
          createdAt: Date.now(),
        });
        return json({ token });
      },
    },
    DELETE: {
      query: portalTokenDeleteQuery,
      handler: async ({ query }) => {
        const existing = await dao.portalTokenGet(query.token);
        if (existing && existing.code !== query.code) {
          throw new ApiError(403, 'FORBIDDEN', 'token non appartiene a questo codice');
        }
        await dao.portalTokenDelete(query.token);
        return empty(204);
      },
    },
  });
  return { handler, dao };
}

const VALID_CODE = 'CODE-AB1234';
const VALID_SNAPSHOT = {
  comune: 'Acerra', prov: 'NA', regione: 'Campania',
  indirizzo: 'Via Roma 12',
};

const req = (method, url, body) => new Request(url, {
  method,
  headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
});

test('portal-token POST: crea e indicizza nel DAO', async () => {
  const { handler, dao } = await makeFunction({ tokenGen: () => 'deadbeef0123456789abcdef01' });
  const r = await handler(req('POST', 'http://x/', {
    code: VALID_CODE, pvId: 47638, snapshot: VALID_SNAPSHOT,
  }));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.token, 'deadbeef0123456789abcdef01');
  const entry = await dao.portalTokenGet(body.token);
  assert.equal(entry.pvId, 47638);
  assert.equal(entry.code, VALID_CODE);
});

test('portal-token POST: validazione Zod (code malformato)', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('POST', 'http://x/', {
    code: 'xx', pvId: 1, snapshot: VALID_SNAPSHOT,
  }));
  assert.equal(r.status, 400);
});

test('portal-token POST: snapshot senza comune → 400', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('POST', 'http://x/', {
    code: VALID_CODE, pvId: 1, snapshot: { regione: 'Campania' },
  }));
  assert.equal(r.status, 400);
});

test('portal-token POST: pvId non intero → 400', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('POST', 'http://x/', {
    code: VALID_CODE, pvId: 'abc', snapshot: VALID_SNAPSHOT,
  }));
  assert.equal(r.status, 400);
});

test('portal-token DELETE: rimuove il token (204)', async () => {
  const { handler, dao } = await makeFunction({ tokenGen: () => 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  await handler(req('POST', 'http://x/', { code: VALID_CODE, pvId: 1, snapshot: VALID_SNAPSHOT }));
  const r = await handler(req('DELETE', `http://x/?code=${VALID_CODE}&token=aaaaaaaaaaaaaaaaaaaaaaaa`));
  assert.equal(r.status, 204);
  assert.equal(await dao.portalTokenGet('aaaaaaaaaaaaaaaaaaaaaaaa'), null);
});

test('portal-token DELETE: code diverso → 403', async () => {
  const { handler, dao } = await makeFunction({ tokenGen: () => 'bbbbbbbbbbbbbbbbbbbbbbbb' });
  await handler(req('POST', 'http://x/', { code: VALID_CODE, pvId: 1, snapshot: VALID_SNAPSHOT }));
  const r = await handler(req('DELETE', `http://x/?code=OTHER-CODE-9999&token=bbbbbbbbbbbbbbbbbbbbbbbb`));
  assert.equal(r.status, 403);
  // Il token resta valido (non l'abbiamo cancellato per sbaglio).
  assert.notEqual(await dao.portalTokenGet('bbbbbbbbbbbbbbbbbbbbbbbb'), null);
});

test('portal-token DELETE: token inesistente con code valido → 204 (idempotente)', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('DELETE', `http://x/?code=${VALID_CODE}&token=cccccccccccccccccccccccc`));
  assert.equal(r.status, 204);
});

test('portal-token DELETE: token malformato → 400', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('DELETE', `http://x/?code=${VALID_CODE}&token=short`));
  assert.equal(r.status, 400);
});
