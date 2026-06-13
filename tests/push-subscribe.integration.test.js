'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Integration test della Function push-subscribe.
 * Replica la handler reale ma con sender mockato e DAO Memory, per testare
 * route() + Zod + DAO insieme senza dipendenze esterne (no web-push).
 */

async function makeFunction({ configured = true } = {}) {
  const { route, json, empty, ApiError } = await import('../src/server/api/http.js');
  const { pushSubscribePostBody, pushSubscribeDeleteQuery } = await import('../src/server/api/schemas.js');
  const { makeMemoryDao } = await import('../src/server/dao/memory.js');
  const dao = makeMemoryDao();

  const handler = route({
    GET: {
      handler: async () => json({ configured, publicKey: configured ? 'test-pub-key' : null }),
    },
    POST: {
      body: pushSubscribePostBody,
      handler: async ({ body }) => {
        if (!configured) throw new ApiError(503, 'PUSH_NOT_CONFIGURED', 'no VAPID');
        await dao.pushSubAdd(body.code, body.deviceId, {
          deviceId: body.deviceId,
          subscription: body.subscription,
          deviceLabel: body.deviceLabel,
          createdAt: Date.now(),
        });
        return json({ ok: true });
      },
    },
    DELETE: {
      query: pushSubscribeDeleteQuery,
      handler: async ({ query }) => {
        await dao.pushSubRemove(query.code, query.deviceId);
        return empty(204);
      },
    },
  });
  return { handler, dao };
}

const VALID_CODE = 'CODE-AB1234';
const VALID_DEVICE = 'device-abc-12345';
const VALID_SUB = {
  endpoint: 'https://push.example.com/abc',
  keys: { p256dh: 'pk-' + 'a'.repeat(40), auth: 'ak-' + 'b'.repeat(20) },
};

const req = (method, url, body) => new Request(url, {
  method,
  headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
});

test('GET config: ritorna configured=true + publicKey quando VAPID set', async () => {
  const { handler } = await makeFunction({ configured: true });
  const r = await handler(req('GET', 'http://x/'));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.configured, true);
  assert.equal(typeof body.publicKey, 'string');
});

test('GET config: ritorna configured=false quando VAPID non set', async () => {
  const { handler } = await makeFunction({ configured: false });
  const body = await (await handler(req('GET', 'http://x/'))).json();
  assert.equal(body.configured, false);
  assert.equal(body.publicKey, null);
});

test('POST: registra subscription e la rende lista-bile via DAO', async () => {
  const { handler, dao } = await makeFunction();
  const r = await handler(req('POST', 'http://x/', {
    code: VALID_CODE,
    deviceId: VALID_DEVICE,
    deviceLabel: 'iPhone Michele',
    subscription: VALID_SUB,
  }));
  assert.equal(r.status, 200);
  const subs = await dao.pushSubList(VALID_CODE);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].deviceId, VALID_DEVICE);
  assert.equal(subs[0].deviceLabel, 'iPhone Michele');
  assert.equal(subs[0].subscription.endpoint, VALID_SUB.endpoint);
});

test('POST: 503 quando VAPID non configurato', async () => {
  const { handler } = await makeFunction({ configured: false });
  const r = await handler(req('POST', 'http://x/', {
    code: VALID_CODE,
    deviceId: VALID_DEVICE,
    subscription: VALID_SUB,
  }));
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.error, 'PUSH_NOT_CONFIGURED');
});

test('POST: validazione Zod — deviceId troppo corto → 400', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('POST', 'http://x/', {
    code: VALID_CODE,
    deviceId: 'short', // < 8 chars
    subscription: VALID_SUB,
  }));
  assert.equal(r.status, 400);
});

test('POST: endpoint non URL → 400', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('POST', 'http://x/', {
    code: VALID_CODE,
    deviceId: VALID_DEVICE,
    subscription: { endpoint: 'not-a-url', keys: VALID_SUB.keys },
  }));
  assert.equal(r.status, 400);
});

test('POST: chiavi push mancanti → 400', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('POST', 'http://x/', {
    code: VALID_CODE,
    deviceId: VALID_DEVICE,
    subscription: { endpoint: 'https://push.example/abc', keys: {} },
  }));
  assert.equal(r.status, 400);
});

test('DELETE: rimuove la subscription (204)', async () => {
  const { handler, dao } = await makeFunction();
  await handler(req('POST', 'http://x/', {
    code: VALID_CODE,
    deviceId: VALID_DEVICE,
    subscription: VALID_SUB,
  }));
  const r = await handler(req('DELETE', `http://x/?code=${VALID_CODE}&deviceId=${VALID_DEVICE}`));
  assert.equal(r.status, 204);
  assert.equal((await dao.pushSubList(VALID_CODE)).length, 0);
});

test('DELETE: deviceId mancante → 400 INVALID_QUERY', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('DELETE', `http://x/?code=${VALID_CODE}`));
  assert.equal(r.status, 400);
});

test('POST idempotente: stesso deviceId aggiorna invece di duplicare', async () => {
  const { handler, dao } = await makeFunction();
  await handler(req('POST', 'http://x/', {
    code: VALID_CODE, deviceId: VALID_DEVICE, deviceLabel: 'iPhone',
    subscription: VALID_SUB,
  }));
  await handler(req('POST', 'http://x/', {
    code: VALID_CODE, deviceId: VALID_DEVICE, deviceLabel: 'iPad',
    subscription: { ...VALID_SUB, endpoint: 'https://push.example.com/refreshed' },
  }));
  const subs = await dao.pushSubList(VALID_CODE);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].deviceLabel, 'iPad');
  assert.equal(subs[0].subscription.endpoint, 'https://push.example.com/refreshed');
});
