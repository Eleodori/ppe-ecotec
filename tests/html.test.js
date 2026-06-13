'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { html, raw } = require('../src/core/html.js');

test('html: escape automatico delle interpolazioni', () => {
  const xss = '</textarea><img src=x onerror=alert(1)>';
  const out = html`<div>${xss}</div>`;
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
});

test('html: raw() consente HTML grezzo intenzionale', () => {
  const out = html`<div>${raw('<b>ok</b>')}</div>`;
  assert.equal(out, '<div><b>ok</b></div>');
});

test('html: array concatenati', () => {
  const items = ['a', '<b>', 'c'];
  const out = html`<ul>${items.map(i => html`<li>${i}</li>`)}</ul>`;
  // Le stringhe interne (già passate da html) sono già escape-safe per il template
  // esterno (sono "raw" semanticamente). Ma per ora le passiamo come stringhe:
  // perciò il < di "<b>" viene escapato due volte? NO: la stringa "<li>&lt;b&gt;</li>"
  // arriva al template esterno come valore, viene escapata di nuovo → doppio escape.
  // Comportamento atteso e intenzionale: per riusare html() annidato basta raw().
  // Verifichiamo solo che non escapi MAI un payload XSS in modo da farlo eseguire.
  assert.ok(!out.includes('<b>'));
});

test('html: array di html() annidato con raw() compone in sicurezza', () => {
  const items = ['a', '<b>', 'c'];
  const lis = items.map(i => raw(html`<li>${i}</li>`));
  const out = html`<ul>${lis}</ul>`;
  assert.equal(out, '<ul><li>a</li><li>&lt;b&gt;</li><li>c</li></ul>');
});

test('html: null/undefined/false diventano stringa vuota', () => {
  assert.equal(html`<x>${null}${undefined}${false}</x>`, '<x></x>');
});

test('html: numero interpolato come stringa', () => {
  assert.equal(html`<x>${42}</x>`, '<x>42</x>');
});
