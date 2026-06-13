/**
 * Netlify Function: state-sync — sync userState multi-dispositivo.
 *
 * Architettura: route minimale + DAO astratto (src/server/dao/*). Le politiche
 * di merge sono nel modulo CONDIVISO src/core/sync-merge.js (stessa logica
 * client e server).
 *
 *   GET  ?code=XXXX                          → { userState, syncedAt } | { userState: null }
 *   GET  ?code=XXXX&snapshots=1              → { snapshots: [{date}] }
 *   GET  ?code=XXXX&restore=YYYY-MM-DD       → { userState, syncedAt } dello snapshot
 *   POST { code, userState }                 → { userState (merged), syncedAt }
 *   POST { code, userState, replace: true }  → sovrascrive senza merge (per restore)
 */

import syncMerge from '../../src/core/sync-merge.js';
import { makeBlobsDao } from '../../src/server/dao/blobs.js';

const { mergeStates } = syncMerge;
const dao = makeBlobsDao();

const CODE_RE = /^[A-Za-z0-9-]{6,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAP_KEEP_DAYS = 30;
const MAX_STATE_BYTES = 2_000_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const errorResp = (status, error, message) =>
  Response.json({ error, message }, { status, headers: corsHeaders });

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method === 'GET')  return await handleGet(req);
    if (req.method === 'POST') return await handlePost(req);
    return errorResp(405, 'METHOD_NOT_ALLOWED', 'Solo GET/POST');
  } catch (err) {
    console.error('state-sync internal error:', err);
    return errorResp(500, 'INTERNAL', err.message || 'errore interno');
  }
}

async function handleGet(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code') || '';
  if (!CODE_RE.test(code)) return errorResp(400, 'INVALID_CODE', 'Codice sync non valido (6-40 caratteri alfanumerici)');

  if (url.searchParams.get('snapshots')) {
    const snapshots = await dao.snapshotList(code);
    return Response.json({ snapshots }, { headers: corsHeaders });
  }

  const restoreDate = url.searchParams.get('restore');
  if (restoreDate) {
    if (!DATE_RE.test(restoreDate)) return errorResp(400, 'INVALID_DATE', 'Data snapshot non valida (YYYY-MM-DD)');
    const snap = await dao.snapshotGet(code, restoreDate);
    if (!snap) return errorResp(404, 'SNAPSHOT_NOT_FOUND', 'Snapshot non trovato per quella data');
    return Response.json(snap, { headers: corsHeaders });
  }

  const doc = await dao.stateGet(code);
  return Response.json(doc || { userState: null, syncedAt: null }, { headers: corsHeaders });
}

async function handlePost(req) {
  let body;
  try { body = await req.json(); }
  catch { return errorResp(400, 'INVALID_BODY', 'Body non è JSON valido'); }
  const { code, userState, replace } = body || {};

  if (!CODE_RE.test(code || '')) return errorResp(400, 'INVALID_CODE', 'Codice sync non valido (6-40 caratteri alfanumerici)');
  if (!userState || typeof userState !== 'object' || Array.isArray(userState)) {
    return errorResp(400, 'INVALID_STATE', 'userState deve essere un oggetto');
  }
  if (JSON.stringify(userState).length > MAX_STATE_BYTES) {
    return errorResp(413, 'TOO_LARGE', 'userState troppo grande');
  }

  let merged;
  if (replace) {
    merged = userState;                            // restore: niente merge
  } else {
    const existing = await dao.stateGet(code);
    merged = mergeStates(existing && existing.userState, userState);
  }
  const payload = { userState: merged, syncedAt: Date.now() };
  await dao.stateSet(code, payload);

  // Snapshot giornaliero (sovrascrive l'esistente). Pulizia probabilistica per
  // evitare costi su ogni push: ~5% delle volte verifica e cancella vecchi.
  try {
    const today = new Date().toISOString().slice(0, 10);
    await dao.snapshotSet(code, today, payload);
    if (Math.random() < 0.05) {
      const cutoff = new Date(Date.now() - SNAP_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
      await dao.snapshotPrune(code, cutoff);
    }
  } catch (e) {
    // Snapshot non bloccante: il sync ha già completato.
    console.warn('snapshot/prune fallito:', e.message);
  }

  return Response.json(payload, { headers: corsHeaders });
}
