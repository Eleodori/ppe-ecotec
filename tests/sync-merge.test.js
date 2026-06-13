'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeStates, mergePhotoLists } = require('../src/core/sync-merge.js');

test('mergeStates: remote vuoto → ritorna local', () => {
  const local = { '100': { updatedAt: 5 } };
  assert.deepEqual(mergeStates(null, local), local);
});

test('mergeStates: LWW per-PV su updatedAt', () => {
  const remote = { '100': { v: 'recente', updatedAt: 10 } };
  const local = { '100': { v: 'vecchio', updatedAt: 5 }, '200': { v: 'nuovo', updatedAt: 20 } };
  const m = mergeStates(remote, local);
  assert.equal(m['100'].v, 'recente'); // vince il più recente (remote)
  assert.equal(m['200'].v, 'nuovo');   // entry solo-local mantenuta
});

test('mergeStates: entry presente da un solo lato sempre mantenuta', () => {
  const m = mergeStates({ '1': { updatedAt: 1 } }, { '2': { updatedAt: 1 } });
  assert.ok(m['1'] && m['2']);
});

test('mergePhotoLists: union di foto aggiunte in parallelo', () => {
  const r = mergePhotoLists([{ id: 'A', addedAt: 100 }], [{ id: 'B', addedAt: 200 }]);
  assert.deepEqual(r.map(x => x.id), ['A', 'B']);
});

test('mergePhotoLists: tombstone tardivo vince (cancellazione propaga)', () => {
  const r = mergePhotoLists([{ id: 'A', addedAt: 100 }], [{ id: 'A', addedAt: 100, deletedAt: 200 }]);
  assert.equal(r[0].deletedAt, 200);
});

test('mergePhotoLists: ri-aggiunta dopo cancellazione', () => {
  const r = mergePhotoLists([{ id: 'A', addedAt: 100, deletedAt: 200 }], [{ id: 'A', addedAt: 300 }]);
  assert.equal(r[0].deletedAt, undefined);
  assert.equal(r[0].addedAt, 300);
});

test('mergeStates: le foto non si perdono nel LWW (push paralleli)', () => {
  // remote ha foto A (entry più recente per updatedAt), local ha foto B su stesso PV
  const remote = { '1': { updatedAt: 20, photos: [{ id: 'A', addedAt: 20 }] } };
  const local = { '1': { updatedAt: 10, photos: [{ id: 'B', addedAt: 10 }] } };
  const m = mergeStates(remote, local);
  const ids = m['1'].photos.map(p => p.id).sort();
  assert.deepEqual(ids, ['A', 'B'], 'entrambe le foto sopravvivono al merge');
});
