// @ts-check
/**
 * Wrapper sottile attorno a `web-push` per separare le dipendenze di rete dalla
 * logica di broadcast. Astrazione = facilità di test + futura sostituzione
 * (es. FCM, APNs nativo) senza toccare il codice chiamante.
 *
 * Configurazione via env:
 *   VAPID_PUBLIC_KEY   — chiave pubblica VAPID (esposta al client)
 *   VAPID_PRIVATE_KEY  — chiave privata (mai esposta)
 *   VAPID_SUBJECT      — mailto:... o URL del sito (default: derivato da URL netlify)
 *
 * Se le chiavi non sono presenti il sender è in modalità no-op: ogni
 * sendNotification ritorna { skipped: true }. Questo evita crash in dev locale
 * o se l'op si dimentica di settare le env in Netlify.
 */
import webpush from 'web-push';

/** @typedef {{ endpoint: string, keys: { p256dh: string, auth: string } }} PushSubscription */

let _configured = false;

function configureOnce() {
  if (_configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  const subject = process.env.VAPID_SUBJECT || 'mailto:noreply@example.com';
  try {
    webpush.setVapidDetails(subject, pub, priv);
    _configured = true;
    return true;
  } catch {
    return false;
  }
}

/** @returns {boolean} */
export function isConfigured() {
  return configureOnce();
}

/** @returns {string|null} */
export function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * Invia una notifica. NON throwa: in caso di errore ritorna `{ ok: false, ... }`.
 * Il chiamante decide cosa fare (tipicamente: nulla, è best-effort).
 *
 * @param {PushSubscription} sub
 * @param {object} payload  oggetto JSON-serializzabile
 * @returns {Promise<{ok: true, statusCode: number} | {ok: false, skipped?: true, statusCode?: number, error?: string, gone?: boolean}>}
 */
export async function sendNotification(sub, payload) {
  if (!configureOnce()) return { ok: false, skipped: true };
  try {
    const res = await webpush.sendNotification(sub, JSON.stringify(payload));
    return { ok: true, statusCode: res.statusCode };
  } catch (err) {
    const sc = err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    // 404 / 410 = endpoint defunto → il chiamante può eliminare la sub.
    const gone = sc === 404 || sc === 410;
    return { ok: false, statusCode: sc, error: err.message, gone };
  }
}

/**
 * Versione iniettabile per i test: passa un sender custom (es. mock) invece di
 * web-push reale. Restituisce lo stesso shape di sendNotification.
 *
 * @param {{ sendNotification: typeof sendNotification }} [override]
 */
export function makeSender(override) {
  if (override && typeof override.sendNotification === 'function') {
    return { sendNotification: override.sendNotification, isConfigured: () => true, getPublicKey: () => 'test-pub-key' };
  }
  return { sendNotification, isConfigured, getPublicKey };
}
