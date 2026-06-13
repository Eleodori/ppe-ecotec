# PEE Field

Webapp mobile-first per il tracciamento on-the-road dei PV Iplanet (progetto PEE — Ecotec/Marit). Single-page app vanilla JS deployata su Netlify, con sync multi-dispositivo via Netlify Blobs.

## Stack & filosofia

- **Vanilla JS + ES Modules**, nessun framework, nessun bundler/build step.
- **Logica pura** estratta in `src/core/*.js` (UMD-lite: stesso file girato da browser, test Node, Netlify Functions ESM). Niente duplicazione client/server.
- **JSDoc + `@ts-check`** sui moduli core per type-safety senza compilazione.
- **`node:test`** built-in per i test unitari (zero dipendenze).
- **Leaflet** via CDN con SRI, unica dipendenza esterna lato client.

Le scelte sono documentate in `docs/architecture.md` (ADR-001…005). Leggi quello prima di toccare l'architettura.

## Layout del repo

```
index.html                   monolite UI + glue verso i core (~4400 righe)
pv_data.json                 dataset PV master
src/core/                    logica pura, testata, condivisa client/server
  geo.js                       haversine, point-in-polygon
  routing.js                   DBSCAN, greedyTSP, twoOpt
  sync-merge.js                merge LWW + union foto/tombstone (CONDIVISO col server)
  text.js                      escapeHtml, csvCell, parseStateList
  html.js                      tagged template con escape automatico
  pv-state.js                  effectiveFlags, statusOf, transizioni di stato
tests/                       node:test su tutti i moduli core
netlify/functions/
  distance-matrix.mjs          proxy OpenRouteService + cache Blobs
  state-sync.mjs               sync userState multi-dispositivo + snapshot + push broadcast
  photo-sync.mjs               storage foto compresse client-side
  push-subscribe.mjs           subscription Web Push per device (registra/revoca)
  health.mjs                   shallow/deep/metrics
src/server/push/             logica broadcast + sender web-push (testati)
sw.js                          service worker: gestisce push e click → seleziona PV
docs/architecture.md         ADR (Architecture Decision Records)
netlify.toml                 cache headers, redirect
.github/workflows/test.yml   CI: test + lint + typecheck
```

## Setup locale

Niente toolchain obbligatoria per far girare l'app: aprire `index.html` da Netlify dev funziona.

Per i test/lint:
```bash
npm install            # solo per eslint + typescript (dev-only)
npm test               # 45+ test unitari (~250ms)
npm run lint           # ESLint sui moduli core e test
npm run typecheck      # TypeScript JSDoc check
```

## Deploy

Push su `main` → Netlify builda e deploya automaticamente. Le funzioni in `netlify/functions/` finiscono su AWS Lambda gestito da Netlify.

**Environment variables** richieste su Netlify:
- `ORS_API_KEY` — chiave OpenRouteService (per la matrice distanze stradali, free tier sufficiente)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — per le push notifications (vedi `docs/operations.md`). Senza queste, il toggle "Notifiche push" è nascosto e tutto il resto continua a funzionare.

Lo storage utente (sync code) usa `@netlify/blobs`: non serve configurazione, viene allocato automaticamente.

## Note critiche per chi modifica

- **Tutte le mutazioni di `STATE.userState[pv]`** passano da `updatePvEntry(pvId, producer)`. Mai assegnare a mano: il bug C2 nasceva esattamente da questo (ADR-004).
- **Tutto l'HTML interpolato con dati utente/master** passa dal tagged template `html\`\`` (escape automatico). Per SVG/HTML statici intenzionali: `raw(stringa)`.
- **Il merge dello state** (`mergeStates` in `src/core/sync-merge.js`) è codice **condiviso** con la Netlify Function `state-sync.mjs`. Modificarlo significa modificarlo per entrambi: c'è un solo file.
- **Re-render UI** via `rerender(scope)` con `scope` ∈ `'all'`/`'list'`/`'markers'`/`'plan'`/`'detail'`. Mai chiamare i singoli `render*()` a mano dopo una mutazione (ADR-005).

## Per chi prende in mano il repo dopo di noi

Comincia da:
1. `docs/architecture.md` — le 5 ADR che spiegano il "perché" del codice
2. `docs/api.md` — contratto delle Netlify Functions (request/response, error codes, rate limits)
3. `docs/operations.md` — runbook operativo: health check, logging, monitoring, env vars
4. `src/core/` + `src/server/` + `tests/` — la logica del prodotto, testata
5. `index.html` — la UI legacy che sta venendo modularizzata (strangler pattern in corso)
