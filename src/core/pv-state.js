// @ts-check
/**
 * Core PV state — funzioni pure sullo stato di un singolo PV.
 *
 * Tutte ricevono in input il "record master" del PV e (dove serve) l'entry
 * `userState` corrente: nessuna dipendenza globale, nessun DOM. Restituiscono
 * la NUOVA entry da scrivere in userState[pv] (immutabile, mai mutate l'input).
 *
 * Vedi docs/architecture.md ADR-004 per il razionale.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(global, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // === Lettura: effectiveFlags e statusOf ===

  /**
   * Calcola i flag effettivi di un PV combinando master (record dataset) e
   * user (entry userState[pv]). Gli override booleani in user.override vincono
   * sempre sul master; i timestamp utente integrano quelli master.
   *
   * @param {object} p       record master del PV
   * @param {object} [us]    entry userState[pv] (può essere null/undefined)
   * @returns {object}       { soprRichiesto, soprFatto, soprTs, instRichiesta, instRichTsUser, instFatta, instTs, sospeso, archivio }
   */
  function effectiveFlags(p, us) {
    us = us || {};
    const o = us.override || {};
    const soprFattoTs = p.sopralluogo_ts || us.sopralluogo_fatto_ts || null;
    const instFattaTs = p.installazione_ts || us.installazione_fatta_ts || null;
    const instRichTsUser = us.installazione_richiesta_ts || null;
    const ovr = (key, fallback) => (typeof o[key] === 'boolean' ? o[key] : fallback);
    return {
      soprRichiesto: ovr('soprRich', !!p.sopralluogo_richiesto),
      soprFatto: ovr('soprFatto', !!(soprFattoTs || p.sopralluogo_fatto)),
      soprTs: soprFattoTs,
      instRichiesta: ovr('instRich', !!(p.installazione_richiesta || instRichTsUser)),
      instRichTsUser,
      instFatta: ovr('instFatta', !!(instFattaTs || p.installazione_fatta)),
      instTs: instFattaTs,
      sospeso: ovr('sospeso', !!p.sospeso),
      archivio: ovr('archive', !!p.archivio_storico),
    };
  }

  /**
   * Stato derivato del PV, uno tra:
   *   'sospeso' | 'completato' | 'archive' | 'inst-todo' | 'attesa' | 'sopr-todo'
   *
   * NOTA: 'completato' ha precedenza su 'archive' — un PV archivio_storico=true
   * ma con installazione_fatta=true va mostrato come "Fatto", non nascosto.
   */
  function statusOf(p, us) {
    const e = effectiveFlags(p, us);
    if (e.sospeso)       return 'sospeso';
    if (e.instFatta)     return 'completato';
    if (e.archivio)      return 'archive';
    if (e.instRichiesta) return 'inst-todo';
    if (e.soprFatto)     return 'attesa';
    if (e.soprRichiesto) return 'sopr-todo';
    return 'inst-todo'; // fallback: il PV ha comunque un'attività implicita
  }

  // === Mutazioni: producono la NUOVA entry, immutabili ===

  // Override booleani applicati quando l'utente forza manualmente uno stato.
  // Forzare uno stato attivo rimuove anche il flag archive: un PV su cui si
  // sta lavorando non è "archivio storico".
  const STATE_OVERRIDES = {
    'sopr-todo':  { soprRich: true,  soprFatto: false, instRich: false, instFatta: false, sospeso: false, archive: false },
    'attesa':     { soprRich: false, soprFatto: true,  instRich: false, instFatta: false, sospeso: false, archive: false },
    'inst-todo':  { soprRich: false, soprFatto: true,  instRich: true,  instFatta: false, sospeso: false, archive: false },
    'completato': { soprRich: false, soprFatto: true,  instRich: true,  instFatta: true,  sospeso: false, archive: false },
    'sospeso':    { sospeso: true },
  };

  // Override "leggeri" per l'import da elenco testuale (PDF Serena): NON forza
  // soprFatto=true su inst-todo, così i conteggi dei sopralluoghi non si gonfiano
  // per PV andati diretti all'installazione.
  const IMPORT_OVERRIDES = {
    'sopr-todo': { soprRich: true, soprFatto: false, instRich: false, instFatta: false, sospeso: false, archive: false },
    'inst-todo': { soprRich: false, instRich: true, instFatta: false, sospeso: false, archive: false },
    'sospeso':   { sospeso: true },
  };

  /**
   * Produce la nuova entry userState[pv] per portare il PV allo stato target.
   * target ∈ {'sopr-todo','attesa','inst-todo','completato','sospeso','auto'}.
   * 'auto' = ripristina i dati master (rimuove override e timestamp utente).
   *
   * @param {object} cur   entry userState[pv] corrente (può essere null)
   * @param {string} target
   * @param {number} now   timestamp in ms (passato esplicitamente per testabilità)
   * @returns {object}     nuova entry
   */
  function nextStateOverride(cur, target, now) {
    cur = cur || {};
    const next = { ...cur, updatedAt: now };

    if (target === 'auto') {
      delete next.override;
      next.sopralluogo_fatto_ts = null;
      next.installazione_richiesta_ts = null;
      next.installazione_fatta_ts = null;
      return next;
    }

    const ovr = STATE_OVERRIDES[target];
    if (!ovr) throw new Error('stato non valido: ' + target);
    next.override = { ...ovr };

    // Allinea i timestamp utente allo stato target (così la timeline è coerente).
    if (target === 'sopr-todo') {
      next.sopralluogo_fatto_ts = null;
      next.installazione_richiesta_ts = null;
      next.installazione_fatta_ts = null;
    } else if (target === 'attesa') {
      next.sopralluogo_fatto_ts = cur.sopralluogo_fatto_ts || now;
      next.installazione_richiesta_ts = null;
      next.installazione_fatta_ts = null;
    } else if (target === 'inst-todo') {
      next.sopralluogo_fatto_ts = cur.sopralluogo_fatto_ts || now;
      next.installazione_richiesta_ts = cur.installazione_richiesta_ts || now;
      next.installazione_fatta_ts = null;
    } else if (target === 'completato') {
      next.sopralluogo_fatto_ts = cur.sopralluogo_fatto_ts || now;
      next.installazione_richiesta_ts = cur.installazione_richiesta_ts || now;
      next.installazione_fatta_ts = cur.installazione_fatta_ts || now;
    }
    // 'sospeso' preserva i timestamp esistenti.
    return next;
  }

  /**
   * Variante "import": override leggeri, NO bump dei timestamp se non necessari.
   * Usata da "Aggiorna stati da elenco" (PDF Serena).
   */
  function nextImportOverride(cur, target, now) {
    cur = cur || {};
    const next = { ...cur, updatedAt: now };
    const ovr = IMPORT_OVERRIDES[target];
    if (!ovr) throw new Error('stato non valido per import: ' + target);
    next.override = { ...ovr };
    if (target === 'sopr-todo') {
      next.sopralluogo_fatto_ts = null;
      next.installazione_richiesta_ts = null;
      next.installazione_fatta_ts = null;
    } else if (target === 'inst-todo') {
      next.installazione_fatta_ts = null;
    }
    return next;
  }

  // === Scadenza planimetria ===
  //
  // La planimetria di un PV installato va rifatta periodicamente (default 24 mesi,
  // editabile globalmente e per-PV). Logica pura: input = userState entry +
  // intervallo globale + now. Output = status discreto + giorni a scadenza.
  //
  // Lo stato 'missing' significa "non monitorabile" (manca la data dell'ultima
  // planimetria). 'ok' = scade tra >30 giorni. 'expiring' = scade entro 30
  // giorni. 'expired' = già scaduta.

  const DEFAULT_PLANIMETRIA_INTERVAL_MONTHS = 24;
  const PLANIMETRIA_EXPIRING_DAYS = 30;

  /**
   * @param {object} [us]   entry userState[pv]
   * @param {number} [globalIntervalMonths]   default 24
   * @param {number} [now]  ms (passato esplicitamente per testabilità)
   * @returns {{
   *   status: 'missing'|'ok'|'expiring'|'expired',
   *   lastDate: string|null,
   *   expiryDate: string|null,
   *   daysToExpiry: number|null,
   *   intervalMonths: number,
   *   inferredFromInstall?: boolean
   * }}
   */
  function planimetriaStatus(us, globalIntervalMonths, now) {
    const interval = Number(globalIntervalMonths) > 0
      ? Number(globalIntervalMonths)
      : DEFAULT_PLANIMETRIA_INTERVAL_MONTHS;
    const plan = (us && us.planimetria) || null;
    const override = plan && Number(plan.intervalMonthsOverride) > 0
      ? Number(plan.intervalMonthsOverride)
      : null;
    const effectiveMonths = override || interval;

    // Fallback intelligente: se l'utente non ha inserito una data esplicita ma
    // l'installazione è stata fatta, la planimetria è coeva all'installazione.
    // Evita di chiedere all'utente di re-inserire una data che il sistema già
    // possiede. Override manuale (dateMostra utente) vince comunque.
    let lastDateRaw = plan && plan.lastDate ? String(plan.lastDate) : null;
    let inferredFromInstall = false;
    if (!lastDateRaw && us && us.installazione_fatta_ts) {
      const d = new Date(us.installazione_fatta_ts);
      if (!isNaN(d.getTime())) {
        lastDateRaw = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        inferredFromInstall = true;
      }
    }
    const m = lastDateRaw && /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastDateRaw);
    if (!m) {
      return {
        status: 'missing',
        lastDate: lastDateRaw || null,
        expiryDate: null,
        daysToExpiry: null,
        intervalMonths: effectiveMonths,
        inferredFromInstall: false,
      };
    }
    // Mezzogiorno locale: evita salti TZ ai bordi del giorno.
    const last = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
    const expiry = new Date(last);
    expiry.setMonth(expiry.getMonth() + effectiveMonths);
    const expiryIso = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}`;
    const today = new Date(typeof now === 'number' ? now : Date.now());
    today.setHours(0, 0, 0, 0);
    const exDay = new Date(expiry); exDay.setHours(0, 0, 0, 0);
    const days = Math.round((exDay.getTime() - today.getTime()) / 86400000);
    const status = days < 0
      ? /** @type {'expired'} */ ('expired')
      : days <= PLANIMETRIA_EXPIRING_DAYS
        ? /** @type {'expiring'} */ ('expiring')
        : /** @type {'ok'} */ ('ok');
    return {
      status,
      lastDate: lastDateRaw,
      expiryDate: expiryIso,
      daysToExpiry: days,
      intervalMonths: effectiveMonths,
      inferredFromInstall,
    };
  }

  /**
   * Setta/aggiorna la data dell'ultima planimetria. Producer puro per
   * updatePvEntry: (cur, now) → next.
   *
   * @param {string|null} dateStr 'YYYY-MM-DD' oppure null per pulire
   */
  function setPlanimetriaDate(dateStr) {
    return function (cur, now) {
      cur = cur || {};
      const next = { ...cur, updatedAt: now };
      const prev = next.planimetria || {};
      if (dateStr) next.planimetria = { ...prev, lastDate: dateStr };
      else if (prev.intervalMonthsOverride) next.planimetria = { intervalMonthsOverride: prev.intervalMonthsOverride };
      else delete next.planimetria;
      return next;
    };
  }

  /**
   * Setta/azzera l'override di cadenza per-PV (in mesi). null = usa globale.
   */
  function setPlanimetriaOverride(monthsOrNull) {
    return function (cur, now) {
      cur = cur || {};
      const next = { ...cur, updatedAt: now };
      const prev = next.planimetria || {};
      const months = Number(monthsOrNull) > 0 ? Number(monthsOrNull) : null;
      if (months) next.planimetria = { ...prev, intervalMonthsOverride: months };
      else if (prev.lastDate) next.planimetria = { lastDate: prev.lastDate };
      else delete next.planimetria;
      return next;
    };
  }

  /**
   * Confronta una lista di {pv, desired} (output di parseStateList) con lo
   * stato attuale dei PV nel master. Regole di buon senso:
   *  - PV non esistenti → notFound
   *  - PV già nello stato target → same
   *  - PV già 'completato' → MAI sovrascritti (anomalies)
   *  - PV in 'attesa' con desired='sopr-todo' → già allineati (il sopr è fatto)
   *  - altrimenti → changes
   *
   * @param {Array<{pv:number,desired:string}>} items
   * @param {(pv:number) => object|null} getPvMaster   accessor al record master
   * @param {(pv:number) => object|null} [getUserEntry] opzionale, per statusOf con override
   */
  function computeStateDiff(items, getPvMaster, getUserEntry) {
    const changes = [], notFound = [], same = [], anomalies = [];
    const seen = new Set();
    for (const { pv, desired } of items) {
      if (seen.has(pv)) continue;
      seen.add(pv);
      const p = getPvMaster(pv);
      if (!p) { notFound.push(pv); continue; }
      const us = getUserEntry ? getUserEntry(pv) : null;
      const cur = statusOf(p, us);
      if (cur === desired) { same.push(pv); continue; }
      if (cur === 'completato') { anomalies.push({ pv, cur, desired }); continue; }
      if (desired === 'sopr-todo' && cur === 'attesa') { same.push(pv); continue; }
      changes.push({ pv, cur, desired });
    }
    return { changes, notFound, same, anomalies };
  }

  return {
    effectiveFlags,
    statusOf,
    STATE_OVERRIDES,
    IMPORT_OVERRIDES,
    nextStateOverride,
    nextImportOverride,
    computeStateDiff,
    planimetriaStatus,
    setPlanimetriaDate,
    setPlanimetriaOverride,
    DEFAULT_PLANIMETRIA_INTERVAL_MONTHS,
    PLANIMETRIA_EXPIRING_DAYS,
  };
});
