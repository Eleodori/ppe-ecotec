// @ts-check
/**
 * DAO impl. in memoria (Map JS) — solo per i test e per netlify dev locale.
 * Stessa interfaccia di blobs.js, ma niente rete e niente persistenza tra
 * riavvii. Comodo per testare le route in isolamento totale.
 */
import { createHash } from 'crypto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const hashCode = code => createHash('sha256').update('pee-sync:' + code).digest('hex');

/** @returns {import('./interface.js').Dao} */
export function makeMemoryDao() {
  const state    = new Map();           // codeHash → StateDoc
  const snaps    = new Map();           // codeHash → Map(date → StateDoc)
  const photos   = new Map();           // `${codeHash}/${photoId}` → { data, meta }
  const orsCache = new Map();           // payloadHash → result
  const pushSubs = new Map();           // codeHash → Map(deviceId → PushSubRecord)

  const orsCacheKey = payload => {
    const fmt = c => `${parseFloat((c.lat || 0).toFixed(5))},${parseFloat((c.lng || 0).toFixed(5))}`;
    const srcStr = (payload.sources || []).map(fmt).join(';');
    const dstStr = (payload.destinations || []).map(fmt).join(';');
    return createHash('sha256').update(`src:${srcStr}|dst:${dstStr}`).digest('hex');
  };

  return {
    async stateGet(code)     { return state.get(hashCode(code)) || null; },
    async stateSet(code, doc) { state.set(hashCode(code), JSON.parse(JSON.stringify(doc))); },

    async snapshotSet(code, date, doc) {
      const h = hashCode(code);
      if (!snaps.has(h)) snaps.set(h, new Map());
      snaps.get(h).set(date, JSON.parse(JSON.stringify(doc)));
    },
    async snapshotGet(code, date) {
      const m = snaps.get(hashCode(code));
      return m ? (m.get(date) || null) : null;
    },
    async snapshotList(code) {
      const m = snaps.get(hashCode(code));
      if (!m) return [];
      return [...m.keys()].filter(d => DATE_RE.test(d)).sort((a, b) => b.localeCompare(a)).map(date => ({ date }));
    },
    async snapshotPrune(code, beforeDate) {
      const m = snaps.get(hashCode(code));
      if (!m) return 0;
      let deleted = 0;
      for (const d of [...m.keys()]) {
        if (DATE_RE.test(d) && d < beforeDate) { m.delete(d); deleted++; }
      }
      return deleted;
    },

    async photoGet(code, photoId) {
      const k = `${hashCode(code)}/${photoId}`;
      const entry = photos.get(k);
      return entry ? entry.data : null;
    },
    async photoSet(code, photoId, data, meta) {
      photos.set(`${hashCode(code)}/${photoId}`, { data, meta });
    },
    async photoDelete(code, photoId) {
      photos.delete(`${hashCode(code)}/${photoId}`);
    },

    async distanceCacheGet(payload) { return orsCache.get(orsCacheKey(payload)) || null; },
    async distanceCacheSet(payload, result) { orsCache.set(orsCacheKey(payload), result); },

    async pushSubAdd(code, deviceId, record) {
      const h = hashCode(code);
      if (!pushSubs.has(h)) pushSubs.set(h, new Map());
      pushSubs.get(h).set(deviceId, JSON.parse(JSON.stringify(record)));
    },
    async pushSubList(code) {
      const m = pushSubs.get(hashCode(code));
      return m ? [...m.values()] : [];
    },
    async pushSubRemove(code, deviceId) {
      const m = pushSubs.get(hashCode(code));
      if (m) m.delete(deviceId);
    },
  };
}
