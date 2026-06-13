// @ts-check
/**
 * Core routing — clustering (DBSCAN) e ottimizzazione del giro (TSP).
 * Dipende da geo.js (haversine). Pure: nessun DOM/STATE.
 */
(function (global, factory) {
  const geo = (typeof require === 'function') ? require('./geo.js') : global;
  const api = factory(geo);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(global, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (geo) {
  'use strict';
  const haversine = geo.haversine;

  // DBSCAN su punti {lat,lng}. epsKm = raggio vicinato, minPts = densità minima.
  // Ritorna { clusters: [[pv...]], noise: [pv...] }.
  function dbscan(pvs, epsKm, minPts) {
    const n = pvs.length;
    const UNVISITED = -2, NOISE = -1;
    const labels = new Array(n).fill(UNVISITED);
    let clusterId = 0;
    const regionQuery = i => {
      const nb = [];
      for (let j = 0; j < n; j++) {
        if (j !== i && haversine(pvs[i], pvs[j]) <= epsKm) nb.push(j);
      }
      return nb;
    };
    for (let i = 0; i < n; i++) {
      if (labels[i] !== UNVISITED) continue;
      const nb = regionQuery(i);
      if (nb.length < minPts) { labels[i] = NOISE; continue; }
      labels[i] = clusterId;
      const queue = [...nb];
      while (queue.length > 0) {
        const q = queue.shift();
        if (labels[q] === NOISE) labels[q] = clusterId;
        if (labels[q] !== UNVISITED) continue;
        labels[q] = clusterId;
        const qnb = regionQuery(q);
        if (qnb.length >= minPts) queue.push(...qnb);
      }
      clusterId++;
    }
    const clusters = Array.from({ length: clusterId }, () => []);
    const noise = [];
    for (let i = 0; i < n; i++) {
      if (labels[i] >= 0) clusters[labels[i]].push(pvs[i]);
      else noise.push(pvs[i]);
    }
    return { clusters, noise };
  }

  // Matrice delle distanze (metri) in linea d'aria tra tutti i punti.
  function buildHaversineMatrix(pvs) {
    return pvs.map(a => pvs.map(b => haversine(a, b) * 1000));
  }

  // Nearest-neighbor da startIdx. Ritorna { km, order: [indici] }.
  function greedyTSP(distMeters, startIdx = 0) {
    const n = distMeters.length;
    if (n <= 1) return { km: 0, order: n === 1 ? [0] : [] };
    const order = [startIdx];
    const visited = new Set([startIdx]);
    let cur = startIdx, total = 0;
    while (visited.size < n) {
      let best = -1, bestD = Infinity;
      for (let j = 0; j < n; j++) {
        if (!visited.has(j) && distMeters[cur][j] != null && distMeters[cur][j] < bestD) {
          best = j; bestD = distMeters[cur][j];
        }
      }
      if (best === -1) break;
      visited.add(best);
      order.push(best);
      total += bestD;
      cur = best;
    }
    return { km: total / 1000, order };
  }

  // Costo (metri) di un percorso dato l'ordine e la matrice. Infinity se manca un arco.
  function routeCost(order, m) {
    let c = 0;
    for (let i = 0; i < order.length - 1; i++) {
      const d = m[order[i]][order[i + 1]];
      if (d == null) return Infinity;
      c += d;
    }
    return c;
  }

  // 2-opt: raffina l'ordine invertendo segmenti finché migliora.
  // fixedStart blocca la prima tappa (è la partenza). Ritorna { order, km }.
  function twoOptImprove(order, m, fixedStart = true) {
    let best = order.slice();
    let bestCost = routeCost(best, m);
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = fixedStart ? 1 : 0; i < best.length - 1; i++) {
        for (let j = i + 1; j < best.length; j++) {
          const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
          const c = routeCost(cand, m);
          if (c < bestCost - 1e-9) { best = cand; bestCost = c; improved = true; }
        }
      }
    }
    return { order: best, km: bestCost / 1000 };
  }

  return { dbscan, buildHaversineMatrix, greedyTSP, routeCost, twoOptImprove };
});
