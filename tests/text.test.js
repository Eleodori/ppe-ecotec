'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, csvCell, parseStateList } = require('../src/core/text.js');

test('escapeHtml: neutralizza payload XSS', () => {
  const out = escapeHtml('</textarea><img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
});

test('escapeHtml: virgolette e ampersand', () => {
  assert.equal(escapeHtml('a"b&c\'d'), 'a&quot;b&amp;c&#39;d');
});

test('csvCell: neutralizza formula injection', () => {
  assert.ok(csvCell('=SUM(A1:A9)').startsWith('"\''));
  assert.ok(csvCell('+1').startsWith('"\''));
  assert.ok(csvCell('@x').startsWith('"\''));
});

test('csvCell: cella normale e quote raddoppiate', () => {
  assert.equal(csvCell('Forlì'), '"Forlì"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell(null), '""');
});

test('parseStateList: estrae PV + attività, ignora righe senza match', () => {
  const txt = [
    '47574  S.P FRANCESCA 123  VERDELLINO  BG  LOMBARDIA  INSTALLAZIONE',
    '41839  S.S. 142 KM 6,625  VIGLIANO  BI  PIEMONTE  SOPRALLUOGO',
    '45242  S.S. 30  ALESSANDRIA  AL  PIEMONTE  SOPRALLUGO/RILIEVO CON RIFACIMENTO PLANIMETRIA',
    '47599  VIA LOMELLINA  VOGHERA  PV  LOMBARDIA  SOSPESA',
    'intestazione senza pv',
  ].join('\n');
  const r = parseStateList(txt);
  assert.equal(r.length, 4);
  assert.equal(r.find(x => x.pv === 47574).desired, 'inst-todo');
  assert.equal(r.find(x => x.pv === 41839).desired, 'sopr-todo');
  assert.equal(r.find(x => x.pv === 45242).desired, 'sopr-todo'); // "RILIEVO" → sopralluogo
  assert.equal(r.find(x => x.pv === 47599).desired, 'sospeso');
});
