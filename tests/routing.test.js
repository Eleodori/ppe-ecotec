'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dbscan, buildHaversineMatrix, greedyTSP, routeCost, twoOptImprove } = require('../src/core/routing.js');

// Matrice simmetrica da distanze 1D (punti su una retta), in "metri".
const lineMatrix = vals => vals.map(a => vals.map(b => Math.abs(a - b) * 1000));

test('greedyTSP: caso banale', () => {
  assert.deepEqual(greedyTSP([[0]]).order, [0]);
  assert.deepEqual(greedyTSP([], 0), { km: 0, order: [] });
});

test('greedyTSP: parte da startIdx e visita il più vicino', () => {
  // punti a 0,10,5,20; da idx0 → 5(idx2), 10(idx1), 20(idx3)
  const m = lineMatrix([0, 10, 5, 20]);
  const { order, km } = greedyTSP(m, 0);
  assert.deepEqual(order, [0, 2, 1, 3]);
  assert.equal(km, 20);
});

test('twoOptImprove: migliora un ordine subottimo e rispetta fixedStart', () => {
  const m = lineMatrix([0, 10, 5, 20]);
  // ordine pessimo: 0→20→5→10 (costo 20+15+5=40)
  const bad = [0, 3, 2, 1];
  const { order, km } = twoOptImprove(bad, m, true);
  assert.equal(order[0], 0, 'la partenza resta bloccata');
  assert.ok(km <= 20 + 1e-9, `2-opt non peggiora: ${km}`);
});

test('greedyTSP+2opt: mai peggio del greedy su istanze casuali', () => {
  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 50; t++) {
    const pts = Array.from({ length: 7 }, () => ({ lat: 45 + rand(), lng: 9 + rand() }));
    const m = buildHaversineMatrix(pts);
    const g = greedyTSP(m, 0);
    const two = twoOptImprove(g.order, m, true);
    assert.ok(two.km <= g.km + 1e-6, `2-opt (${two.km}) > greedy (${g.km})`);
  }
});

test('routeCost: Infinity se manca un arco sul percorso', () => {
  const m = [[0, null], [5, 0]]; // arco 0→1 assente
  assert.equal(routeCost([0, 1], m), Infinity);
  assert.equal(routeCost([1, 0], m), 5); // arco 1→0 presente
});

test('dbscan: due gruppi separati + rumore', () => {
  const pts = [
    { lat: 45.00, lng: 9.00 }, { lat: 45.001, lng: 9.001 }, { lat: 45.002, lng: 9.0 }, // cluster A
    { lat: 46.00, lng: 10.0 }, { lat: 46.001, lng: 10.001 }, { lat: 46.0, lng: 10.002 }, // cluster B
    { lat: 44.0, lng: 7.0 }, // rumore isolato
  ];
  const { clusters, noise } = dbscan(pts, 1, 2); // eps 1km, minPts 2
  assert.equal(clusters.length, 2);
  assert.equal(noise.length, 1);
  assert.equal(noise[0].lng, 7.0);
});
