'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Integration di distance-matrix: validazione body, cache hit/miss, mock ORS.
 * Sostituiamo globalThis.fetch durante il test per evitare chiamate di rete reali.
 */
async function makeFunction(orsMock) {
  const { route, json, ApiError } = await import('../src/server/api/http.js');
  const { distanceMatrixBody } = await import('../src/server/api/schemas.js');
  const { makeMemoryDao } = await import('../src/server/dao/memory.js');
  const dao = makeMemoryDao();
  const ORS_URL = 'https://api.openrouteservice.org/v2/matrix/driving-car';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => orsMock(url, opts);

  const handler = route({
    POST: {
      body: distanceMatrixBody,
      handler: async ({ body }) => {
        const { sources, destinations } = body;
        const apiKey = 'fake-key';
        const cached = await dao.distanceCacheGet({ sources, destinations });
        if (cached) return json({ ...cached, cached: true });

        const allLocations = [...sources, ...destinations].map(c => [c.lng, c.lat]);
        const orsResp = await globalThis.fetch(ORS_URL, {
          method: 'POST',
          headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ locations: allLocations, metrics: ['distance', 'duration'] }),
        });
        if (orsResp.status === 429) throw new ApiError(429, 'ORS_QUOTA', 'Quota esaurita');
        if (!orsResp.ok) throw new ApiError(500, 'ORS_ERROR', `ORS HTTP ${orsResp.status}`);
        const result = await orsResp.json();
        await dao.distanceCacheSet({ sources, destinations }, result);
        return json(result);
      },
    },
  });

  return {
    handler,
    dao,
    restore() { globalThis.fetch = originalFetch; },
  };
}

const req = (body) => new Request('http://x/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('POST valido: chiama ORS e salva in cache', async () => {
  let orsCalls = 0;
  const orsMock = async () => {
    orsCalls++;
    return new Response(JSON.stringify({ distances: [[0, 1234]], durations: [[0, 60]] }), { status: 200 });
  };
  const { handler, restore } = await makeFunction(orsMock);
  try {
    const body = { sources: [{ lat: 45, lng: 9 }], destinations: [{ lat: 46, lng: 10 }] };
    const resp = await handler(req(body));
    assert.equal(resp.status, 200);
    const r = await resp.json();
    assert.deepEqual(r.distances, [[0, 1234]]);
    assert.equal(orsCalls, 1);
  } finally { restore(); }
});

test('POST 2 volte: la seconda è cache hit', async () => {
  let orsCalls = 0;
  const orsMock = async () => {
    orsCalls++;
    return new Response(JSON.stringify({ distances: [[0, 100]], durations: [[0, 1]] }), { status: 200 });
  };
  const { handler, restore } = await makeFunction(orsMock);
  try {
    const body = { sources: [{ lat: 45, lng: 9 }], destinations: [{ lat: 46, lng: 10 }] };
    await handler(req(body));
    const resp2 = await handler(req(body));
    const r2 = await resp2.json();
    assert.equal(r2.cached, true);
    assert.equal(orsCalls, 1, 'ORS chiamato solo una volta');
  } finally { restore(); }
});

test('POST: ORS 429 → 429 ORS_QUOTA', async () => {
  const orsMock = async () => new Response('rate-limited', { status: 429 });
  const { handler, restore } = await makeFunction(orsMock);
  try {
    const body = { sources: [{ lat: 45, lng: 9 }], destinations: [{ lat: 46, lng: 10 }] };
    const resp = await handler(req(body));
    assert.equal(resp.status, 429);
    assert.equal((await resp.json()).error, 'ORS_QUOTA');
  } finally { restore(); }
});

test('POST: ORS 500 → 500 ORS_ERROR', async () => {
  const orsMock = async () => new Response('internal', { status: 500 });
  const { handler, restore } = await makeFunction(orsMock);
  try {
    const body = { sources: [{ lat: 45, lng: 9 }], destinations: [{ lat: 46, lng: 10 }] };
    const resp = await handler(req(body));
    assert.equal(resp.status, 500);
    assert.equal((await resp.json()).error, 'ORS_ERROR');
  } finally { restore(); }
});

test('POST con sources vuoto → 400 INVALID_BODY', async () => {
  const { handler, restore } = await makeFunction(async () => { throw new Error('non doveva essere chiamato'); });
  try {
    const resp = await handler(req({ sources: [], destinations: [{ lat: 1, lng: 1 }] }));
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, 'INVALID_BODY');
  } finally { restore(); }
});

test('POST con coord fuori range → 400', async () => {
  const { handler, restore } = await makeFunction(async () => { throw new Error('non doveva essere chiamato'); });
  try {
    const resp = await handler(req({ sources: [{ lat: 99, lng: 9 }], destinations: [{ lat: 46, lng: 10 }] }));
    assert.equal(resp.status, 400);
  } finally { restore(); }
});

test('POST: troppi elementi (refine sources×destinations > 3500) → 400', async () => {
  const { handler, restore } = await makeFunction(async () => { throw new Error('non doveva essere chiamato'); });
  try {
    const big = Array.from({ length: 60 }, (_, i) => ({ lat: 45 + i * 0.01, lng: 9 }));
    const resp = await handler(req({ sources: big, destinations: big })); // 60×60=3600 > 3500
    assert.equal(resp.status, 400);
  } finally { restore(); }
});

test('GET non supportato → 405', async () => {
  const { handler, restore } = await makeFunction(async () => { throw new Error('non doveva essere chiamato'); });
  try {
    const resp = await handler(new Request('http://x/', { method: 'GET' }));
    assert.equal(resp.status, 405);
  } finally { restore(); }
});
