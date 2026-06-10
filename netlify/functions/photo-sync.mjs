/**
 * Netlify Function: photo-sync
 * Salva/recupera blob foto per PEE Field, indirizzati per "codice sync"
 * (lo stesso usato da state-sync) + id della foto (sha-256 del contenuto).
 *
 *   GET    ?code=XXX&id=HASH        → ritorna il blob (image/jpeg)
 *   POST   { code, id, mime, b64 }  → salva il blob (idempotente: stesso id = stesso file)
 *   DELETE ?code=XXX&id=HASH        → cancella il blob
 *
 * Il foto-id è l'hash del contenuto compresso lato client, quindi caricare
 * la stessa foto da dispositivi diversi non duplica nulla.
 */

import { getStore } from '@netlify/blobs';
import { createHash } from 'crypto';

const CODE_RE = /^[A-Za-z0-9-]{6,40}$/;
const ID_RE = /^[a-f0-9]{16,128}$/i;
const MAX_SIZE = 2_000_000; // 2 MB hard cap (compresso lato client a 1280px JPEG 0.7 → ~250KB)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let store;
  try {
    store = getStore('user-photos');
  } catch {
    return Response.json({ error: 'BLOBS_UNAVAILABLE', message: 'Storage non disponibile' }, { status: 503, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const code = req.method === 'POST' ? null : url.searchParams.get('code');
  const id   = req.method === 'POST' ? null : url.searchParams.get('id');

  if (req.method === 'GET') {
    if (!CODE_RE.test(code || '') || !ID_RE.test(id || '')) {
      return Response.json({ error: 'INVALID_PARAMS' }, { status: 400, headers: corsHeaders });
    }
    const blob = await store.get(blobKey(code, id), { type: 'arrayBuffer' }).catch(() => null);
    if (!blob) return new Response('', { status: 404, headers: corsHeaders });
    return new Response(blob, {
      headers: { ...corsHeaders, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
    });
  }

  if (req.method === 'DELETE') {
    if (!CODE_RE.test(code || '') || !ID_RE.test(id || '')) {
      return Response.json({ error: 'INVALID_PARAMS' }, { status: 400, headers: corsHeaders });
    }
    await store.delete(blobKey(code, id)).catch(() => {});
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch {
      return Response.json({ error: 'INVALID_BODY' }, { status: 400, headers: corsHeaders });
    }
    const { code, id, mime, b64 } = body || {};
    if (!CODE_RE.test(code || '')) return Response.json({ error: 'INVALID_CODE' }, { status: 400, headers: corsHeaders });
    if (!ID_RE.test(id || '')) return Response.json({ error: 'INVALID_ID' }, { status: 400, headers: corsHeaders });
    if (typeof b64 !== 'string' || b64.length > MAX_SIZE * 1.4 /* +base64 overhead */) {
      return Response.json({ error: 'TOO_LARGE', message: 'Foto troppo grande (limite ~2MB compressa)' }, { status: 413, headers: corsHeaders });
    }
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0 || buf.length > MAX_SIZE) {
      return Response.json({ error: 'TOO_LARGE' }, { status: 413, headers: corsHeaders });
    }
    await store.set(blobKey(code, id), buf, {
      metadata: { mime: typeof mime === 'string' ? mime : 'image/jpeg', uploadedAt: Date.now() },
    });
    return Response.json({ ok: true, id, size: buf.length }, { headers: corsHeaders });
  }

  return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405, headers: corsHeaders });
}

function blobKey(code, id) {
  // Il codice è il segreto: lo hashiamo (come state-sync) per non averlo in chiaro.
  const hashedCode = createHash('sha256').update('pee-sync:' + code).digest('hex');
  return `${hashedCode}/${id}`;
}
