'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  effectiveFlags, statusOf,
  nextStateOverride, nextImportOverride, computeStateDiff,
  planimetriaStatus, setPlanimetriaDate, setPlanimetriaOverride,
} = require('../src/core/pv-state.js');

const NOW = 1_700_000_000_000;

// === statusOf: coperti tutti gli stati ===

test('statusOf: sopr-todo (master richiede sopralluogo, niente altro)', () => {
  assert.equal(statusOf({ sopralluogo_richiesto: true }), 'sopr-todo');
});

test('statusOf: attesa (sopralluogo fatto, installazione non ancora richiesta)', () => {
  assert.equal(statusOf({ sopralluogo_fatto: true }), 'attesa');
});

test('statusOf: inst-todo (installazione richiesta dal master)', () => {
  assert.equal(statusOf({ installazione_richiesta: true }), 'inst-todo');
});

test('statusOf: completato vince su archive (regola del prodotto)', () => {
  // Bug noto pre-Fase1: i PV archivio_storico + installazione_fatta venivano
  // nascosti come "archive". L'utente li vuole vedere come "Fatti".
  const p = { archivio_storico: true, installazione_fatta: true };
  assert.equal(statusOf(p), 'completato');
});

test('statusOf: sospeso vince sempre', () => {
  const p = { sospeso: true, installazione_fatta: true };
  assert.equal(statusOf(p), 'sospeso');
});

test('statusOf: override booleano vince sul master', () => {
  // Master dice "inst-todo", userState forza "sopr-todo"
  const p = { installazione_richiesta: true };
  const us = { override: { soprRich: true, instRich: false } };
  assert.equal(statusOf(p, us), 'sopr-todo');
});

// === effectiveFlags: integrazione master/user ===

test('effectiveFlags: timestamp utente integra quello master', () => {
  const p = { sopralluogo_richiesto: true };
  const us = { sopralluogo_fatto_ts: 12345 };
  const e = effectiveFlags(p, us);
  assert.equal(e.soprFatto, true);
  assert.equal(e.soprTs, 12345);
});

// === nextStateOverride: tutte le transizioni ===

test('nextStateOverride → sopr-todo: pulisce tutti i timestamp utente', () => {
  const cur = { sopralluogo_fatto_ts: 100, installazione_fatta_ts: 200 };
  const next = nextStateOverride(cur, 'sopr-todo', NOW);
  assert.equal(next.updatedAt, NOW);
  assert.equal(next.sopralluogo_fatto_ts, null);
  assert.equal(next.installazione_fatta_ts, null);
  assert.equal(next.override.soprRich, true);
  assert.equal(next.override.archive, false, "uscire dall'archivio");
});

test('nextStateOverride → attesa: setta sopr_ts a now se mancante, preserva se presente', () => {
  // mancante → now
  let next = nextStateOverride({}, 'attesa', NOW);
  assert.equal(next.sopralluogo_fatto_ts, NOW);
  // presente → preserva
  next = nextStateOverride({ sopralluogo_fatto_ts: 100 }, 'attesa', NOW);
  assert.equal(next.sopralluogo_fatto_ts, 100);
});

test('nextStateOverride → completato: setta tutti i timestamp', () => {
  const next = nextStateOverride({}, 'completato', NOW);
  assert.equal(next.sopralluogo_fatto_ts, NOW);
  assert.equal(next.installazione_richiesta_ts, NOW);
  assert.equal(next.installazione_fatta_ts, NOW);
  assert.equal(next.override.instFatta, true);
});

test('nextStateOverride → auto: rimuove override e timestamp utente', () => {
  const cur = {
    override: { soprRich: true },
    sopralluogo_fatto_ts: 100,
    installazione_fatta_ts: 200,
    installazione_richiesta_ts: 150,
  };
  const next = nextStateOverride(cur, 'auto', NOW);
  assert.equal(next.override, undefined);
  assert.equal(next.sopralluogo_fatto_ts, null);
  assert.equal(next.installazione_richiesta_ts, null);
  assert.equal(next.installazione_fatta_ts, null);
});

test('nextStateOverride: NON muta l\'input', () => {
  const cur = { sopralluogo_fatto_ts: 100, override: { soprRich: true } };
  const frozen = JSON.parse(JSON.stringify(cur));
  nextStateOverride(cur, 'completato', NOW);
  assert.deepEqual(cur, frozen, 'l\'entry originale non deve cambiare');
});

test('nextStateOverride: target invalido lancia errore (no silent fail)', () => {
  assert.throws(() => nextStateOverride({}, 'nonsense', NOW));
});

// === nextImportOverride: non gonfia i timestamp ===

test('nextImportOverride → inst-todo NON bumpa sopralluogo (regola product)', () => {
  // Differenza chiave rispetto a setPvState: l'import da PDF NON deve forzare
  // soprFatto=true per i PV che vanno diretti all'installazione.
  const next = nextImportOverride({}, 'inst-todo', NOW);
  assert.equal(next.override.soprFatto, undefined);
  assert.equal(next.override.instRich, true);
  assert.equal(next.sopralluogo_fatto_ts, undefined);
});

// === computeStateDiff ===

const makeMaster = (overrides = {}) => pv => overrides[pv] || null;

test('computeStateDiff: classifica correttamente', () => {
  const master = makeMaster({
    100: { installazione_richiesta: true },          // inst-todo
    200: { sopralluogo_fatto: true },                // attesa
    300: { installazione_fatta: true },              // completato (intoccabile)
    400: { sopralluogo_richiesto: true },            // sopr-todo
  });
  const items = [
    { pv: 100, desired: 'inst-todo' }, // already same
    { pv: 200, desired: 'sopr-todo' }, // attesa+sopr-todo = già a posto
    { pv: 300, desired: 'sopr-todo' }, // completato → anomaly
    { pv: 400, desired: 'inst-todo' }, // change reale
    { pv: 999, desired: 'inst-todo' }, // notFound
    { pv: 100, desired: 'sopr-todo' }, // duplicato (skippato)
  ];
  const diff = computeStateDiff(items, master);
  assert.deepEqual(diff.changes.map(c => c.pv), [400]);
  assert.deepEqual(diff.anomalies.map(c => c.pv), [300]);
  assert.deepEqual(diff.notFound, [999]);
  assert.deepEqual(diff.same.sort(), [100, 200]);
});

// === planimetriaStatus / setPlanimetriaDate / setPlanimetriaOverride ===

// Helper: timestamp a metà di un giorno specifico (TZ locale), evita salti DST.
const dayMs = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();

test('planimetriaStatus: senza data → missing', () => {
  const s = planimetriaStatus({}, 24, NOW);
  assert.equal(s.status, 'missing');
  assert.equal(s.lastDate, null);
  assert.equal(s.expiryDate, null);
  assert.equal(s.intervalMonths, 24, 'usa il globale anche senza data');
});

test('planimetriaStatus: data 1 anno fa, intervallo 24m → ok (~365gg)', () => {
  // Reference: oggi = 15 giugno 2025. lastDate = 15 giugno 2024 → expiry 15 giu 2026 → 365gg.
  const now = dayMs(2025, 6, 15);
  const us = { planimetria: { lastDate: '2024-06-15' } };
  const s = planimetriaStatus(us, 24, now);
  assert.equal(s.status, 'ok');
  assert.equal(s.expiryDate, '2026-06-15');
  assert.ok(s.daysToExpiry > 30 && s.daysToExpiry < 380, `daysToExpiry=${s.daysToExpiry}`);
});

test('planimetriaStatus: a 20 giorni dalla scadenza → expiring', () => {
  // 15 giu 2025 = oggi, intervallo 24m → lastDate = 26 giu 2023 → expiry 26 giu 2025 → 11gg.
  const now = dayMs(2025, 6, 15);
  const us = { planimetria: { lastDate: '2023-06-26' } };
  const s = planimetriaStatus(us, 24, now);
  assert.equal(s.status, 'expiring');
  assert.equal(s.daysToExpiry, 11);
});

test('planimetriaStatus: oltre la scadenza → expired (giorni < 0)', () => {
  const now = dayMs(2025, 6, 15);
  const us = { planimetria: { lastDate: '2023-01-01' } }; // expiry 2025-01-01
  const s = planimetriaStatus(us, 24, now);
  assert.equal(s.status, 'expired');
  assert.ok(s.daysToExpiry < 0, `daysToExpiry deve essere negativo, è ${s.daysToExpiry}`);
});

test('planimetriaStatus: override per-PV vince sul globale', () => {
  // Globale 24m → sarebbe expired. Override 36m → ok (mancano ~12 mesi).
  const now = dayMs(2025, 6, 15);
  const us = { planimetria: { lastDate: '2023-06-01', intervalMonthsOverride: 36 } };
  const s = planimetriaStatus(us, 24, now);
  assert.equal(s.status, 'ok');
  assert.equal(s.intervalMonths, 36);
  assert.equal(s.expiryDate, '2026-06-01');
});

test('planimetriaStatus: lastDate malformata → missing (graceful)', () => {
  const s = planimetriaStatus({ planimetria: { lastDate: '15/06/2024' } }, 24, NOW);
  assert.equal(s.status, 'missing', 'formato non ISO non rompe il render');
});

test('planimetriaStatus: globalIntervalMonths invalido → fallback 24', () => {
  const s = planimetriaStatus({}, 0, NOW);
  assert.equal(s.intervalMonths, 24);
});

test('setPlanimetriaDate: producer puro setta lastDate e bumpa updatedAt', () => {
  const next = setPlanimetriaDate('2026-01-15')({}, NOW);
  assert.equal(next.planimetria.lastDate, '2026-01-15');
  assert.equal(next.updatedAt, NOW);
});

test('setPlanimetriaDate(null) rimuove la data ma preserva override', () => {
  const cur = { planimetria: { lastDate: '2024-01-01', intervalMonthsOverride: 36 } };
  const next = setPlanimetriaDate(null)(cur, NOW);
  assert.equal(next.planimetria.lastDate, undefined);
  assert.equal(next.planimetria.intervalMonthsOverride, 36);
});

test('setPlanimetriaDate(null) rimuove planimetria se vuota', () => {
  const cur = { planimetria: { lastDate: '2024-01-01' } };
  const next = setPlanimetriaDate(null)(cur, NOW);
  assert.equal(next.planimetria, undefined);
});

test('setPlanimetriaOverride: setta override, mantiene lastDate', () => {
  const cur = { planimetria: { lastDate: '2024-01-01' } };
  const next = setPlanimetriaOverride(36)(cur, NOW);
  assert.equal(next.planimetria.lastDate, '2024-01-01');
  assert.equal(next.planimetria.intervalMonthsOverride, 36);
});

test('setPlanimetriaOverride(null) rimuove override ma preserva lastDate', () => {
  const cur = { planimetria: { lastDate: '2024-01-01', intervalMonthsOverride: 36 } };
  const next = setPlanimetriaOverride(null)(cur, NOW);
  assert.equal(next.planimetria.lastDate, '2024-01-01');
  assert.equal(next.planimetria.intervalMonthsOverride, undefined);
});

test('setPlanimetriaDate: NON muta l\'input', () => {
  const cur = { planimetria: { lastDate: '2024-01-01' } };
  const frozen = JSON.parse(JSON.stringify(cur));
  setPlanimetriaDate('2026-01-15')(cur, NOW);
  assert.deepEqual(cur, frozen);
});

test('computeStateDiff: rispetta override utente', () => {
  // master dice inst-todo, ma user ha forzato sopr-todo → desired sopr-todo è già allineato
  const master = makeMaster({ 100: { installazione_richiesta: true } });
  const user = pv => pv === 100 ? { override: { soprRich: true, instRich: false } } : null;
  const diff = computeStateDiff([{ pv: 100, desired: 'sopr-todo' }], master, user);
  assert.deepEqual(diff.same, [100]);
  assert.deepEqual(diff.changes, []);
});
