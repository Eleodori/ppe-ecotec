// @ts-check
/**
 * DAO impl. su Netlify Blobs — produzione corrente.
 *
 * Layout chiavi dentro lo store (3 store distinti, una responsabilità ciascuno):
 *   user-sync     <codeHash>                 → JSON StateDoc
 *                 <codeHash>:snap:YYYY-MM-DD → JSON StateDoc
 *   user-photos   <codeHash>/<photoId>       → binary
 *   ors-cache     <payloadHash>              → JSON { distances, durations }
 *
 * Il codice utente è il segreto: viene hashato (SHA-256) prima di toccare
 * lo store, così non compare in chiaro. È lo stesso schema delle funzioni
 * legacy: niente migrazione dati necessaria.
 */
import { getStore } from '@netlify/blobs';
import { createHash } from 'crypto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function hashCode(code) {
  return createHash('sha256').update('pee-sync:' + code).digest('hex');
}

/** @returns {import('./interface.js').Dao} */
export function makeBlobsDao() {
  // Lazy: getStore va invocato dentro la request, non al modulo-load
  // (Netlify alloca il binding solo nel contesto della Function).
  const lazy = (name) => () => getStore(name);
  const userSync   = lazy('user-sync');
  const userPhotos = lazy('user-photos');
  const orsCache   = lazy('ors-cache');

  return {
    async stateGet(code) {
      const store = userSync();
      const blob = await store.get(hashCode(code), { type: 'json' }).catch(() => null);
      return blob || null;
    },
    async stateSet(code, doc) {
      const store = userSync();
      await store.set(hashCode(code), JSON.stringify(doc));
    },

    async snapshotSet(code, date, doc) {
      const store = userSync();
      await store.set(`${hashCode(code)}:snap:${date}`, JSON.stringify(doc));
    },
    async snapshotGet(code, date) {
      const store = userSync();
      const blob = await store.get(`${hashCode(code)}:snap:${date}`, { type: 'json' }).catch(() => null);
      return blob || null;
    },
    async snapshotList(code) {
      const store = userSync();
      const prefix = `${hashCode(code)}:snap:`;
      const { blobs } = await store.list({ prefix }).catch(() => ({ blobs: [] }));
      return blobs
        .map(b => ({ date: b.key.slice(prefix.length) }))
        .filter(s => DATE_RE.test(s.date))
        .sort((a, b) => b.date.localeCompare(a.date));
    },
    async snapshotPrune(code, beforeDate) {
      const store = userSync();
      const prefix = `${hashCode(code)}:snap:`;
      const { blobs } = await store.list({ prefix }).catch(() => ({ blobs: [] }));
      let deleted = 0;
      for (const b of blobs) {
        const date = b.key.slice(prefix.length);
        if (DATE_RE.test(date) && date < beforeDate) {
          await store.delete(b.key).catch(() => {});
          deleted++;
        }
      }
      return deleted;
    },

    async photoGet(code, photoId) {
      const store = userPhotos();
      const buf = await store.get(`${hashCode(code)}/${photoId}`, { type: 'arrayBuffer' }).catch(() => null);
      return buf || null;
    },
    async photoSet(code, photoId, data, meta) {
      const store = userPhotos();
      // Il SDK Blobs accetta Buffer/Uint8Array a runtime; il @types in TS stringe
      // troppo. Passiamo direttamente data — runtime sicuro.
      // @ts-ignore — Buffer è valido a runtime, BlobInput type è troppo restrittivo
      await store.set(`${hashCode(code)}/${photoId}`, data, { metadata: meta });
    },
    async photoDelete(code, photoId) {
      const store = userPhotos();
      await store.delete(`${hashCode(code)}/${photoId}`).catch(() => {});
    },

    async distanceCacheGet(payload) {
      const store = orsCache();
      const key = orsCacheKey(payload);
      const blob = await store.get(key, { type: 'json' }).catch(() => null);
      return blob || null;
    },
    async distanceCacheSet(payload, result) {
      const store = orsCache();
      const key = orsCacheKey(payload);
      await store.set(key, JSON.stringify(result), { metadata: { createdAt: Date.now() } });
    },

    async portalTokenSet(token, entry) {
      // Token già random opaco: non serve hashare. Store dedicato.
      const store = getStore('portal-tokens');
      await store.set(token, JSON.stringify(entry));
    },
    async portalTokenGet(token) {
      const store = getStore('portal-tokens');
      const blob = await store.get(token, { type: 'json' }).catch(() => null);
      return blob || null;
    },
    async portalTokenDelete(token) {
      const store = getStore('portal-tokens');
      await store.delete(token).catch(() => {});
    },

    async pushSubAdd(code, deviceId, record) {
      const store = userSync();
      await store.set(`${hashCode(code)}:push:${deviceId}`, JSON.stringify(record));
    },
    async pushSubList(code) {
      const store = userSync();
      const prefix = `${hashCode(code)}:push:`;
      const { blobs } = await store.list({ prefix }).catch(() => ({ blobs: [] }));
      const out = [];
      for (const b of blobs) {
        const rec = await store.get(b.key, { type: 'json' }).catch(() => null);
        if (rec) out.push(rec);
      }
      return out;
    },
    async pushSubRemove(code, deviceId) {
      const store = userSync();
      await store.delete(`${hashCode(code)}:push:${deviceId}`).catch(() => {});
    },
  };
}

/**
 * Chiave cache deterministica per i risultati ORS. Le coordinate vengono
 * arrotondate a 5 decimali (≈1m) prima dell'hash, così due chiamate quasi
 * identiche condividono la cache invece di accumularne due copie.
 */
function orsCacheKey(payload) {
  const fmt = c => `${parseFloat((c.lat || 0).toFixed(5))},${parseFloat((c.lng || 0).toFixed(5))}`;
  const srcStr = (payload.sources || []).map(fmt).join(';');
  const dstStr = (payload.destinations || []).map(fmt).join(';');
  return createHash('sha256').update(`src:${srcStr}|dst:${dstStr}`).digest('hex');
}
