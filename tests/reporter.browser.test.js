'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

/**
 * Test del reporter caricato come <script> in un sandbox VM (simula browser).
 * Verifichiamo che il modulo si autoregistri su globalThis (pattern UMD-lite).
 */

function loadInSandbox() {
  const code = fs.readFileSync('src/core/reporter.js', 'utf8');
  // Sandbox minimo: niente module/require → il modulo prende il path browser
  const sandbox = {
    globalThis: undefined,  // verrà settato da Object.assign
    console: {
      _calls: [],
      log(msg) { this._calls.push(['log', msg]); },
      error(msg) { this._calls.push(['error', msg]); },
    },
    Date: Date,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

test('browser: il modulo espone le API su globalThis', () => {
  const sb = loadInSandbox();
  assert.equal(typeof sb.makeConsoleReporter, 'function');
  assert.equal(typeof sb.makeMemoryReporter, 'function');
  assert.equal(typeof sb.setReporter, 'function');
  assert.equal(typeof sb.report, 'object');
  assert.equal(typeof sb.report.error, 'function');
});

test('browser: report.error → console.error JSON in stessa istanza', () => {
  const sb = loadInSandbox();
  sb.report.error(new Error('client-boom'), { component: 'photo' });
  const errs = sb.console._calls.filter(c => c[0] === 'error');
  assert.equal(errs.length, 1);
  const line = JSON.parse(errs[0][1]);
  assert.equal(line.level, 'error');
  assert.equal(line.message, 'client-boom');
  assert.equal(line.ctx.component, 'photo');
});

test('browser: setReporter funziona anche fuori da Node module system', () => {
  const sb = loadInSandbox();
  const mem = sb.makeMemoryReporter();
  sb.setReporter(mem);
  sb.report.warn('client-warn');
  assert.equal(mem.records.length, 1);
  assert.equal(mem.records[0].level, 'warn');
});
