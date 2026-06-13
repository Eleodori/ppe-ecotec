// @ts-check
/**
 * Rate limiting "token bucket" per le Netlify Functions.
 *
 * Stato per-IP in Netlify Blobs (store rate-limit), gestito attraverso il DAO.
 * NB: non è perfetto perché ogni Function instance ha la sua cache in-memory
 * disabilitata (Netlify scala in modo serverless); il backing è sempre Blobs.
 *
 * Algoritmo (token bucket):
 *  - Ogni IP ha un "secchio" con max=capacity token.
 *  - Ogni richiesta consuma 1 token.
 *  - I token si ricaricano a velocità refillPerSec, fino a capacity.
 *  - Se non c'è almeno 1 token disponibile → 429.
 *
 * Limite di default pensato per gli endpoint che spendono soldi (distance-matrix
 * = quota ORS). Per sync/foto si può alzare o omettere.
 */
import { createHash } from 'crypto';

const TTL_MS = 60 * 60 * 1000; // 1h: bucket dimenticati dopo questo periodo

/**
 * Estrae l'IP del client dalla Request. Considera gli header dei reverse-proxy
 * di Netlify (Forwarded, x-forwarded-for, x-nf-client-connection-ip).
 * Il primo IP nella catena = client originario.
 *
 * @param {Request} req
 * @returns {string}
 */
export function clientIp(req) {
  const h = req.headers;
  const direct = h.get('x-nf-client-connection-ip');
  if (direct) return direct.trim();
  const fwd = h.get('forwarded');
  if (fwd) {
    const m = /for="?([^";]+)"?/i.exec(fwd);
    if (m) return m[1].trim();
  }
  const xfwd = h.get('x-forwarded-for');
  if (xfwd) return xfwd.split(',')[0].trim();
  return 'unknown';
}

function ipKey(scope, ip) {
  return `${scope}/${createHash('sha256').update('pee-rl:' + ip).digest('hex')}`;
}

/**
 * Crea un middleware rate-limit per una specifica "scope" (es. 'ors', 'sync').
 *
 * @param {object} opts
 * @param {string} opts.scope                 nome route per separare i bucket
 * @param {number} opts.capacity              token max per bucket (≈ burst)
 * @param {number} opts.refillPerSec          velocità di ricarica (token/sec)
 * @param {() => {get:Function,set:Function}} opts.getStore  factory store Blobs (DI per test)
 *
 * Ritorna { check(req): Promise<{allowed, retryAfterSec?}> }.
 */
export function makeRateLimiter(opts) {
  const { scope, capacity, refillPerSec, getStore } = opts;
  if (!scope || !capacity || !refillPerSec || !getStore) {
    throw new Error('rate-limit: scope, capacity, refillPerSec, getStore richiesti');
  }

  return {
    async check(req) {
      const ip = clientIp(req);
      const key = ipKey(scope, ip);
      const now = Date.now();
      let store;
      try { store = getStore(); } catch {
        // Storage non disponibile: in dev/test non blocchiamo (preferiamo
        // un falso negativo che bloccare lo sviluppo).
        return { allowed: true };
      }

      let bucket;
      try { bucket = await store.get(key, { type: 'json' }); }
      catch { bucket = null; }

      // Inizializza o "ricarica" il bucket sulla base del tempo trascorso.
      if (!bucket || (now - (bucket.t || 0)) > TTL_MS) {
        bucket = { tokens: capacity - 1, t: now };
      } else {
        const elapsed = (now - bucket.t) / 1000;
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
        bucket.t = now;
        if (bucket.tokens < 1) {
          const retryAfterSec = Math.ceil((1 - bucket.tokens) / refillPerSec);
          // Non scriviamo (per ridurre il numero di scritture): il prossimo passaggio ricomputerà.
          return { allowed: false, retryAfterSec };
        }
        bucket.tokens -= 1;
      }

      try { await store.set(key, JSON.stringify(bucket)); }
      catch { /* non bloccante */ }

      return { allowed: true };
    },
  };
}
