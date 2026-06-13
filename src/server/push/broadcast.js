// @ts-check
/**
 * Broadcast di eventi push verso tutte le subscription di un codice sync,
 * filtrando il device che ha originato il cambio (no self-notify).
 *
 * Logica pura: nessuna I/O diretta, dipendenze iniettate. Testabile in
 * isolamento col makeMemoryDao + un sender mock.
 */

const STATUS_LABEL = {
  'sopr-todo':  'Sopralluogo da fare',
  'attesa':     'In attesa Serena',
  'inst-todo':  'Installazione da fare',
  'completato': 'Completato',
  'sospeso':    'Sospeso',
  'archive':    'Archiviato',
};

/**
 * @param {{pv:number,type:string,toStatus:string,fromStatus?:string,deviceLabel?:string,ts:number}} ev
 * @returns {{title: string, body: string, data: object}}
 */
export function formatEventPayload(ev) {
  const to = STATUS_LABEL[ev.toStatus] || ev.toStatus;
  const from = ev.fromStatus ? (STATUS_LABEL[ev.fromStatus] || ev.fromStatus) : null;
  const who = ev.deviceLabel ? ` da ${ev.deviceLabel}` : '';
  const title = `PV ${ev.pv} → ${to}`;
  const body = from
    ? `Era "${from}"${who}.`
    : `Stato aggiornato${who}.`;
  return {
    title,
    body,
    data: { pv: ev.pv, type: ev.type, ts: ev.ts },
  };
}

/**
 * Broadcasta una lista di eventi a tutte le subscription del codice tranne
 * `excludeDeviceId`. Rimuove le subscription "gone" (404/410). Ritorna stats.
 *
 * @param {object} args
 * @param {import('../dao/interface.js').Dao} args.dao
 * @param {{ sendNotification: Function }} args.sender
 * @param {string} args.code
 * @param {string|null|undefined} args.excludeDeviceId
 * @param {Array<{pv:number,type:string,toStatus:string,fromStatus?:string,deviceLabel?:string,ts:number}>} args.events
 * @returns {Promise<{sent: number, failed: number, removed: number, skipped: number}>}
 */
export async function broadcastEvents({ dao, sender, code, excludeDeviceId, events }) {
  if (!events || !events.length) return { sent: 0, failed: 0, removed: 0, skipped: 0 };
  const subs = await dao.pushSubList(code);
  const targets = subs.filter(s => s.deviceId !== excludeDeviceId);
  let sent = 0, failed = 0, removed = 0, skipped = 0;
  for (const ev of events) {
    const payload = formatEventPayload(ev);
    for (const t of targets) {
      const r = await sender.sendNotification(t.subscription, payload);
      if (r.skipped) { skipped++; continue; }
      if (r.ok) { sent++; continue; }
      failed++;
      if (r.gone) {
        await dao.pushSubRemove(code, t.deviceId);
        removed++;
      }
    }
  }
  return { sent, failed, removed, skipped };
}
