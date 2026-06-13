'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeMemoryReporter, makeConsoleReporter, setReporter, report } =
  require('../src/core/reporter.js');

test('reporter: console adapter scrive una riga JSON per record', () => {
  const r = makeConsoleReporter();
  const logs = [];
  const orig = { log: console.log, error: console.error };
  console.log = msg => logs.push(['log', msg]);
  console.error = msg => logs.push(['error', msg]);
  try {
    r.info('hello', { user: 'alice' });
    r.warn('quota low');
    r.error(new Error('boom'), { route: 'state-sync' });
  } finally {
    console.log = orig.log;
    console.error = orig.error;
  }
  assert.equal(logs.length, 3);
  assert.equal(logs[0][0], 'log',   'info → stdout');
  assert.equal(logs[1][0], 'error', 'warn → stderr');
  assert.equal(logs[2][0], 'error', 'error → stderr');

  // Verifica che la riga sia JSON parsabile con i campi attesi
  const infoLine = JSON.parse(logs[0][1]);
  assert.equal(infoLine.level, 'info');
  assert.equal(infoLine.message, 'hello');
  assert.equal(infoLine.ctx.user, 'alice');
  assert.ok(typeof infoLine.ts === 'number');

  const errLine = JSON.parse(logs[2][1]);
  assert.equal(errLine.message, 'boom');
  assert.equal(errLine.name, 'Error');
  assert.ok(errLine.stack && errLine.stack.includes('Error'));
  assert.equal(errLine.ctx.route, 'state-sync');
});

test('reporter: memory adapter raccoglie i record per i test', () => {
  const mem = makeMemoryReporter();
  mem.info('hello');
  mem.error(new Error('x'), { ctx: 1 });
  assert.equal(mem.records.length, 2);
  assert.equal(mem.records[0].level, 'info');
  assert.equal(mem.records[1].level, 'error');
  assert.equal(mem.records[1].message, 'x');
  mem.clear();
  assert.equal(mem.records.length, 0);
});

test('reporter: setReporter sostituisce il singleton globale', () => {
  const mem = makeMemoryReporter();
  setReporter(mem);
  try {
    report.error(new Error('captured'), { src: 'unit-test' });
    report.warn('warn-msg');
    assert.equal(mem.records.length, 2);
    assert.equal(mem.records[0].message, 'captured');
    assert.equal(mem.records[0].ctx.src, 'unit-test');
    assert.equal(mem.records[1].level, 'warn');
  } finally {
    setReporter(makeConsoleReporter()); // ripristina default per i prossimi test
  }
});

test('reporter: error accetta stringa o Error', () => {
  const mem = makeMemoryReporter();
  mem.error('plain string');
  mem.error(new Error('with stack'));
  assert.equal(mem.records[0].message, 'plain string');
  assert.equal(mem.records[0].stack, undefined);
  assert.equal(mem.records[1].message, 'with stack');
  assert.ok(mem.records[1].stack);
});

test('reporter: niente PII di default — chi chiama deve filtrare il payload', () => {
  // Smoke test: il reporter NON ispeziona/filtra/maschera il ctx.
  // L'utente del reporter è responsabile di non passare email/codici sync/note.
  const mem = makeMemoryReporter();
  mem.error('test', { syncCode: 'SHOULD-NOT-BE-HERE' });
  assert.equal(mem.records[0].ctx.syncCode, 'SHOULD-NOT-BE-HERE',
    'Il reporter è "trasparente": filtraggio è responsabilità del caller');
});
