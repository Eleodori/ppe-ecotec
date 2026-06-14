'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Test integration della Function state-sync usando il DAO in-memory.
 * Importiamo direttamente i pezzi senza caricare la Function "completa"
 * (che imposta il DAO Blobs a module-load): rimontiamo il routing con
 * il DAO Memory iniettato. Vedi src/server/dao/memory.js.
 */

async function makeFunction(opts = {}) {
  const { route, json, ApiError } = await import('../src/server/api/http.js');
  const { stateSyncGetQuery, stateSyncPostBody, dateSchema } = await import('../src/server/api/schemas.js');
  const syncMerge = (await import('../src/core/sync-merge.js')).default;
  const { makeMemoryDao } = await import('../src/server/dao/memory.js');
  const { broadcastEvents } = await import('../src/server/push/broadcast.js');
  const dao = makeMemoryDao();
  const { mergeStates } = syncMerge;
  // Sender mockabile via opts.sender; default = silent no-op.
  const sender = opts.sender || { sendNotification: async () => ({ ok: true, statusCode: 201 }) };

  const handler = route({
    GET: {
      query: stateSyncGetQuery,
      handler: async ({ query }) => {
        const { code, snapshots, restore } = query;
        if (snapshots) return json({ snapshots: await dao.snapshotList(code) });
        if (restore) {
          const parsed = dateSchema.safeParse(restore);
          if (!parsed.success) throw new ApiError(400, 'INVALID_DATE', 'Data non valida');
          const snap = await dao.snapshotGet(code, restore);
          if (!snap) throw new ApiError(404, 'SNAPSHOT_NOT_FOUND', 'Snapshot non trovato');
          return json(snap);
        }
        const doc = await dao.stateGet(code);
        return json(doc || { userState: null, syncedAt: null });
      },
    },
    POST: {
      body: stateSyncPostBody,
      handler: async ({ body }) => {
        const { code, userState, replace, deviceId, events } = body;
        let merged;
        if (replace) merged = userState;
        else {
          const existing = await dao.stateGet(code);
          merged = mergeStates(existing && existing.userState, userState);
        }
        const payload = { userState: merged, syncedAt: Date.now() };
        await dao.stateSet(code, payload);
        const today = new Date().toISOString().slice(0, 10);
        await dao.snapshotSet(code, today, payload);
        if (events && events.length) {
          await broadcastEvents({ dao, sender, code, excludeDeviceId: deviceId, events });
        }
        return json(payload);
      },
    },
  });

  return { handler, dao };
}

const req = (method, url, body) => new Request(url, {
  method,
  headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
});

test('GET state mai pushato → { userState: null }', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('GET', 'http://x/?code=ABC123-OK'));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.userState, null);
});

test('POST iniziale + GET ritorna lo stesso stato', async () => {
  const { handler } = await makeFunction();
  const userState = { '100': { updatedAt: 100, soprFatto: true } };
  const post = await handler(req('POST', 'http://x/', { code: 'CODE-A123', userState }));
  assert.equal(post.status, 200);
  const get = await handler(req('GET', 'http://x/?code=CODE-A123'));
  const body = await get.json();
  assert.deepEqual(body.userState['100'], userState['100']);
});

test('POST poi POST con merge LWW: vince updatedAt più alto', async () => {
  const { handler } = await makeFunction();
  await handler(req('POST', 'http://x/', { code: 'M-Test', userState: { '1': { updatedAt: 10, v: 'old' } } }));
  await handler(req('POST', 'http://x/', { code: 'M-Test', userState: { '1': { updatedAt: 20, v: 'new' } } }));
  const body = await (await handler(req('GET', 'http://x/?code=M-Test'))).json();
  assert.equal(body.userState['1'].v, 'new');
});

test('POST replace:true sovrascrive senza merge', async () => {
  const { handler } = await makeFunction();
  await handler(req('POST', 'http://x/', { code: 'R-Test', userState: { '1': { updatedAt: 10 }, '2': { updatedAt: 10 } } }));
  await handler(req('POST', 'http://x/', { code: 'R-Test', userState: { '1': { updatedAt: 1 } }, replace: true }));
  const body = await (await handler(req('GET', 'http://x/?code=R-Test'))).json();
  assert.equal(body.userState['1'].updatedAt, 1, 'replace ha vinto');
  assert.equal(body.userState['2'], undefined, 'entry 2 sparita');
});

test('GET ?snapshots=1 elenca le date salvate', async () => {
  const { handler, dao } = await makeFunction();
  // Inseriamo direttamente nel DAO due snapshot di date diverse
  await dao.snapshotSet('S-Test', '2026-06-01', { userState: {}, syncedAt: 1 });
  await dao.snapshotSet('S-Test', '2026-06-02', { userState: {}, syncedAt: 2 });
  const resp = await handler(req('GET', 'http://x/?code=S-Test&snapshots=1'));
  const body = await resp.json();
  assert.equal(body.snapshots.length, 2);
  assert.equal(body.snapshots[0].date, '2026-06-02', 'ordine desc');
});

test('GET ?restore=YYYY-MM-DD ritorna lo snapshot di quella data', async () => {
  const { handler, dao } = await makeFunction();
  await dao.snapshotSet('R2-Test', '2026-06-01', { userState: { x: 1 }, syncedAt: 999 });
  const resp = await handler(req('GET', 'http://x/?code=R2-Test&restore=2026-06-01'));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.userState.x, 1);
});

test('GET restore di data inesistente → 404 SNAPSHOT_NOT_FOUND', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('GET', 'http://x/?code=N-Test&restore=2099-01-01'));
  assert.equal(resp.status, 404);
  assert.equal((await resp.json()).error, 'SNAPSHOT_NOT_FOUND');
});

test('POST con codice non valido → 400 INVALID_BODY (validazione Zod)', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('POST', 'http://x/', { code: 'xx', userState: {} }));
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.equal(body.error, 'INVALID_BODY');
  assert.ok(body.detail.code, 'errore sul campo code');
});

test('POST con userState non oggetto → 400', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('POST', 'http://x/', { code: 'OK-Code', userState: 'not-an-object' }));
  assert.equal(resp.status, 400);
});

test('GET senza code → 400 INVALID_QUERY', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('GET', 'http://x/'));
  assert.equal(resp.status, 400);
});

test('OPTIONS → 204 con headers CORS', async () => {
  const { handler } = await makeFunction();
  const resp = await handler(req('OPTIONS', 'http://x/'));
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), '*');
});

// === Hook push broadcast ===

test('POST con events: triggera broadcast verso altri device', async () => {
  const sub = (id) => ({ endpoint: 'https://push.example/' + id, keys: { p256dh: 'pk' + id, auth: 'ak' + id } });
  const sent = [];
  const sender = { sendNotification: async (s, payload) => { sent.push({ endpoint: s.endpoint, payload }); return { ok: true, statusCode: 201 }; } };
  const { handler, dao } = await makeFunction({ sender });

  // Pre-popola 2 subs sul codice
  await dao.pushSubAdd('BCAST-Test', 'device-1-aaa', { deviceId: 'device-1-aaa', subscription: sub('1'), createdAt: 1 });
  await dao.pushSubAdd('BCAST-Test', 'device-2-bbb', { deviceId: 'device-2-bbb', subscription: sub('2'), createdAt: 2 });

  const resp = await handler(req('POST', 'http://x/', {
    code: 'BCAST-Test',
    userState: { '100': { updatedAt: 100 } },
    deviceId: 'device-1-aaa',
    events: [{ pv: 100, type: 'state-change', toStatus: 'completato', fromStatus: 'inst-todo', ts: 1000 }],
  }));
  assert.equal(resp.status, 200);
  assert.equal(sent.length, 1, 'inviata solo al device che non ha originato');
  assert.equal(sent[0].endpoint, 'https://push.example/2');
  assert.match(sent[0].payload.title, /PV 100/);
  assert.match(sent[0].payload.title, /Completato/);
  assert.match(sent[0].payload.body, /Installazione da fare/);
});

test('POST senza events: no chiamate al sender', async () => {
  const sent = [];
  const sender = { sendNotification: async (s, p) => { sent.push({ s, p }); return { ok: true, statusCode: 201 }; } };
  const { handler, dao } = await makeFunction({ sender });
  await dao.pushSubAdd('NoEv-Test', 'device-1-aaa', { deviceId: 'device-1-aaa', subscription: { endpoint: 'https://x', keys: { p256dh: 'k', auth: 'a' } }, createdAt: 1 });
  await handler(req('POST', 'http://x/', { code: 'NoEv-Test', userState: { '1': { updatedAt: 1 } } }));
  assert.equal(sent.length, 0, 'senza events nessun broadcast');
});

test('POST con events ma push transient fail (5xx): sync resta 200', async () => {
  // Il sender wrapper garantisce di non rilanciare: ritorna { ok:false, statusCode }.
  // broadcastEvents quindi non lancia, il sync ha sempre status 200.
  const sender = { sendNotification: async () => ({ ok: false, statusCode: 500, error: 'transient' }) };
  const { handler, dao } = await makeFunction({ sender });
  await dao.pushSubAdd('Fail-Test', 'device-1-aaa', { deviceId: 'device-1-aaa', subscription: { endpoint: 'https://x', keys: { p256dh: 'k', auth: 'a' } }, createdAt: 1 });
  const resp = await handler(req('POST', 'http://x/', {
    code: 'Fail-Test',
    userState: { '1': { updatedAt: 1 } },
    deviceId: 'device-x-xxx',
    events: [{ pv: 1, type: 'state-change', toStatus: 'completato', ts: 1 }],
  }));
  assert.equal(resp.status, 200, 'il sync non deve fallire per push down');
});
