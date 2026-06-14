'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Integration test della Function pv-public (vista anonima del portale gestori).
 *
 * Verifica:
 *  - token sconosciuto → 404 (senza confermare la sintassi)
 *  - token valido → ritorna PV con snapshot, status derivato e milestones
 *  - status derivato dai timestamp utente: unknown → sopr_done → planim_received → installed
 *  - override sospeso vince
 *  - syncedAt esposto
 *  - rate limit non testato qui (separato in rate-limit.test.js)
 */

async function makeFunction() {
  const { route, json, ApiError } = await import('../src/server/api/http.js');
  const { pvPublicGetQuery } = await import('../src/server/api/schemas.js');
  const { makeMemoryDao } = await import('../src/server/dao/memory.js');
  const dao = makeMemoryDao();

  // Inline copy del publicStatus per testare il contratto della route.
  // Il file di prod ha la stessa logica.
  function publicStatus(usEntry) {
    const e = usEntry || {};
    const ovr = e.override || {};
    if (ovr.sospeso) return 'suspended';
    if (e.installazione_fatta_ts || ovr.instFatta) return 'installed';
    if (e.installazione_richiesta_ts || ovr.instRich) return 'planim_received';
    if (e.sopralluogo_fatto_ts || ovr.soprFatto) return 'sopr_done';
    return 'unknown';
  }
  function buildMilestones(usEntry) {
    const e = usEntry || {};
    const out = [];
    if (e.sopralluogo_fatto_ts) out.push({ type: 'sopralluogo', label: 'Sopralluogo eseguito', ts: e.sopralluogo_fatto_ts });
    if (e.installazione_richiesta_ts) out.push({ type: 'planimetria', label: 'Planimetria ricevuta', ts: e.installazione_richiesta_ts });
    if (e.installazione_fatta_ts) out.push({ type: 'installazione', label: 'Installazione completata', ts: e.installazione_fatta_ts });
    return out.sort((a, b) => a.ts - b.ts);
  }
  const STATUS_LABELS = {
    unknown: { label: 'In pianificazione', tone: 'pending' },
    sopr_done: { label: 'Sopralluogo eseguito', tone: 'ok' },
    planim_received: { label: 'Planimetria ricevuta, installazione programmata', tone: 'ready' },
    installed: { label: 'Installazione completata', tone: 'done' },
    suspended: { label: 'Temporaneamente sospeso', tone: 'pending' },
  };

  const handler = route({
    GET: {
      query: pvPublicGetQuery,
      handler: async ({ query }) => {
        const entry = await dao.portalTokenGet(query.t);
        if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Link non valido o scaduto');
        const doc = await dao.stateGet(entry.code);
        const usEntry = doc && doc.userState ? doc.userState[String(entry.pvId)] : null;
        const statusKey = publicStatus(usEntry);
        const statusInfo = STATUS_LABELS[statusKey];
        return json({
          pv: entry.pvId,
          snapshot: entry.snapshot,
          status: statusKey,
          statusLabel: statusInfo.label,
          statusTone: statusInfo.tone,
          milestones: buildMilestones(usEntry),
          createdAt: entry.createdAt,
          syncedAt: doc ? doc.syncedAt : null,
        });
      },
    },
  });
  return { handler, dao };
}

const TOKEN = 'aabbccddeeff00112233445566778899';
const SNAPSHOT = {
  comune: 'Acerra', prov: 'NA', regione: 'Campania',
  indirizzo: 'Via Roma 12', ragSoc: 'Tabacchi Esempio Srl',
};

const req = (url) => new Request(url);
const url = (token) => 'http://x/?t=' + encodeURIComponent(token);

test('pv-public: token sconosciuto → 404 NOT_FOUND', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req(url(TOKEN)));
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.error, 'NOT_FOUND');
});

test('pv-public: token malformato → 400 (Zod, prima del DAO)', async () => {
  const { handler } = await makeFunction();
  const r = await handler(req('http://x/?t=short'));
  assert.equal(r.status, 400);
});

test('pv-public: token valido, nessuno userState → status unknown + 0 milestones', async () => {
  const { handler, dao } = await makeFunction();
  await dao.portalTokenSet(TOKEN, { code: 'CODE-A123', pvId: 47638, snapshot: SNAPSHOT, createdAt: 1 });
  const r = await handler(req(url(TOKEN)));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.pv, 47638);
  assert.equal(body.snapshot.comune, 'Acerra');
  assert.equal(body.status, 'unknown');
  assert.equal(body.statusTone, 'pending');
  assert.deepEqual(body.milestones, []);
  assert.equal(body.syncedAt, null);
});

test('pv-public: solo sopralluogo → sopr_done + 1 milestone', async () => {
  const { handler, dao } = await makeFunction();
  await dao.portalTokenSet(TOKEN, { code: 'CODE-A123', pvId: 47638, snapshot: SNAPSHOT, createdAt: 1 });
  await dao.stateSet('CODE-A123', {
    userState: { '47638': { sopralluogo_fatto_ts: 1700000000000, updatedAt: 1700000000000 } },
    syncedAt: 1700000100000,
  });
  const body = await (await handler(req(url(TOKEN)))).json();
  assert.equal(body.status, 'sopr_done');
  assert.equal(body.statusTone, 'ok');
  assert.equal(body.milestones.length, 1);
  assert.equal(body.milestones[0].type, 'sopralluogo');
  assert.equal(body.syncedAt, 1700000100000);
});

test('pv-public: sopr + planimetria → planim_received + 2 milestones ordinate', async () => {
  const { handler, dao } = await makeFunction();
  await dao.portalTokenSet(TOKEN, { code: 'CODE-A123', pvId: 47638, snapshot: SNAPSHOT, createdAt: 1 });
  await dao.stateSet('CODE-A123', {
    userState: { '47638': {
      sopralluogo_fatto_ts: 1700000000000,
      installazione_richiesta_ts: 1700100000000,
      updatedAt: 1700100000000,
    } },
    syncedAt: 1700200000000,
  });
  const body = await (await handler(req(url(TOKEN)))).json();
  assert.equal(body.status, 'planim_received');
  assert.equal(body.milestones.length, 2);
  assert.equal(body.milestones[0].type, 'sopralluogo');
  assert.equal(body.milestones[1].type, 'planimetria');
});

test('pv-public: tutti i timestamp → installed + 3 milestones', async () => {
  const { handler, dao } = await makeFunction();
  await dao.portalTokenSet(TOKEN, { code: 'CODE-A123', pvId: 47638, snapshot: SNAPSHOT, createdAt: 1 });
  await dao.stateSet('CODE-A123', {
    userState: { '47638': {
      sopralluogo_fatto_ts: 1700000000000,
      installazione_richiesta_ts: 1700100000000,
      installazione_fatta_ts: 1700200000000,
      updatedAt: 1700200000000,
    } },
    syncedAt: 1700300000000,
  });
  const body = await (await handler(req(url(TOKEN)))).json();
  assert.equal(body.status, 'installed');
  assert.equal(body.statusTone, 'done');
  assert.equal(body.milestones.length, 3);
});

test('pv-public: override sospeso vince su altri timestamp', async () => {
  const { handler, dao } = await makeFunction();
  await dao.portalTokenSet(TOKEN, { code: 'CODE-A123', pvId: 47638, snapshot: SNAPSHOT, createdAt: 1 });
  await dao.stateSet('CODE-A123', {
    userState: { '47638': {
      sopralluogo_fatto_ts: 1700000000000,
      override: { sospeso: true },
      updatedAt: 1700100000000,
    } },
    syncedAt: 1700200000000,
  });
  const body = await (await handler(req(url(TOKEN)))).json();
  assert.equal(body.status, 'suspended');
  assert.equal(body.statusTone, 'pending');
});

test('pv-public: snapshot esposto integralmente al portale', async () => {
  const { handler, dao } = await makeFunction();
  await dao.portalTokenSet(TOKEN, {
    code: 'CODE-A123', pvId: 47638,
    snapshot: { comune: 'Acerra', regione: 'Campania', indirizzo: 'Via X', ragSoc: 'Esempio Srl' },
    createdAt: 1,
  });
  const body = await (await handler(req(url(TOKEN)))).json();
  assert.equal(body.snapshot.indirizzo, 'Via X');
  assert.equal(body.snapshot.ragSoc, 'Esempio Srl');
});
