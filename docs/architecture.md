# Architecture Decision Records

Decisioni di design "irreversibili" o ad alto impatto, motivate. Aggiungere una
nuova ADR quando si prende una scelta che condizionerà chi scrive codice dopo.
Format: numero progressivo, titolo, **stato** (proposed/accepted/superseded),
**contesto**, **decisione**, **conseguenze**.

---

## ADR-001 — Niente framework, ES Modules nativi, no build step

**Stato:** accepted (2026-06)

**Contesto.** L'app sta crescendo da strumento personale a prodotto B2B
(vetrina per Ecotec/IP). Dovrà essere mantenuta nel tempo, potenzialmente
da un team diverso. Una migrazione futura a infrastruttura AWS è possibile.

**Decisione.**
- Vanilla JavaScript con ES Modules nativi e pattern UMD-lite (i moduli `src/core/*`
  funzionano identici in browser, test Node, Netlify Functions ESM).
- Nessun bundler/build (Vite, Webpack, ecc.).
- JSDoc + `// @ts-check` per il type-safety progressivo, niente TypeScript "vero".
- Leaflet via CDN con SRI: unica dipendenza esterna lato client.

**Conseguenze.**
- ✓ Deploy = caricare i file su Netlify. Nessuna toolchain da maintenere.
- ✓ Chiunque conosca JS può fare manutenzione, senza essere "uno di React/Vue".
- ✓ Bundle minuscolo (~200KB), no runtime di framework.
- ✗ Niente JSX/SFC: il markup vive in stringhe template literal. La disciplina
  è: sempre `escapeHtml()` sulle interpolazioni di dati utente/master.
- ✗ Niente reattività automatica: ogni mutazione di stato chiama esplicitamente
  i render. Mitigato dall'helper `updatePvEntry` (ADR-002).

Quando rivedere: se la complessità del DOM cresce al punto da rendere
ingestibile il rendering manuale, considerare Lit/Petite-Vue (entrambi senza
build step).

---

## ADR-002 — Logica pura in `src/core/`, condivisa client/server

**Stato:** accepted (2026-06)

**Contesto.** Avevamo `mergeStates` duplicato in due posti (browser e Netlify
Function): cambiare l'algoritmo in uno solo significava divergenza silenziosa.
La logica del merge è anche dove un bug costa di più (perdita dati).

**Decisione.**
- Tutta la logica **pura** (zero DOM, zero `STATE` globale, zero rete) vive in
  `src/core/`: `geo.js`, `routing.js`, `sync-merge.js`, `text.js`, `pv-state.js`.
- Pattern UMD-lite: i file definiscono le funzioni su `globalThis` nel browser,
  esportano via CommonJS sotto Node, vengono importati come default ESM dalle
  Functions. Stesso file, tre forme.
- Ogni modulo `core/X.js` ha un `tests/X.test.js` con `node:test`.

**Conseguenze.**
- ✓ Niente duplicazione → impossibile che client e server divergano.
- ✓ Test in CI senza dover bootare un browser.
- ✓ Refactoring sicuro: il diff sul core è coperto da test.
- ✗ Il pattern UMD-lite è meno "moderno" dei moduli ESM puri, ma ci risparmia
  un build step (vedi ADR-001).

---

## ADR-003 — Storage: Netlify Blobs ora, DAL pronto per AWS

**Stato:** accepted (2026-06)

**Contesto.** Il sync e le foto vivono su Netlify Blobs, sufficiente per il
single-user attuale. Una migrazione futura ad AWS (DynamoDB o RDS) è ipotesi
concreta se IP acquisisce il prodotto.

**Decisione.**
- Per ora Netlify Blobs resta lo storage.
- Aggiungeremo un **Data Access Layer** (`src/server/dao/`) astratto in Fase 3,
  così cambiare storage richiede di sostituire un solo modulo.
- Schema-on-write: il client invia oggetti, il server li valida con Zod prima
  di scrivere (Fase 3).

**Conseguenze.**
- ✓ Nessun lock-in su Netlify.
- ✓ Migrazione AWS = nuovo backend del DAO, zero modifiche al client.
- ✗ Un livello in più rispetto a chiamare direttamente `getStore()`.

---

## ADR-004 — Mutazioni di `userState` solo via helper, mai inline

**Stato:** accepted (2026-06)

**Contesto.** Avevamo 8+ punti che riassegnavano `STATE.userState[pv]` a mano.
Il bug C2 (nota di campo che perdeva il merge) esisteva perché in uno di quei
punti `updatedAt` non veniva bumpato. Era una bomba a tempo: ogni nuovo punto
di mutazione poteva ripetere lo stesso errore.

**Decisione.**
- Tutte le mutazioni di `STATE.userState[pv]` passano da un helper unico
  (`updatePvEntry` in `index.html`, prossimamente in `src/state/`).
- L'helper garantisce: bump `updatedAt`, clone immutabile dell'entry, chiamata
  a `saveUserState()` per persistenza + sync, e ritorno della nuova entry.
- Le funzioni "pure" che calcolano la nuova entry (es. `nextStateOverride`,
  `nextWithPhotoAdded`) vivono in `src/core/pv-state.js` e sono testate.

**Conseguenze.**
- ✓ Impossibile dimenticare `updatedAt` o `saveUserState`.
- ✓ La logica "che entry produce questa azione" è testabile in isolamento.
- ✓ Audit di sicurezza/correttezza più semplice: una sola superficie da rivedere.

---

## ADR-005 — UI re-renders via `rerender(scope)`, mai a colpi di chiamate manuali

**Stato:** proposed (2026-06)

**Contesto.** Oggi ogni call-site sceglie a mano quale combinazione di
`refreshAllMarkers / renderCounters / renderRegionStats / renderList /
renderDetail / renderPlanUI / renderDrawings` chiamare. È fragile (`importJson`
saltava metà dei render). La modularizzazione UI ha bisogno di una pipeline
chiara.

**Decisione (da implementare in Fase 2.4).**
- Helper unico `rerender(scope)` con `scope` ∈ {'all','list','detail','plan',
  'dashboard','markers','counters'}. Ogni scope sa quali render scatenare.
- Le funzioni di mutazione chiamano `rerender('all')` di default;
  micro-ottimizzazioni con scope specifico solo dove provato dal profiler.

**Conseguenze.**
- ✓ Aggiungere un nuovo render = aggiornare un solo posto.
- ✓ Impossibile dimenticare di rinfrescare un pezzo (M3 sparirebbe).
- ✗ Qualche micro-ottimizzazione persa (alcune azioni rinfrescavano meno cose).
  Trascurabile rispetto al volume di lavoro UI attuale.

---

## ADR-006 — Scadenze planimetrie: feature "v2" inclusa con riserva

**Stato:** accepted (2026-06)

**Contesto.** Il progetto nasce come tool *single-shot* per una commessa
specifica (PEE — Ecotec/Marit/Iplanet): tracciare on-the-road i ~3000 PV
una volta sola fino al loro completamento, poi archiviare. Niente uso
continuativo previsto.

Durante la preparazione della demo IP è stata aggiunta una feature di
promemoria su scadenze biennali delle planimetrie (Fase A — commit `f50dd25`):
data dell'ultima planimetria editabile per-PV, cadenza globale + override,
dashboard "Planimetrie in scadenza". Questa feature presuppone uso
**continuativo** del software anni dopo la fine della commessa.

**Tensione architetturale.** Un nuovo dev che entra nel codice si chiede
"questo è un tool di campagna installazioni o un CRM di manutenzione?".
Le due cose vivono bene insieme solo se decidiamo esplicitamente cosa
vogliamo essere.

**Decisione.**
1. La feature resta nel codice. Motivazione commerciale: serve come
   "amo" per la demo IP (mostra che il prodotto può estendere il ciclo
   di vita oltre la singola commessa).
2. La data ultima planimetria è **inferita** da `installazione_fatta_ts`
   se non specificata (`planimetriaStatus.inferredFromInstall === true`).
   L'utente NON deve inserire a mano una data che il sistema già conosce
   — l'override esiste solo per casi anomali (planimetria rifatta dopo
   l'installazione iniziale).
3. Se la commessa IP **non** si concretizza in un prodotto manutentivo
   continuativo, candidare la feature alla rimozione. Punti di rimozione:
   - `src/core/pv-state.js`: `planimetriaStatus`, `setPlanimetriaDate`,
     `setPlanimetriaOverride` + costanti
   - `index.html`: blocco "Planimetria" in `renderDetail`, sezione
     `renderPlanimDashboard`, `STATE.planimetriaIntervalMonths`
   - I test relativi in `tests/pv-state.test.js`
   - La sezione HTML del dashboard
   - Storage utente: il campo `userState[pv].planimetria` resta dormiente
     senza danni (LWW gestisce, niente migrazione richiesta).

**Conseguenze.**
- ✓ Demo IP racconta un prodotto "che ricorda da solo" — credibile come
  v2.
- ✓ Auto-inferenza = zero attrito per l'utente single-shot: se non vuole
  pensarci, non deve.
- ✗ Il codice contiene un pezzo che potrebbe non servire mai a Marit.
  L'ADR è il modo per non dimenticarsene.
- ✗ Lo `userState` schema cresce di un campo opzionale (`planimetria`):
  l'ingombro è trascurabile (~30 byte/PV se settato).
