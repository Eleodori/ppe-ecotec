// @ts-check
/**
 * Tagged template `html` con escaping automatico.
 *
 * Uso:
 *   element.innerHTML = html`<div>${userInput}</div>`;
 *
 * Le interpolazioni vengono passate per escapeHtml (da text.js) di default.
 * Per HTML grezzo intenzionale (es. una stringa già sicura, un'icona SVG
 * statica) usare `raw(stringa)`:
 *   element.innerHTML = html`<div>${raw(svgIcon)}</div>`;
 *
 * Array vengono concatenati (utile per generare liste).
 * null/undefined diventano stringa vuota.
 *
 * Vedi docs/architecture.md ADR-001 (perché niente JSX/framework: la
 * disciplina è "ogni interpolazione passa di qui").
 */
(function (global, factory) {
  // Cerca escapeHtml: definita da src/core/text.js, che dev'essere caricato prima.
  // @ts-ignore — escapeHtml è iniettato a runtime su globalThis da text.js (pattern UMD-lite)
  const escFn = global.escapeHtml ||
    (typeof require === 'function' ? require('./text.js').escapeHtml : null);
  if (!escFn) throw new Error('html.js richiede text.js (escapeHtml) caricato prima');
  const api = factory(escFn);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(global, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (escapeHtml) {
  'use strict';

  const RAW = Symbol('html.raw');

  /** Marca una stringa come HTML già sicuro (non verrà escapata). */
  function raw(s) {
    return { [RAW]: true, value: s == null ? '' : String(s) };
  }

  function interp(v) {
    if (v == null || v === false) return '';
    if (v && typeof v === 'object' && v[RAW]) return v.value;
    if (Array.isArray(v)) return v.map(interp).join('');
    return escapeHtml(v);
  }

  function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
      out += interp(values[i]) + strings[i + 1];
    }
    return out;
  }

  return { html, raw };
});
