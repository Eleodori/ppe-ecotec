'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function imports() {
  const mod = await import('../src/server/api/rate-limit.js');
  return mod;
}

// Store fake che imita l'interfaccia Blobs (get/set JSON via type:'json')
function fakeStore() {
  const data = new Map();
  return {
    async get(key, _opts) { return data.get(key) || null; },
    async set(key, value) {
      // Il modulo passa JSON.stringify(...) → ricostituiamo prima di salvare,
      // così get(type:'json') può ritornare l'oggetto come fa Blobs.
      data.set(key, typeof value === 'string' ? JSON.parse(value) : value);
    },
    _data: data,
  };
}

function makeReq(ip) {
  return new Request('http://x/', {
    headers: { 'x-nf-client-connection-ip': ip },
  });
}

test('rate-limit: consuma capacity poi blocca con 429', async () => {
  const { makeRateLimiter } = await imports();
  const store = fakeStore();
  const rl = makeRateLimiter({ scope: 't', capacity: 3, refillPerSec: 0.001, getStore: () => store });

  const req = makeReq('1.2.3.4');
  for (let i = 0; i < 3; i++) {
    const r = await rl.check(req);
    assert.equal(r.allowed, true, `richiesta ${i + 1} dovrebbe essere consentita`);
  }
  const r4 = await rl.check(req);
  assert.equal(r4.allowed, false, '4ª richiesta bloccata');
  assert.ok(r4.retryAfterSec > 0);
});

test('rate-limit: IP diversi → bucket separati', async () => {
  const { makeRateLimiter } = await imports();
  const store = fakeStore();
  const rl = makeRateLimiter({ scope: 't', capacity: 2, refillPerSec: 0.001, getStore: () => store });

  // IP A esaurisce il bucket
  await rl.check(makeReq('A'));
  await rl.check(makeReq('A'));
  assert.equal((await rl.check(makeReq('A'))).allowed, false);

  // IP B parte da capacity piena
  assert.equal((await rl.check(makeReq('B'))).allowed, true);
  assert.equal((await rl.check(makeReq('B'))).allowed, true);
});

test('rate-limit: scope diversi → bucket separati anche per stesso IP', async () => {
  const { makeRateLimiter } = await imports();
  const store = fakeStore();
  const a = makeRateLimiter({ scope: 'a', capacity: 1, refillPerSec: 0.001, getStore: () => store });
  const b = makeRateLimiter({ scope: 'b', capacity: 1, refillPerSec: 0.001, getStore: () => store });

  const req = makeReq('X');
  assert.equal((await a.check(req)).allowed, true);
  assert.equal((await a.check(req)).allowed, false, 'scope a esaurito');
  assert.equal((await b.check(req)).allowed, true, 'scope b indipendente');
});

test('rate-limit: store non disponibile → fail-open (non bloccare in dev)', async () => {
  const { makeRateLimiter } = await imports();
  const rl = makeRateLimiter({
    scope: 't', capacity: 1, refillPerSec: 0.001,
    getStore: () => { throw new Error('blobs not available'); },
  });
  const r = await rl.check(makeReq('Z'));
  assert.equal(r.allowed, true, 'in mancanza di storage, non blocchiamo');
});

test('clientIp: rispetta x-nf-client-connection-ip', async () => {
  const { clientIp } = await imports();
  const req = new Request('http://x/', { headers: { 'x-nf-client-connection-ip': '9.9.9.9' } });
  assert.equal(clientIp(req), '9.9.9.9');
});

test('clientIp: fallback su x-forwarded-for (primo IP)', async () => {
  const { clientIp } = await imports();
  const req = new Request('http://x/', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } });
  assert.equal(clientIp(req), '1.1.1.1');
});

test('clientIp: senza header → "unknown"', async () => {
  const { clientIp } = await imports();
  assert.equal(clientIp(new Request('http://x/')), 'unknown');
});

test('rate-limit: ricarica progressiva dopo attesa simulata', async () => {
  const { makeRateLimiter } = await imports();
  const store = fakeStore();
  // Ricarica veloce: 100 token/sec
  const rl = makeRateLimiter({ scope: 't', capacity: 1, refillPerSec: 100, getStore: () => store });

  const req = makeReq('R');
  assert.equal((await rl.check(req)).allowed, true);
  assert.equal((await rl.check(req)).allowed, false);
  await new Promise(r => setTimeout(r, 50));
  // Dopo 50ms a 100 tok/s → 5 token ricaricati (cap a 1 = pieno) → passa
  assert.equal((await rl.check(req)).allowed, true);
});
