// @ts-check
/**
 * Mini-framework HTTP per Netlify Functions: validazione Zod, error handling
 * centrale, logging strutturato delle richieste. Niente Hono o Express — la
 * superficie è 3 endpoint, una libreria full-fledged sarebbe overkill.
 *
 * Uso tipico in una Function:
 *
 *   import { route, json, ApiError } from '../../src/server/api/http.js';
 *   import { z } from 'zod';
 *
 *   export default route({
 *     GET:  { handler: async ({ query }) => json({ ok: true }) },
 *     POST: {
 *       body: z.object({ code: z.string(), payload: z.any() }),
 *       handler: async ({ body }) => json({ received: body.code }),
 *     },
 *   });
 *
 * Comportamento:
 * - OPTIONS gestita automaticamente (preflight CORS, headers configurati).
 * - validazione fallita → 400 con dettagli campo-per-campo.
 * - ApiError lanciato dall'handler → status + payload coerente.
 * - errori generici → 500, logger.error con il traceback.
 * - ogni richiesta logga: method, path, status, durationMs, error?.
 */

// Reporter strutturato condiviso (server). Niente console.* diretti:
// così quando IP vorrà Sentry/Datadog basta swappare l'adapter via setReporter.
import reporterMod from '../../core/reporter.js';
const { report } = reporterMod;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Metriche in-memory per istanza Function: contatori per (method, path, status)
// e accumulazione delle durate per p50/p95. Esposto via getMetrics() — usato
// dall'endpoint health o da un Sentry-like adapter futuro.
const _metrics = {
  byRoute: new Map(),   // key = method+path → { count, statuses: Map<status, n>, durations: number[] }
};
function recordMetric(method, path, status, durationMs) {
  const key = `${method} ${path}`;
  let row = _metrics.byRoute.get(key);
  if (!row) { row = { count: 0, statuses: new Map(), durations: [] }; _metrics.byRoute.set(key, row); }
  row.count++;
  row.statuses.set(status, (row.statuses.get(status) || 0) + 1);
  // Buffer circolare delle durate: max 200 valori per route per stimare percentili
  if (row.durations.length >= 200) row.durations.shift();
  row.durations.push(durationMs);
}
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
/** Snapshot delle metriche correnti (formato leggero, JSON-serializable). */
export function getMetrics() {
  const out = {};
  for (const [key, row] of _metrics.byRoute.entries()) {
    const sorted = [...row.durations].sort((a, b) => a - b);
    out[key] = {
      count: row.count,
      statuses: Object.fromEntries(row.statuses.entries()),
      p50ms: percentile(sorted, 50),
      p95ms: percentile(sorted, 95),
    };
  }
  return out;
}

/** Errore "controllato" lanciato dagli handler. */
export class ApiError extends Error {
  /**
   * @param {number} status   HTTP status code
   * @param {string} code     codice macchina (es. INVALID_CODE)
   * @param {string} message  messaggio leggibile dall'utente
   * @param {object} [detail] dettaglio opzionale (es. errori per campo)
   */
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Costruisce una Response JSON con CORS headers. */
export function json(body, init = {}) {
  const status = init.status || 200;
  const headers = { ...CORS_HEADERS, ...(init.headers || {}) };
  return Response.json(body, { status, headers });
}

/** Risposta vuota con headers CORS. */
export function empty(status, init = {}) {
  return new Response(init.body || null, { status, headers: { ...CORS_HEADERS, ...(init.headers || {}) } });
}

/** Crea un Response error con shape uniforme { error, message, detail? }. */
function errorResponse(status, code, message, detail) {
  const body = { error: code, message };
  if (detail !== undefined) body.detail = detail;
  return json(body, { status });
}

/**
 * Crea il dispatcher per una Function. `routes` è un oggetto method→config:
 *   { GET: { handler }, POST: { body: zodSchema, handler }, ... }
 *
 * Ogni handler riceve un oggetto context: { req, url, query, body?, params? }
 * e ritorna una Response (o lancia ApiError).
 *
 * @param {Record<string, { handler: Function, body?: any, query?: any, before?: Function[] }>} routes
 */
export function route(routes) {
  return async function handler(req) {
    const start = Date.now();
    const url = new URL(req.url);
    const method = req.method;
    let status = 500; // verrà aggiornato

    try {
      if (method === 'OPTIONS') {
        status = 204;
        return empty(204);
      }
      const cfg = routes[method];
      if (!cfg) {
        status = 405;
        return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Metodo non supportato', { allowed: Object.keys(routes) });
      }

      const ctx = { req, url, query: Object.fromEntries(url.searchParams) };

      // Middleware "before" (es. rate limit): ognuno riceve ctx e può ritornare
      // una Response — in tal caso interrompe la pipeline (es. 429 troppo veloce).
      if (Array.isArray(cfg.before)) {
        for (const mw of cfg.before) {
          const r = await mw(ctx);
          if (r instanceof Response) { status = r.status; return r; }
        }
      }

      // Validazione query con Zod (se presente)
      if (cfg.query) {
        const parsed = cfg.query.safeParse(ctx.query);
        if (!parsed.success) {
          status = 400;
          return errorResponse(400, 'INVALID_QUERY', 'Parametri query non validi', flattenZodIssues(parsed.error));
        }
        ctx.query = parsed.data;
      }

      // Validazione body con Zod (se presente, solo metodi che lo prevedono)
      if (cfg.body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        let raw;
        try { raw = await req.json(); }
        catch {
          status = 400;
          return errorResponse(400, 'INVALID_BODY', 'Body non è JSON valido');
        }
        const parsed = cfg.body.safeParse(raw);
        if (!parsed.success) {
          status = 400;
          return errorResponse(400, 'INVALID_BODY', 'Body non valido', flattenZodIssues(parsed.error));
        }
        ctx.body = parsed.data;
      }

      const resp = await cfg.handler(ctx);
      status = resp.status || 200;
      return resp;

    } catch (err) {
      if (err instanceof ApiError) {
        status = err.status;
        return errorResponse(err.status, err.code, err.message, err.detail);
      }
      status = 500;
      // Log strutturato via reporter (no console diretto: ADR-003 stesso pattern).
      // NO PII: codice sync intenzionalmente omesso dal contesto.
      report.error(err, { method, path: url.pathname });
      return errorResponse(500, 'INTERNAL', err && err.message ? err.message : 'errore interno');
    } finally {
      const durationMs = Date.now() - start;
      recordMetric(method, url.pathname, status, durationMs);
      // Request log: una riga per richiesta. info per 2xx, warn 4xx, error 5xx.
      const summary = { method, path: url.pathname, status, durationMs };
      if (status >= 500) report.error('request', summary);
      else if (status >= 400) report.warn('request', summary);
      else report.info('request', summary);
    }
  };
}

/** Compatta gli issue Zod in un dizionario campo→messaggio per il client. */
function flattenZodIssues(error) {
  const out = {};
  for (const issue of error.issues || []) {
    const path = issue.path.join('.') || '_';
    out[path] = issue.message;
  }
  return out;
}
