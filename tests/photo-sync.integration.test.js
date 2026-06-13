'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Integration test della Function photo-sync con DAO Memory iniettato.
 * Verifica validazione, error path (404 / 413 / 405), happy path POST→GET→DELETE.
 */
async function makeFunction() {
  const { route, json, empty, ApiError } = await import('../src/server/api/http.js');
  const { photoSyncGetQuery, photoSyncPostBody, photoSyncDeleteQuery } = await import('../src/server/api/schemas.js');
  const { makeMemoryDao } = await import('../src/server/dao/memory.js');
  const dao = makeMemoryDao();
  const MAX_SIZE = 2_000_000;

  const handler = route({
    GET: {
      query: photoSyncGetQuery,
      handler: async ({ query }) => {
        const data = await dao.photoGet(query.code, query.id);
        if (!data) return empty(404);
        return new Response(data, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      },
    },
    DELETE: {
      query: photoSyncDeleteQuery,
      handler: async ({ query }) => {
        await dao.photoDelete(query.code, query.id);
        return empty(204);
      },
    },
    POST: {
      body: photoSyncPostBody,
      handler: async ({ body }) => {
        const { code, id, mime, b64 } = body;
        if (b64.length > MAX_SIZE * 1.4) throw new ApiError(413, 'TOO_LARGE', 'Foto troppo grande');
        const buf = Buffer.from(b64, 'base64');
        if (buf.length === 0 || buf.length > MAX_SIZE) throw new ApiError(413, 'TOO_LARGE', 'Foto troppo grande o vuota');
        await dao.photoSet(code, id, buf, { mime: mime || 'image/jpeg', uploadedAt: Date.now() });
        return json({ ok: true, id, size: buf.length });
      },
    },
  });
  return { handler, dao };
}

const VALID_CODE = 'CODE-AB1234';
const VALID_ID = 'a'.repeat(64); // 64 hex chars = sha-256

const req = (method, url, body) => new Request(url, {
  method,
  headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
});

test('GET di foto inesistente → 404', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('GET', `http://x/?code=${VALID_CODE}&id=${VALID_ID}`));
  assert.equal(resp.status, 404);
});

test('POST + GET roundtrip', async () => {
  const { handler } = await makeFunction();
  const b64 = Buffer.from('fake-jpeg-content').toString('base64');
  const post = await handler(req('POST', 'http://x/', { code: VALID_CODE, id: VALID_ID, b64 }));
  assert.equal(post.status, 200);
  const get = await handler(req('GET', `http://x/?code=${VALID_CODE}&id=${VALID_ID}`));
  assert.equal(get.status, 200);
  const bytes = Buffer.from(await get.arrayBuffer());
  assert.equal(bytes.toString(), 'fake-jpeg-content');
});

test('DELETE rimuove il blob (GET successivo 404)', async () => {
  const { handler } = await makeFunction();
  const b64 = Buffer.from('to-be-deleted').toString('base64');
  await handler(req('POST', 'http://x/', { code: VALID_CODE, id: VALID_ID, b64 }));
  const del = await handler(req('DELETE', `http://x/?code=${VALID_CODE}&id=${VALID_ID}`));
  assert.equal(del.status, 204);
  const get = await handler(req('GET', `http://x/?code=${VALID_CODE}&id=${VALID_ID}`));
  assert.equal(get.status, 404);
});

test('POST con id non hex → 400 INVALID_BODY', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('POST', 'http://x/', { code: VALID_CODE, id: 'not-hex!', b64: 'abc' }));
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.equal(body.error, 'INVALID_BODY');
  assert.ok(body.detail.id);
});

test('POST con code troppo corto → 400', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('POST', 'http://x/', { code: 'short', id: VALID_ID, b64: 'abc' }));
  assert.equal(resp.status, 400);
});

test('POST con b64 vuota → 400 (Zod) o 413 (size 0)', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('POST', 'http://x/', { code: VALID_CODE, id: VALID_ID, b64: '' }));
  // Zod rifiuta b64 vuota → 400
  assert.equal(resp.status, 400);
});

test('GET con id non hex → 400 INVALID_QUERY', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('GET', `http://x/?code=${VALID_CODE}&id=zzz`));
  assert.equal(resp.status, 400);
});

test('PUT non supportato → 405 con elenco metodi', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('PUT', 'http://x/'));
  assert.equal(resp.status, 405);
  const body = await resp.json();
  assert.deepEqual(body.detail.allowed.sort(), ['DELETE', 'GET', 'POST']);
});
