'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Verifica che route() raccolga metriche corrette: count, distribuzione
 * statusCode, percentili durata (p50/p95).
 *
 * IMPORTANTE: getMetrics è un singleton process-wide. I test devono essere
 * tolleranti al fatto che altre suite possano averlo già toccato. Verifichiamo
 * gli incrementi rispetto al baseline.
 */

async function imports() {
  const http = await import('../src/server/api/http.js');
  const { z } = await import('zod');
  return { ...http, z };
}

const req = (method, url, body) => new Request(url, {
  method,
  headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
});

function baseline(metrics, key) {
  return metrics[key] || { count: 0, statuses: {} };
}

test('metrics: 200 ok incrementa count + status 200', async () => {
  const { route, json, getMetrics } = await imports();
  const base = baseline(getMetrics(), 'GET /m1');
  const h = route({ GET: { handler: async () => json({ ok: true }) } });
  await h(req('GET', 'http://x/m1'));
  await h(req('GET', 'http://x/m1'));
  const after = getMetrics()['GET /m1'];
  assert.equal(after.count - base.count, 2);
  assert.equal((after.statuses[200] || 0) - (base.statuses[200] || 0), 2);
});

test('metrics: 4xx/5xx contati separatamente', async () => {
  const { route, ApiError, getMetrics } = await imports();
  const base = baseline(getMetrics(), 'GET /m2');
  const h = route({
    GET: {
      handler: async () => { throw new ApiError(404, 'NOT_FOUND', 'gone'); },
    },
  });
  await h(req('GET', 'http://x/m2'));
  await h(req('GET', 'http://x/m2'));
  const after = getMetrics()['GET /m2'];
  assert.equal(after.count - base.count, 2);
  assert.equal((after.statuses[404] || 0) - (base.statuses[404] || 0), 2);
});

test('metrics: route diverse → entry diverse', async () => {
  const { route, json, getMetrics } = await imports();
  const h = route({ GET: { handler: async () => json({}) } });
  await h(req('GET', 'http://x/route-a'));
  await h(req('GET', 'http://x/route-b'));
  const m = getMetrics();
  assert.ok(m['GET /route-a']);
  assert.ok(m['GET /route-b']);
});

test('metrics: percentili durata sono numeri finiti dopo qualche richiesta', async () => {
  const { route, json, getMetrics } = await imports();
  const h = route({ GET: { handler: async () => json({ ok: true }) } });
  for (let i = 0; i < 5; i++) await h(req('GET', 'http://x/m4'));
  const m = getMetrics()['GET /m4'];
  assert.ok(Number.isFinite(m.p50ms), `p50 deve essere finito, è ${m.p50ms}`);
  assert.ok(Number.isFinite(m.p95ms), `p95 deve essere finito, è ${m.p95ms}`);
  assert.ok(m.p95ms >= m.p50ms, 'p95 ≥ p50');
});

test('metrics: 500 da errore generico incrementa status 500', async () => {
  const { route, getMetrics } = await imports();
  const base = baseline(getMetrics(), 'GET /m5');
  const h = route({
    GET: { handler: async () => { throw new Error('boom-test'); } },
  });
  await h(req('GET', 'http://x/m5'));
  const after = getMetrics()['GET /m5'];
  assert.equal(after.count - base.count, 1);
  assert.equal((after.statuses[500] || 0) - (base.statuses[500] || 0), 1);
});
