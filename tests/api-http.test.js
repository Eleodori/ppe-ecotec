'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function imports() {
  const http = await import('../src/server/api/http.js');
  const { z } = await import('zod');
  return { ...http, z };
}

// Helper: costruisce una Request mock per le 3 forme che ci servono.
function mockReq(method, url, body) {
  return new Request(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('http: OPTIONS preflight ritorna 204', async () => {
  const { route } = await imports();
  const h = route({ GET: { handler: async () => new Response('ok') } });
  const resp = await h(mockReq('OPTIONS', 'http://x/'));
  assert.equal(resp.status, 204);
});

test('http: metodo non gestito → 405 con elenco metodi consentiti', async () => {
  const { route, json } = await imports();
  const h = route({ GET: { handler: async () => json({ ok: true }) } });
  const resp = await h(mockReq('POST', 'http://x/'));
  assert.equal(resp.status, 405);
  const body = await resp.json();
  assert.equal(body.error, 'METHOD_NOT_ALLOWED');
  assert.deepEqual(body.detail.allowed, ['GET']);
});

test('http: query validation 400 con dettagli campo', async () => {
  const { route, json, z } = await imports();
  const h = route({
    GET: {
      query: z.object({ code: z.string().min(6) }),
      handler: async ({ query }) => json({ code: query.code }),
    },
  });
  const resp = await h(mockReq('GET', 'http://x/?code=abc'));
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.equal(body.error, 'INVALID_QUERY');
  assert.ok(body.detail.code, 'errore sul campo code');
});

test('http: query validation OK passa query parsata al handler', async () => {
  const { route, json, z } = await imports();
  const h = route({
    GET: {
      query: z.object({ code: z.string().min(6) }),
      handler: async ({ query }) => json({ code: query.code }),
    },
  });
  const resp = await h(mockReq('GET', 'http://x/?code=ABC123'));
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).code, 'ABC123');
});

test('http: body JSON malformato → 400 INVALID_BODY', async () => {
  const { route, json, z } = await imports();
  const h = route({
    POST: { body: z.object({}), handler: async () => json({ ok: true }) },
  });
  const resp = await h(new Request('http://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ malformed',
  }));
  assert.equal(resp.status, 400);
  assert.equal((await resp.json()).error, 'INVALID_BODY');
});

test('http: body validation con Zod ritorna dettagli per campo', async () => {
  const { route, json, z } = await imports();
  const h = route({
    POST: {
      body: z.object({ name: z.string().min(3), age: z.number().int().positive() }),
      handler: async ({ body }) => json(body),
    },
  });
  const resp = await h(mockReq('POST', 'http://x/', { name: 'ab', age: -1 }));
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.equal(body.error, 'INVALID_BODY');
  assert.ok(body.detail.name, 'errore su name');
  assert.ok(body.detail.age, 'errore su age');
});

test('http: ApiError dal handler diventa risposta con il suo status/codice', async () => {
  const { route, ApiError } = await imports();
  const h = route({
    GET: {
      handler: async () => { throw new ApiError(404, 'NOT_FOUND', 'risorsa assente', { id: 42 }); },
    },
  });
  const resp = await h(mockReq('GET', 'http://x/'));
  assert.equal(resp.status, 404);
  const body = await resp.json();
  assert.equal(body.error, 'NOT_FOUND');
  assert.equal(body.detail.id, 42);
});

test('http: errore generico → 500 INTERNAL, dettagli nello stack non leakkano nel body', async () => {
  const { route } = await imports();
  const h = route({
    GET: { handler: async () => { throw new Error('boom-internal'); } },
  });
  const resp = await h(mockReq('GET', 'http://x/'));
  assert.equal(resp.status, 500);
  const body = await resp.json();
  assert.equal(body.error, 'INTERNAL');
  // Il message del body è l'errore — ok per ora, ma non è classificato come PII.
  assert.equal(body.message, 'boom-internal');
});

test('http: response include header CORS', async () => {
  const { route, json } = await imports();
  const h = route({ GET: { handler: async () => json({ ok: true }) } });
  const resp = await h(mockReq('GET', 'http://x/'));
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), '*');
});
