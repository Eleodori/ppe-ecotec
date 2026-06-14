# API Reference

Documentazione delle Netlify Functions esposte dalla webapp. Per le decisioni di
architettura vedi `architecture.md` (ADR-001…005).

Convenzioni comuni:
- **Base URL**: `/.netlify/functions/<nome>`
- **Content-Type**: `application/json` per body e response (eccezione: foto in `image/jpeg`)
- **CORS**: tutte le risposte includono `Access-Control-Allow-Origin: *`
- **Rate limit**: ogni endpoint ha un limite per IP (vedi tabella in fondo). Quando bloccato risponde **429** con header `Retry-After: <secondi>` e body `{ error: "RATE_LIMITED", message }`.
- **Errori**: shape uniforme `{ error: "CODE_MACCHINA", message: "...", detail?: {...} }`.

---

## `POST /distance-matrix`

Proxy a OpenRouteService Matrix con cache server-side. Usato dall'app per stimare i chilometri stradali fra i PV (cluster + ottimizzazione giro).

**Body:**
```json
{
  "sources":      [{ "lat": 45.4642, "lng": 9.19 }, ...],
  "destinations": [{ "lat": 41.9028, "lng": 12.4964 }, ...]
}
```

Vincoli:
- `sources` e `destinations`: array di 1–60 punti con `lat ∈ [-90,90]`, `lng ∈ [-180,180]`
- `sources.length × destinations.length ≤ 3500` (limite ORS)

**Response 200:**
```json
{ "distances": [[m, m, ...]], "durations": [[s, s, ...]], "cached": true }
```
`cached: true` indica risposta da cache (saltata la chiamata ORS).

**Errori:**
| Status | error | Quando |
|--------|-------|--------|
| 400 | `INVALID_BODY` | Body malformato o validazione Zod fallita (`detail` per campo) |
| 429 | `RATE_LIMITED` | Più di 20 req in burst o > ~10/min da quell'IP |
| 429 | `ORS_QUOTA` | Quota ORS giornaliera/minutuale esaurita (a monte) |
| 500 | `ORS_MISSING_KEY` | `ORS_API_KEY` non configurata su Netlify |
| 500 | `ORS_ERROR` | ORS ha risposto con un errore |
| 503 | `ORS_NETWORK` | Rete verso ORS non raggiungibile |

---

## `state-sync` — sync userState multi-dispositivo

### `GET ?code=XXXX`

Carica lo stato corrente per quel codice sync.

**Response 200:**
```json
{ "userState": { "47574": { "updatedAt": 1718, ... }, ... }, "syncedAt": 1718000000 }
```
Se nessuno ha mai pushato: `{ userState: null, syncedAt: null }`.

### `GET ?code=XXXX&snapshots=1`

Elenco degli snapshot giornalieri disponibili (ultimi 30).

**Response 200:**
```json
{ "snapshots": [{ "date": "2026-06-12" }, { "date": "2026-06-11" }, ...] }
```

### `GET ?code=XXXX&restore=2026-06-12`

Recupera il contenuto di uno snapshot. **Non sostituisce** lo stato corrente — è l'app che decide se applicarlo (re-push con `replace: true`).

**Response 200:** stesso shape di `GET ?code=`.
**404** `SNAPSHOT_NOT_FOUND` se la data non esiste.

### `POST` — push state

**Body:**
```json
{
  "code": "ABCD1234",
  "userState": { "47574": { "updatedAt": 1718000000, "soprFatto": true }, ... },
  "replace": false
}
```

Comportamento:
- Default (`replace: false`): merge **last-write-wins** per-PV con lo stato server. Le foto in `entry.photos[]` vengono **unite** invece di sovrascritte (tombstone-aware: cancellazioni propagano).
- `replace: true`: sostituisce lo stato server senza merge. Usato dopo un restore di snapshot.

Ad ogni POST viene anche aggiornato lo **snapshot del giorno corrente** (sovrascritto se esiste già). Pulizia probabilistica (~5% delle volte) cancella snapshot più vecchi di 30 giorni.

**Response 200:** lo stato fuso (ciò che il prossimo GET ritornerebbe).

**Errori:**
| Status | error | |
|--------|-------|---|
| 400 | `INVALID_BODY` | code non valido (regex `^[A-Za-z0-9-]{6,40}$`) o userState non oggetto |
| 413 | `TOO_LARGE` | `userState` JSON > 2 MB |
| 429 | `RATE_LIMITED` | > 60 burst o > 30/min |

---

## `photo-sync` — blob foto PV

### `GET ?code=XXXX&id=HASH`

Recupera il blob della foto (compressa lato client a 1280px JPEG 0.7). `id` = sha-256 hex del contenuto.

**Response 200:** binario `image/jpeg`, `Cache-Control: private, max-age=86400`.
**404:** body vuoto se non esiste.

### `POST` — upload foto

**Body:**
```json
{
  "code": "ABCD1234",
  "id":   "<sha-256 hex 64 char>",
  "mime": "image/jpeg",
  "b64":  "<base64 del blob compresso>"
}
```

Idempotente sull'`id` (stessa foto su 2 dispositivi = stesso blob = nessun duplicato).

**Response 200:** `{ ok: true, id, size: <bytes salvati> }`.

**Errori:**
| Status | error | |
|--------|-------|---|
| 400 | `INVALID_BODY` | id non hex, code non valido, b64 vuota |
| 413 | `TOO_LARGE` | b64 oltre 2 MB (compressa) |
| 429 | `RATE_LIMITED` | > 30 burst o > 20/min |

### `DELETE ?code=XXXX&id=HASH`

Cancella il blob. **204** sempre, anche se l'id non esiste (idempotente).

---

## `/.netlify/functions/push-subscribe` — Web Push subscription

Registrazione/revoca subscription Web Push per device, lette poi da
`state-sync` per inviare notifiche cross-device su cambio di stato PV.
Richiede `VAPID_*` env vars: senza, `GET` ritorna `configured: false` e
`POST` risponde `503 PUSH_NOT_CONFIGURED`.

### `GET`

Anonimo. Ritorna:
```json
{ "configured": true, "publicKey": "BNh…" }
```
Il client usa `publicKey` come `applicationServerKey` per `PushManager.subscribe()`.
Quando `configured: false` il client nasconde il toggle "Notifiche push".

### `POST`

```json
{
  "code": "ABCD1234",
  "deviceId": "uuid-v4-lowercase-hex",
  "deviceLabel": "iPhone Michele",
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/…",
    "keys": { "p256dh": "…", "auth": "…" }
  }
}
```

Risposta **200** `{ ok: true }`. Idempotente per `deviceId`: una seconda POST
con lo stesso device aggiorna la subscription (utile dopo rotazione delle
chiavi push del browser).

Errori:
- **400 INVALID_BODY**: schema Zod fallito (endpoint non-URL, keys mancanti, deviceId < 8 chars, code malformato)
- **429 RATE_LIMITED**: troppe richieste (vedi tabella rate limits)
- **503 PUSH_NOT_CONFIGURED**: VAPID env vars assenti sul server

### `DELETE ?code=XXXX&deviceId=YYY`

Revoca la subscription. **204** sempre (idempotente).

---

## Eventi push da state-sync

`POST /state-sync` accetta opzionalmente `deviceId` ed `events`:

```json
{
  "code": "ABCD1234",
  "userState": { … },
  "deviceId": "uuid-…",
  "events": [
    {
      "pv": 47638,
      "type": "state-change",
      "fromStatus": "inst-todo",
      "toStatus": "completato",
      "deviceLabel": "iPhone Michele",
      "ts": 1718000000000
    }
  ]
}
```

Dopo il merge, il server itera `events` e invia una notifica Web Push a tutte
le subscription registrate sul codice **tranne** quella corrispondente al
`deviceId` originante (no self-notify). Errori del broadcast sono swallowed:
il sync ritorna 200 anche se Web Push è down.

Limite: max **50** eventi per richiesta. Oltre, Zod risponde 400.

---

## `/.netlify/functions/portal-token` — Link gestori PV

Genera e revoca token opachi che danno accesso read-only a un PV tramite la
pagina `/portal.html`. Authz pre-Fase 4: chiunque possieda il syncCode
(`code` nel body) può generare link per quel tenant.

### `POST`

```json
{
  "code": "ABCD1234",
  "pvId": 47638,
  "snapshot": {
    "comune": "Acerra",
    "prov": "NA",
    "regione": "Campania",
    "indirizzo": "Via Roma 12",
    "ragSoc": "Tabacchi Esempio Srl",
    "lat": 40.94,
    "lng": 14.37
  }
}
```

Risposta **200** `{ token: "<32-hex-chars>" }`. Il client costruisce l'URL
come `${origin}/portal.html?t=${token}` e lo condivide via WhatsApp/email/SMS.
Lo `snapshot` viene congelato nell'entry così il portale resta navigabile
anche se l'anagrafica del PV cambia.

Errori: **400 INVALID_BODY** (Zod), **429 RATE_LIMITED**.

### `DELETE ?code=XXXX&token=YYY`

Revoca il token. **204** sempre (idempotente). **403 FORBIDDEN** se il
token esiste ma appartiene a un altro syncCode.

---

## `/.netlify/functions/pv-public` — Vista pubblica del portale

Endpoint **anonimo** consumato da `portal.html`. Niente codice nel request:
il token nell'URL è l'unica credenziale necessaria.

### `GET ?t=TOKEN`

Risposta **200**:

```json
{
  "pv": 47638,
  "snapshot": { "comune": "...", "regione": "...", "indirizzo": "..." },
  "status": "installed",
  "statusLabel": "Installazione completata",
  "statusTone": "done",
  "milestones": [
    { "type": "sopralluogo", "label": "Sopralluogo eseguito", "ts": 1718000000000 },
    { "type": "planimetria", "label": "Planimetria ricevuta", "ts": 1718800000000 },
    { "type": "installazione", "label": "Installazione completata", "ts": 1719200000000 }
  ],
  "createdAt": 1717000000000,
  "syncedAt": 1719300000000
}
```

Status enum: `unknown | sopr_done | planim_received | installed | suspended`.
Toni UI: `pending | ok | ready | done`.

Lo status NON usa il dataset master: deriva esclusivamente dai timestamp e
override presenti in userState. Cioè il portale mostra **solo eventi
positivi che il crew ha attivamente dichiarato**, mai inferenze ottimistiche
("sopr-todo" dal master).

Errori: **400 INVALID_QUERY** (token malformato), **404 NOT_FOUND** (token
sconosciuto/scaduto — risposta generica, non confermiamo neanche se la
sintassi fosse valida), **429 RATE_LIMITED**.

---

## Rate limits in sintesi

| Endpoint | Burst | Refill | Razionale |
|----------|-------|--------|-----------|
| `POST /distance-matrix` | 20 | 10/min | Quota ORS reale (2000/giorno) |
| `GET/POST /state-sync` | 60 | 30/min | Anti-DDoS, traffico utente reale ~10/min |
| `POST/DELETE /photo-sync` | 30 | 20/min | Scrive storage |
| `GET /photo-sync` | 80 | 60/min | Read cheap |
| `POST/DELETE /push-subscribe` | 20 | 10/min | Scrive storage |
| `POST/DELETE /portal-token` | 20 | 10/min | Scrive storage |
| `GET /pv-public` | 30 | 20/min | Pubblica anonima, anti-enumerazione |

Bucket per `(scope, IP)`. TTL bucket dimenticato: 1 ora.

---

## Schema dati

Tutti gli schemi sono in `src/server/api/schemas.js` (Zod). Il client può importarli per validazione preventiva, ma il server li riesegue sempre (zero-trust).

Lo `userState` ha questa struttura logica (chiavi):
- `<pv_numero>` → entry per quel PV (timestamp, override, note, photos[])
- `__drawings` → tratti disegnati sulla mappa
- `__dayPlan` → piano giornata corrente

Le chiavi `__*` sono "riservate" e non rappresentano PV.
