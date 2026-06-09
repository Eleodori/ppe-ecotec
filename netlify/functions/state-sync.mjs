/**
 * Netlify Function: state-sync
 * Sincronizza lo userState dell'app tra dispositivi via Netlify Blobs.
 *
 * Il client si identifica con un "codice sync" (segreto condiviso tra i propri
 * dispositivi). Il server salva un blob per codice e fa il merge per-PV con
 * last-write-wins su updatedAt, così due dispositivi che pushano in parallelo
 * convergono senza perdere il lavoro di nessuno dei due.
 *
 * GET  ?code=XXXX           → { userState, syncedAt } | { userState: null }
 * POST { code, userState }  → { userState (merged), syncedAt }
 */

import { getStore } from '@netlify/blobs';
import { createHash } from 'crypto';

const CODE_RE = /^[A-Za-z0-9-]{6,40}$/;

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
    const code = new URL(req.url).searchParams.get('code') || '';
    if (!CODE_RE.test(code)) {
      return Response.json({ error: 'INVALID_CODE', message: 'Codice sync non valido (6-40 caratteri alfanumerici)' }, { status: 400, headers: corsHeaders });
    }
    const blob = await store.get(keyFor(code), { type: 'json' }).catch(() => null);
    return Response.json(blob || { userState: null, syncedAt: null }, { headers: corsHeaders });
  }

  if (req.method === 'POST') {
    let code, userState;
    try {
      const body = await req.json();
      code = body.code;
      userState = body.userState;
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
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    const merged = mergeStates(existing && existing.userState, userState);
    const payload = { userState: merged, syncedAt: Date.now() };
    await store.set(key, JSON.stringify(payload));
    return Response.json(payload, { headers: corsHeaders });
  }

  return Response.json({ error: 'METHOD_NOT_ALLOWED', message: 'Solo GET/POST' }, { status: 405, headers: corsHeaders });
}

// Merge per-PV: vince l'entry con updatedAt più recente (last-write-wins).
// Un'entry presente solo da un lato viene sempre mantenuta.
function mergeStates(remote, local) {
  if (!remote) return local;
  const out = { ...remote };
  for (const [pv, entry] of Object.entries(local)) {
    const cur = out[pv];
    if (!cur || (entry.updatedAt || 0) >= (cur.updatedAt || 0)) {
      out[pv] = entry;
    }
  }
  return out;
}

// Il blob key è l'hash del codice: il codice resta l'unico segreto e non
// compare mai in chiaro nello store.
function keyFor(code) {
  return createHash('sha256').update('pee-sync:' + code).digest('hex');
}
