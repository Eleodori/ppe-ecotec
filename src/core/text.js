// @ts-check
/**
 * Core text — utility di testo pure: escaping output e parsing import.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(global, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Escape per interpolazione sicura in innerHTML (anti-XSS).
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Cella CSV sicura: neutralizza la CSV injection (Excel/Sheets valutano come
  // formula le celle che iniziano con = + - @ tab/CR) e raddoppia le virgolette.
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  }

  // Estrae da testo libero (righe copiate da PDF/Excel) le coppie {pv, desired}.
  // Riconosce il PV come gruppo di 5 cifre e l'attività da parole chiave.
  function parseStateList(text) {
    const out = [];
    for (const line of (text || '').split(/\r?\n/)) {
      const pvM = line.match(/\b(\d{5})\b/);
      if (!pvM) continue;
      const U = line.toUpperCase();
      let desired = null;
      if (/SOSPES/.test(U)) desired = 'sospeso';
      else if (/SOPRALL|RILIEV/.test(U)) desired = 'sopr-todo';
      else if (/INSTALL/.test(U)) desired = 'inst-todo';
      if (desired) out.push({ pv: parseInt(pvM[1]), desired });
    }
    return out;
  }

  return { escapeHtml, csvCell, parseStateList };
});
