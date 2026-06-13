// @ts-check
/**
 * Error reporter pluggabile — interfaccia stabile per inviare errori e log
 * strutturati verso un backend di osservabilità.
 *
 * Oggi l'implementazione di default è "console" (Netlify cattura stdout/stderr
 * per 24h, sufficiente per debugging). Quando IP vorrà Sentry / Datadog /
 * CloudWatch basterà sostituire l'adapter in src/server/observability/reporter.js
 * o injectarne uno custom via setReporter().
 *
 * Vedi docs/architecture.md ADR-003 (stesso pattern del DAL applicato
 * all'osservabilità).
 *
 * Uso server-side:
 *   import { report } from '../../src/server/observability/reporter.js';
 *   report.error(err, { route: 'state-sync', method: 'POST' });
 *   report.warn('quota near limit', { remaining: 50 });
 *   report.info('user action', { event: 'restore', date: '2026-06-12' });
 *
 * Uso client-side (caricato via <script>):
 *   reporter.error(err, { component: 'photo-upload' });
 *
 * @typedef {'error'|'warn'|'info'|'debug'} LogLevel
 *
 * @typedef {Object} Reporter
 * @property {(err: Error|string, ctx?: object) => void} error
 * @property {(msg: string, ctx?: object) => void} warn
 * @property {(msg: string, ctx?: object) => void} info
 * @property {(msg: string, ctx?: object) => void} debug
 */

(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(global, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Adapter "console": format JSON una riga per record (parsabile dai log
   * collector di Netlify/AWS). Non emette PII per definizione: chi chiama
   * `report.error/warn/info` deve aver già filtrato il payload.
   *
   * @returns {Reporter}
   */
  function makeConsoleReporter() {
    function emit(level, payload) {
      const line = JSON.stringify({ ts: Date.now(), level, ...payload });
      // console.error per warn/error → finisce su stderr (Netlify le evidenzia);
      // info/debug su stdout. Stessa convenzione di syslog.
      if (level === 'error' || level === 'warn') console.error(line);
      else console.log(line);
    }
    return {
      error(err, ctx) {
        const isErr = err && typeof err === 'object' && 'message' in err;
        emit('error', {
          message: isErr ? err.message : String(err),
          name: isErr ? err.name : undefined,
          stack: isErr ? err.stack : undefined,
          ctx: ctx || undefined,
        });
      },
      warn(msg, ctx)  { emit('warn',  { message: msg, ctx: ctx || undefined }); },
      info(msg, ctx)  { emit('info',  { message: msg, ctx: ctx || undefined }); },
      debug(msg, ctx) { emit('debug', { message: msg, ctx: ctx || undefined }); },
    };
  }

  /**
   * Adapter "memory" — solo per test. Salva i record in un array invece di
   * scriverli, esposto via .records.
   *
   * @returns {Reporter & { records: Array<object>, clear: () => void }}
   */
  function makeMemoryReporter() {
    const records = [];
    const make = level => (msg, ctx) => {
      const isErr = msg && typeof msg === 'object' && 'message' in msg;
      records.push({
        level,
        message: isErr ? msg.message : String(msg),
        name: isErr ? msg.name : undefined,
        stack: isErr ? msg.stack : undefined,
        ctx: ctx || undefined,
        ts: Date.now(),
      });
    };
    return {
      error: make('error'),
      warn: make('warn'),
      info: make('info'),
      debug: make('debug'),
      records,
      clear() { records.length = 0; },
    };
  }

  // === Singleton modificabile (DI per i test e per futuri adapter SaaS) ===

  let _reporter = makeConsoleReporter();

  /** Sostituisce il reporter globale. Tipicamente chiamato all'avvio del modulo. */
  function setReporter(r) { _reporter = r; }

  /** Reporter globale corrente. */
  const report = {
    error(err, ctx) { _reporter.error(err, ctx); },
    warn(msg, ctx)  { _reporter.warn(msg, ctx); },
    info(msg, ctx)  { _reporter.info(msg, ctx); },
    debug(msg, ctx) { _reporter.debug(msg, ctx); },
  };

  return { makeConsoleReporter, makeMemoryReporter, setReporter, report };
});
