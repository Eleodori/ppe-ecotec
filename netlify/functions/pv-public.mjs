/**
 * Netlify Function: pv-public — vista pubblica read-only di un PV via token.
 *
 *   GET ?t=TOKEN  → { pv, status, milestones[], snapshot, statusLabel }
 *
 * Anonima (no codice, no auth): chiunque abbia il token vede il PV in
 * sola lettura. Token gestito da portal-token.mjs. Rate-limit aggressivo
 * sul GET per scoraggiare enumerazione (anche se 128-bit tokens sono già
 * irraggiungibili a brute-force).
 *
 * Status derivato senza il PV master: usiamo solo i timestamp utente
 * (sopralluogo_fatto_ts, installazione_richiesta_ts, installazione_fatta_ts)
 * e gli override booleani. Il portale non deve mai vedere "sopr-todo"
 * dedotto dal master — solo cose che il crew sul campo ha attivamente
 * fatto/dichiarato.
 */

import { getStore } from '@netlify/blobs';
import { makeBlobsDao } from '../../src/server/dao/blobs.js';
import { route, json, ApiError } from '../../src/server/api/http.js';
import { pvPublicGetQuery } from '../../src/server/api/schemas.js';
import { makeRateLimiter } from '../../src/server/api/rate-limit.js';
import reporterMod from '../../src/core/reporter.js';
const { report } = reporterMod;

const dao = makeBlobsDao();

// Rate-limit aggressivo: la lettura è pubblica, non c'è ragione per un
// gestore di superare ~30/min. Bot enumeratori vengono respinti.
const limiter = makeRateLimiter({
  scope: 'pv-public',
  capacity: 30,
  refillPerSec: 20 / 60,
  getStore: () => getStore('rate-limit'),
});

async function rateLimit(ctx) {
  const r = await limiter.check(ctx.req);
  if (!r.allowed) {
    return json(
      { error: 'RATE_LIMITED', message: `Troppe richieste. Riprova tra ~${r.retryAfterSec}s.` },
      { status: 429, headers: { 'Retry-After': String(r.retryAfterSec) } }
    );
  }
}

const STATUS_LABELS = {
  unknown: { label: 'In pianificazione', tone: 'pending' },
  sopr_done: { label: 'Sopralluogo eseguito', tone: 'ok' },
  planim_received: { label: 'Planimetria ricevuta, installazione programmata', tone: 'ready' },
  installed: { label: 'Installazione completata', tone: 'done' },
  suspended: { label: 'Temporaneamente sospeso', tone: 'pending' },
};

/**
 * Deriva lo status pubblico dal userState entry. Logica conservativa: mostra
 * solo eventi positivi tracciati (timestamp presenti) o sospeso esplicito.
 * Niente master = niente "sopralluogo da fare" dedotto.
 */
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

export default route({
  GET: {
    before: [rateLimit],
    query: pvPublicGetQuery,
    handler: async ({ query }) => {
      const entry = await dao.portalTokenGet(query.t);
      if (!entry) {
        // 404 generico: non confermiamo neanche la sintassi del token.
        throw new ApiError(404, 'NOT_FOUND', 'Link non valido o scaduto');
      }
      const doc = await dao.stateGet(entry.code);
      const usEntry = doc && doc.userState ? doc.userState[String(entry.pvId)] : null;
      const statusKey = publicStatus(usEntry);
      const statusInfo = STATUS_LABELS[statusKey];

      report.info('portal view', { pvId: entry.pvId, status: statusKey });
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
