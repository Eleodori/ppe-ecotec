'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Carichiamo l'impl Memory via dynamic import (è un modulo ESM).
async function dao() {
  const mod = await import('../src/server/dao/memory.js');
  return mod.makeMemoryDao();
}

test('DAO: stateGet ritorna null quando mai pushato', async () => {
  const d = await dao();
  assert.equal(await d.stateGet('CODE-A'), null);
});

test('DAO: stateSet/Get roundtrip per codice', async () => {
  const d = await dao();
  await d.stateSet('CODE-A', { userState: { '100': { updatedAt: 1 } }, syncedAt: 999 });
  const got = await d.stateGet('CODE-A');
  assert.equal(got.syncedAt, 999);
  assert.equal(got.userState['100'].updatedAt, 1);
});

test('DAO: isolamento tra codici (hash differente)', async () => {
  const d = await dao();
  await d.stateSet('A', { userState: { x: 1 }, syncedAt: 1 });
  await d.stateSet('B', { userState: { x: 2 }, syncedAt: 2 });
  assert.equal((await d.stateGet('A')).userState.x, 1);
  assert.equal((await d.stateGet('B')).userState.x, 2);
});

test('DAO: stateSet deep-clone (no aliasing tra DAO e chiamante)', async () => {
  const d = await dao();
  const doc = { userState: { '1': { v: 'a' } }, syncedAt: 1 };
  await d.stateSet('A', doc);
  doc.userState['1'].v = 'MUTATED-AFTER-WRITE';
  assert.equal((await d.stateGet('A')).userState['1'].v, 'a',
    'la scrittura non deve memorizzare un riferimento condiviso col chiamante');
});

test('DAO: snapshot list ordinato per data desc', async () => {
  const d = await dao();
  await d.snapshotSet('A', '2026-06-01', { userState: {}, syncedAt: 1 });
  await d.snapshotSet('A', '2026-06-03', { userState: {}, syncedAt: 2 });
  await d.snapshotSet('A', '2026-06-02', { userState: {}, syncedAt: 3 });
  const list = await d.snapshotList('A');
  assert.deepEqual(list.map(s => s.date), ['2026-06-03', '2026-06-02', '2026-06-01']);
});

test('DAO: snapshotPrune cancella solo quelli più vecchi della cutoff', async () => {
  const d = await dao();
  for (const date of ['2026-05-01', '2026-05-15', '2026-06-01', '2026-06-10']) {
    await d.snapshotSet('A', date, { userState: {}, syncedAt: 1 });
  }
  const deleted = await d.snapshotPrune('A', '2026-06-01');
  assert.equal(deleted, 2, 'maggio cancellato, giugno preservato');
  const remaining = (await d.snapshotList('A')).map(s => s.date);
  assert.deepEqual(remaining, ['2026-06-10', '2026-06-01']);
});

test('DAO: photoGet ritorna null se non scritto', async () => {
  const d = await dao();
  assert.equal(await d.photoGet('A', 'abc'), null);
});

test('DAO: photoSet/Get/Delete roundtrip', async () => {
  const d = await dao();
  const data = Buffer.from('xx-binary-blob');
  await d.photoSet('A', 'abc123', data, { mime: 'image/jpeg', uploadedAt: 1 });
  const got = await d.photoGet('A', 'abc123');
  assert.ok(got, 'foto deve essere recuperata');
  await d.photoDelete('A', 'abc123');
  assert.equal(await d.photoGet('A', 'abc123'), null);
});

test('DAO: distance cache è case-stabile sulle coord (5 decimali)', async () => {
  const d = await dao();
  await d.distanceCacheSet(
    { sources: [{ lat: 45.123456, lng: 9.0 }], destinations: [{ lat: 46, lng: 10 }] },
    { distances: [[1234]] }
  );
  // 45.123456 e 45.1234562 arrotondano entrambi a 45.12346 → stessa chiave
  const hit = await d.distanceCacheGet(
    { sources: [{ lat: 45.1234562, lng: 9.0 }], destinations: [{ lat: 46, lng: 10 }] }
  );
  assert.ok(hit, 'la cache deve essere stabile sulle micro-variazioni di coord');
  assert.equal(hit.distances[0][0], 1234);
});

test('DAO: distance cache miss su coord davvero diverse', async () => {
  const d = await dao();
  await d.distanceCacheSet({ sources: [{ lat: 45, lng: 9 }], destinations: [{ lat: 46, lng: 10 }] }, { ok: 1 });
  // 0.001 di delta = ~110m → chiave diversa, cache miss
  const miss = await d.distanceCacheGet({ sources: [{ lat: 45.001, lng: 9 }], destinations: [{ lat: 46, lng: 10 }] });
  assert.equal(miss, null);
});

// === pushSubAdd / pushSubList / pushSubRemove ===

const fakeSub = (suffix = '') => ({
  endpoint: 'https://push.example.com/abc' + suffix,
  keys: { p256dh: 'pk-' + suffix, auth: 'ak-' + suffix },
});

test('DAO: pushSubList vuoto se mai aggiunto', async () => {
  const d = await dao();
  assert.deepEqual(await d.pushSubList('A'), []);
});

test('DAO: pushSubAdd/List roundtrip', async () => {
  const d = await dao();
  await d.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: fakeSub('-1'), deviceLabel: 'iPhone', createdAt: 100 });
  const subs = await d.pushSubList('A');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].deviceId, 'dev-1');
  assert.equal(subs[0].subscription.endpoint, 'https://push.example.com/abc-1');
});

test('DAO: pushSubAdd su stesso deviceId aggiorna invece di duplicare', async () => {
  const d = await dao();
  await d.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: fakeSub('-old'), createdAt: 1 });
  await d.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: fakeSub('-new'), createdAt: 2 });
  const subs = await d.pushSubList('A');
  assert.equal(subs.length, 1, 'deviceId è la chiave primaria');
  assert.equal(subs[0].subscription.endpoint, 'https://push.example.com/abc-new');
});

test('DAO: pushSubList isola tra codici', async () => {
  const d = await dao();
  await d.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: fakeSub('-a'), createdAt: 1 });
  await d.pushSubAdd('B', 'dev-1', { deviceId: 'dev-1', subscription: fakeSub('-b'), createdAt: 2 });
  assert.equal((await d.pushSubList('A')).length, 1);
  assert.equal((await d.pushSubList('B')).length, 1);
  assert.equal((await d.pushSubList('A'))[0].subscription.endpoint, 'https://push.example.com/abc-a');
});

test('DAO: pushSubRemove cancella solo il device target', async () => {
  const d = await dao();
  await d.pushSubAdd('A', 'dev-1', { deviceId: 'dev-1', subscription: fakeSub('-1'), createdAt: 1 });
  await d.pushSubAdd('A', 'dev-2', { deviceId: 'dev-2', subscription: fakeSub('-2'), createdAt: 2 });
  await d.pushSubRemove('A', 'dev-1');
  const subs = await d.pushSubList('A');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].deviceId, 'dev-2');
});

test('DAO: pushSubRemove di device inesistente non throwa', async () => {
  const d = await dao();
  await d.pushSubRemove('A', 'ghost'); // non deve esplodere
  assert.deepEqual(await d.pushSubList('A'), []);
});
