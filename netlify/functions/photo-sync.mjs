/**
 * Netlify Function: photo-sync — storage delle foto PV.
 *
 *   GET    ?code=XXX&id=HASH       → image/jpeg
 *   POST   { code, id, mime, b64 } → salva blob (idempotente)
 *   DELETE ?code=XXX&id=HASH       → cancella blob
 */

import { makeBlobsDao } from '../../src/server/dao/blobs.js';
import { route, json, empty, ApiError } from '../../src/server/api/http.js';
import { photoSyncGetQuery, photoSyncPostBody, photoSyncDeleteQuery } from '../../src/server/api/schemas.js';

const dao = makeBlobsDao();
const MAX_SIZE = 2_000_000; // 2 MB hard cap (compresso lato client ~250 KB)

export default route({
  GET: {
    query: photoSyncGetQuery,
    handler: async ({ query }) => {
      const data = await dao.photoGet(query.code, query.id);
      if (!data) return empty(404);
      return new Response(data, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'private, max-age=86400',
        },
      });
    },
  },

  DELETE: {
    query: photoSyncDeleteQuery,
    handler: async ({ query }) => {
      await dao.photoDelete(query.code, query.id);
      return empty(204);
    },
  },

  POST: {
    body: photoSyncPostBody,
    handler: async ({ body }) => {
      const { code, id, mime, b64 } = body;
      // Check size pre-decode (base64 ~+33% overhead)
      if (b64.length > MAX_SIZE * 1.4) {
        throw new ApiError(413, 'TOO_LARGE', 'Foto troppo grande (limite ~2 MB compressa)');
      }
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 0 || buf.length > MAX_SIZE) {
        throw new ApiError(413, 'TOO_LARGE', 'Foto troppo grande o vuota');
      }
      await dao.photoSet(code, id, buf, {
        mime: typeof mime === 'string' ? mime : 'image/jpeg',
        uploadedAt: Date.now(),
      });
      return json({ ok: true, id, size: buf.length });
    },
  },
});
