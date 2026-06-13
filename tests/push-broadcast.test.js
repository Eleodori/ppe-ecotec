'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Test logica push broadcast: filtraggio per deviceId, payload formattato,
 * rimozione automatica delle subscription "gone" (404/410), no-op se sender
 * non configurato (skipped).
 */

async function imports() {
  const broadcast = await import('../src/server/push/broadcast.js');
  const dao = await import('../src/server/dao/memory.js');
  return { ...broadcast, makeMemoryDao: dao.makeMemoryDao };
}

const sub = (id) => ({
  endpoint: 'https://push.example/' + id,
  keys: { p256dh: 'pk' + id, auth: 'ak' + id },
});

const ev = (overrides = {}) => ({
  pv: 47638,
  type: 'state-change',
  toStatus: 'completato',
  fromStatus: 'inst-todo',
  deviceLabel: 'iPhone Michele',
  ts: 1700000000000,
  ...overrides,
});

test('broadcast: formatEventPayload genera titolo+body intelligibili', async () => {
  const { formatEventPayload } = await imports();
  const p = formatEventPayload(ev());
  assert.equal(p.title, 'PV 47638 → Completato');
  assert.match(p.body, /Era "Installazione da fare"/);
  assert.match(p.body, /da iPhone Michele/);
  assert.equal(p.data.pv, 47638);
});

test('broadcast: no-op con events vuoto', async () => {
  const { broadcastEvents, makeMemoryDao } = await imports();
  const dao = makeMemoryDao();
  const sender = { sendNotification: async () => ({ ok: true, statusCode: 201 }) };
  const stats = await broadcastEvents({ dao, sender, code: 'A', excludeDeviceId: 'x', events: [] });
  assert.deepEqual(stats, { sent: 0, failed: 0, removed: 0, skipped: 0 });
});

test('broadcast: invia a tutti tranne il device escluso', async () => {
  const { broadcastEvents, makeMemoryDao } = await imports();
  const dao = makeMemoryDao();
  await dao.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: sub('1'), createdAt: 1 });
  await dao.pushSubAdd('A', 'dev-2', { deviceId: 'dev-2', subscription: sub('2'), createdAt: 2 });
  await dao.pushSubAdd('A', 'dev-3', { deviceId: 'dev-3', subscription: sub('3'), createdAt: 3 });
  const calls = [];
  const sender = { sendNotification: async (s, payload) => { calls.push({ endpoint: s.endpoint, payload }); return { ok: true, statusCode: 201 }; } };
  const stats = await broadcastEvents({ dao, sender, code: 'A', excludeDeviceId: 'dev-1', events: [ev()] });
  assert.equal(stats.sent, 2, 'inviata a 2 device su 3');
  assert.equal(stats.failed, 0);
  const endpoints = calls.map(c => c.endpoint).sort();
  assert.deepEqual(endpoints, ['https://push.example/2', 'https://push.example/3']);
});

test('broadcast: subscription "gone" (404/410) viene rimossa dal DAO', async () => {
  const { broadcastEvents, makeMemoryDao } = await imports();
  const dao = makeMemoryDao();
  await dao.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: sub('1'), createdAt: 1 });
  await dao.pushSubAdd('A', 'dev-2', { deviceId: 'dev-2', subscription: sub('2'), createdAt: 2 });
  const sender = {
    sendNotification: async (s) => s.endpoint.endsWith('1')
      ? { ok: false, statusCode: 410, gone: true, error: 'Gone' }
      : { ok: true, statusCode: 201 },
  };
  const stats = await broadcastEvents({ dao, sender, code: 'A', excludeDeviceId: 'OTHER', events: [ev()] });
  assert.equal(stats.sent, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.removed, 1, 'sub gone va rimossa');
  const remaining = await dao.pushSubList('A');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].deviceId, 'dev-2');
});

test('broadcast: errore 5xx (non-gone) NON rimuove la sub', async () => {
  const { broadcastEvents, makeMemoryDao } = await imports();
  const dao = makeMemoryDao();
  await dao.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: sub('1'), createdAt: 1 });
  const sender = { sendNotification: async () => ({ ok: false, statusCode: 503, gone: false, error: 'service unavailable' }) };
  const stats = await broadcastEvents({ dao, sender, code: 'A', excludeDeviceId: 'OTHER', events: [ev()] });
  assert.equal(stats.failed, 1);
  assert.equal(stats.removed, 0);
  assert.equal((await dao.pushSubList('A')).length, 1, 'transient error preserva la sub');
});

test('broadcast: sender skipped (VAPID non configurato) → ritorna skipped, no errore', async () => {
  const { broadcastEvents, makeMemoryDao } = await imports();
  const dao = makeMemoryDao();
  await dao.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: sub('1'), createdAt: 1 });
  const sender = { sendNotification: async () => ({ ok: false, skipped: true }) };
  const stats = await broadcastEvents({ dao, sender, code: 'A', excludeDeviceId: 'OTHER', events: [ev()] });
  assert.equal(stats.skipped, 1);
  assert.equal(stats.sent, 0);
  assert.equal(stats.failed, 0);
});

test('broadcast: più eventi in una chiamata → moltiplica gli invii', async () => {
  const { broadcastEvents, makeMemoryDao } = await imports();
  const dao = makeMemoryDao();
  await dao.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: sub('1'), createdAt: 1 });
  const sender = { sendNotification: async () => ({ ok: true, statusCode: 201 }) };
  const stats = await broadcastEvents({
    dao, sender, code: 'A', excludeDeviceId: 'OTHER',
    events: [ev({ pv: 1 }), ev({ pv: 2 }), ev({ pv: 3 })],
  });
  assert.equal(stats.sent, 3, '3 eventi × 1 device');
});

test('broadcast: ignora i propri eventi (excludeDeviceId = unico subscriber)', async () => {
  const { broadcastEvents, makeMemoryDao } = await imports();
  const dao = makeMemoryDao();
  await dao.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: sub('1'), createdAt: 1 });
  const sender = { sendNotification: async () => ({ ok: true, statusCode: 201 }) };
  const stats = await broadcastEvents({ dao, sender, code: 'A', excludeDeviceId: 'dev-1', events: [ev()] });
  assert.equal(stats.sent, 0, 'no self-notify');
});

test('broadcast: formatEventPayload accetta fromStatus mancante', async () => {
  const { formatEventPayload } = await imports();
  const p = formatEventPayload({ pv: 1, type: 'state-change', toStatus: 'attesa', ts: 1 });
  assert.match(p.body, /Stato aggiornato/);
  assert.doesNotMatch(p.body, /Era/);
});
