/**
 * Netlify Function: photo-sync — storage delle foto PV.
 *
 * Architettura: route + DAO astratto. Il foto-id è l'hash del contenuto
 * compresso lato client, quindi due dispositivi che caricano la stessa foto
 * scrivono lo stesso blob (deduplica gratis).
 *
 *   GET    ?code=XXX&id=HASH        → image/jpeg
 *   POST   { code, id, mime, b64 }  → salva blob (idempotente)
 *   DELETE ?code=XXX&id=HASH        → cancella blob
 */

import { makeBlobsDao } from '../../src/server/dao/blobs.js';

const dao = makeBlobsDao();

const CODE_RE = /^[A-Za-z0-9-]{6,40}$/;
const ID_RE = /^[a-f0-9]{16,128}$/i;
const MAX_SIZE = 2_000_000; // 2 MB hard cap (compresso lato client ~250 KB)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const errorResp = (status, error, message) =>
  Response.json({ error, message }, { status, headers: corsHeaders });

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const url = new URL(req.url);
    if (req.method === 'GET')    return await handleGet(url);
    if (req.method === 'DELETE') return await handleDelete(url);
    if (req.method === 'POST')   return await handlePost(req);
    return errorResp(405, 'METHOD_NOT_ALLOWED', 'Solo GET/POST/DELETE');
  } catch (err) {
    console.error('photo-sync internal error:', err);
    return errorResp(500, 'INTERNAL', err.message || 'errore interno');
  }
}

async function handleGet(url) {
  const code = url.searchParams.get('code') || '';
  const id   = url.searchParams.get('id')   || '';
  if (!CODE_RE.test(code) || !ID_RE.test(id)) return errorResp(400, 'INVALID_PARAMS', 'code o id non valido');
  const data = await dao.photoGet(code, id);
  if (!data) return new Response('', { status: 404, headers: corsHeaders });
  return new Response(data, {
    headers: { ...corsHeaders, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
  });
}

async function handleDelete(url) {
  const code = url.searchParams.get('code') || '';
  const id   = url.searchParams.get('id')   || '';
  if (!CODE_RE.test(code) || !ID_RE.test(id)) return errorResp(400, 'INVALID_PARAMS', 'code o id non valido');
  await dao.photoDelete(code, id);
  return new Response(null, { status: 204, headers: corsHeaders });
}

async function handlePost(req) {
  let body;
  try { body = await req.json(); }
  catch { return errorResp(400, 'INVALID_BODY', 'Body non è JSON valido'); }
  const { code, id, mime, b64 } = body || {};

  if (!CODE_RE.test(code || '')) return errorResp(400, 'INVALID_CODE', 'Codice sync non valido');
  if (!ID_RE.test(id || ''))     return errorResp(400, 'INVALID_ID', 'photo id non valido');
  if (typeof b64 !== 'string' || b64.length > MAX_SIZE * 1.4) {
    return errorResp(413, 'TOO_LARGE', 'Foto troppo grande (limite ~2 MB compressa)');
  }

  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0 || buf.length > MAX_SIZE) return errorResp(413, 'TOO_LARGE', 'Foto troppo grande');

  await dao.photoSet(code, id, buf, {
    mime: typeof mime === 'string' ? mime : 'image/jpeg',
    uploadedAt: Date.now(),
  });
  return Response.json({ ok: true, id, size: buf.length }, { headers: corsHeaders });
}
