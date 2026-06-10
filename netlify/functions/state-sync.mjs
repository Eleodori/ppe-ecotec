/**
 * Netlify Function: state-sync
 * Sincronizza lo userState dell'app tra dispositivi via Netlify Blobs.
 *
 * Il client si identifica con un "codice sync" (segreto condiviso tra i propri
 * dispositivi). Il server salva un blob per codice e fa il merge per-PV con
 * last-write-wins su updatedAt, così due dispositivi che pushano in parallelo
 * convergono senza perdere il lavoro di nessuno dei due.
 *
 * Ad ogni POST viene anche aggiornato uno snapshot giornaliero (uno per data),
 * usato come rete di sicurezza: si può elencare e ripristinare una versione
 * precedente dello stato.
 *
 * GET  ?code=XXXX                  → { userState, syncedAt } | { userState: null }
 * GET  ?code=XXXX&snapshots=1      → { snapshots: [{date, syncedAt}] }
 * GET  ?code=XXXX&restore=DATE     → { userState, syncedAt } dello snapshot
 * POST { code, userState }         → { userState (merged), syncedAt }
 * POST { code, userState, replace: true } → sovrascrive senza merge (per il restore)
 */

import { getStore } from '@netlify/blobs';
import { createHash } from 'crypto';

const CODE_RE = /^[A-Za-z0-9-]{6,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAP_KEEP_DAYS = 30;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let store;
  try {
    store = getStore('user-sync');
  } catch {
    return Response.json({ error: 'BLOBS_UNAVAILABLE', message: 'Storage non disponibile' }, { status: 503, headers: corsHeaders });
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const code = url.searchParams.get('code') || '';
    if (!CODE_RE.test(code)) {
      return Response.json({ error: 'INVALID_CODE', message: 'Codice sync non valido (6-40 caratteri alfanumerici)' }, { status: 400, headers: corsHeaders });
    }
    const key = keyFor(code);

    if (url.searchParams.get('snapshots')) {
      const { blobs } = await store.list({ prefix: key + ':snap:' }).catch(() => ({ blobs: [] }));
      const snapshots = blobs
        .map(b => ({ date: b.key.slice((key + ':snap:').length) }))
        .filter(s => DATE_RE.test(s.date))
        .sort((a, b) => b.date.localeCompare(a.date));
      return Response.json({ snapshots }, { headers: corsHeaders });
    }

    const restoreDate = url.searchParams.get('restore');
    if (restoreDate) {
      if (!DATE_RE.test(restoreDate)) {
        return Response.json({ error: 'INVALID_DATE', message: 'Data snapshot non valida (YYYY-MM-DD)' }, { status: 400, headers: corsHeaders });
      }
      const snap = await store.get(`${key}:snap:${restoreDate}`, { type: 'json' }).catch(() => null);
      if (!snap) {
        return Response.json({ error: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot non trovato per quella data' }, { status: 404, headers: corsHeaders });
      }
      return Response.json(snap, { headers: corsHeaders });
    }

    const blob = await store.get(key, { type: 'json' }).catch(() => null);
    return Response.json(blob || { userState: null, syncedAt: null }, { headers: corsHeaders });
  }

  if (req.method === 'POST') {
    let code, userState, replace;
    try {
      const body = await req.json();
      code = body.code;
      userState = body.userState;
      replace = !!body.replace;
    } catch {
      return Response.json({ error: 'INVALID_BODY', message: 'Body non è JSON valido' }, { status: 400, headers: corsHeaders });
    }
    if (!CODE_RE.test(code || '')) {
      return Response.json({ error: 'INVALID_CODE', message: 'Codice sync non valido (6-40 caratteri alfanumerici)' }, { status: 400, headers: corsHeaders });
    }
    if (!userState || typeof userState !== 'object' || Array.isArray(userState)) {
      return Response.json({ error: 'INVALID_STATE', message: 'userState deve essere un oggetto' }, { status: 400, headers: corsHeaders });
    }
    // Limite di sicurezza: lo userState reale è ~50KB, 2MB è già anomalo
    if (JSON.stringify(userState).length > 2_000_000) {
      return Response.json({ error: 'TOO_LARGE', message: 'userState troppo grande' }, { status: 413, headers: corsHeaders });
    }

    const key = keyFor(code);
    let merged;
    if (replace) {
      merged = userState; // restore esplicito: nessun merge, lo stato arriva com'è
    } else {
      const existing = await store.get(key, { type: 'json' }).catch(() => null);
      merged = mergeStates(existing && existing.userState, userState);
    }
    const payload = { userState: merged, syncedAt: Date.now() };
    await store.set(key, JSON.stringify(payload));

    // Snapshot giornaliero (sovrascritto a ogni push dello stesso giorno →
    // contiene l'ultimo stato di quella data) + pulizia occasionale dei vecchi.
    try {
      const today = new Date().toISOString().slice(0, 10);
      await store.set(`${key}:snap:${today}`, JSON.stringify(payload));
      if (Math.random() < 0.05) await pruneSnapshots(store, key);
    } catch { /* snapshot non bloccante */ }

    return Response.json(payload, { headers: corsHeaders });
  }

  return Response.json({ error: 'METHOD_NOT_ALLOWED', message: 'Solo GET/POST' }, { status: 405, headers: corsHeaders });
}

async function pruneSnapshots(store, key) {
  const cutoff = new Date(Date.now() - SNAP_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const { blobs } = await store.list({ prefix: key + ':snap:' });
  for (const b of blobs) {
    const date = b.key.slice((key + ':snap:').length);
    if (DATE_RE.test(date) && date < cutoff) {
      await store.delete(b.key).catch(() => {});
    }
  }
}

// Merge per-PV: vince l'entry con updatedAt più recente (last-write-wins).
// Un'entry presente solo da un lato viene sempre mantenuta.
// Eccezione: il campo `photos` viene merge-unito per id (additivo), così
// foto aggiunte in parallelo su dispositivi diversi non si perdono nel LWW.
function mergeStates(remote, local) {
  if (!remote) return local;
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

// Union per id; per id presenti su entrambi i lati vince quella con
// deletedAt più recente, altrimenti l'aggiunta più recente.
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

// Il blob key è l'hash del codice: il codice resta l'unico segreto e non
// compare mai in chiaro nello store.
function keyFor(code) {
  return createHash('sha256').update('pee-sync:' + code).digest('hex');
}
