/**
 * Core sync-merge — fusione di due userState (LWW per-PV + union foto).
 *
 * Modulo CONDIVISO tra client (browser) e server (Netlify Function state-sync):
 * la stessa identica logica deve girare su entrambi i lati, altrimenti il merge
 * client e quello server divergono e si perdono dati.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(global, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Union per id; per id presenti su entrambi i lati vince quella con
  // l'evento più recente (max tra addedAt e deletedAt → i tombstone propagano
  // la cancellazione, e una ri-aggiunta successiva ripristina la foto).
  function mergePhotoLists(a, b) {
    if (!Array.isArray(a) && !Array.isArray(b)) return null;
    const byId = new Map();
    const upsert = p => {
      if (!p || !p.id) return;
      const cur = byId.get(p.id);
      if (!cur) { byId.set(p.id, p); return; }
      const curTs = Math.max(cur.addedAt || 0, cur.deletedAt || 0);
      const newTs = Math.max(p.addedAt || 0, p.deletedAt || 0);
      if (newTs >= curTs) byId.set(p.id, p);
    };
    (a || []).forEach(upsert);
    (b || []).forEach(upsert);
    const out = Array.from(byId.values()).sort((x, y) => (x.addedAt || 0) - (y.addedAt || 0));
    return out.length ? out : null;
  }

  // Merge per-PV: vince l'entry con updatedAt più recente (last-write-wins).
  // Eccezione: il campo `photos` è merge-unito (additivo) così foto aggiunte in
  // parallelo su dispositivi diversi non si perdono nel LWW.
  function mergeStates(remote, local) {
    if (!remote) return local || {};
    if (!local) return remote;
    const out = { ...remote };
    for (const [pv, entry] of Object.entries(local)) {
      const cur = out[pv];
      if (!cur) { out[pv] = entry; continue; }
      const winner = (entry.updatedAt || 0) >= (cur.updatedAt || 0) ? entry : cur;
      const merged = { ...winner };
      const photosMerged = mergePhotoLists(cur.photos, entry.photos);
      if (photosMerged) merged.photos = photosMerged;
      else delete merged.photos;
      out[pv] = merged;
    }
    return out;
  }

  return { mergeStates, mergePhotoLists };
});
