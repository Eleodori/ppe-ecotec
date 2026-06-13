# Operations Runbook

Procedure operative per chi gestisce l'app in produzione. Aggiornare ad ogni
nuovo strumento di monitoring/alerting che colleghiamo.

## Health check

L'endpoint `/.netlify/functions/health` espone uno stato pubblico (no auth).

### Uso da uptime monitor esterno

Configurare un monitor (UptimeRobot, StatusCake, ecc.) per fare `GET` ogni 1-5
minuti su:

```
https://<deploy>.netlify.app/.netlify/functions/health
```

- **200 OK** → tutto a posto.
- **503 DEGRADED** → uno o più deps in errore. Il body contiene `{deps:{...}}` con il dettaglio.
- **Altro** → Netlify down / Function in crash. Alerta come un 503.

### Health "deep"

```
GET /.netlify/functions/health?deep=1
```

In più del check shallow, esegue:
- scrittura+lettura di un blob di test sul DAO (verifica Netlify Blobs raggiungibile);
- verifica della presenza della env `ORS_API_KEY` (solo configurata, NON chiama davvero ORS — eviterebbe quota inutile).

Usare per debug puntuale, NON per il monitor automatico (più lento, scrive su Blobs).

### Metriche per-route

```
GET /.netlify/functions/health?metrics=1
```

Risposta include `metrics: { "<METHOD> <PATH>": { count, statuses, p50ms, p95ms } }`.

**Limite noto**: le metriche sono **in-memory per istanza Function**. Netlify alloca N istanze in parallelo, ognuna ha le sue. Quando vediamo `count: 12` significa "12 richieste su questa istanza", non "totali del sito". Per metriche aggregate vere serve uno store centrale (futuro: adapter Datadog/CloudWatch nel reporter).

## Logging

Tutti i log strutturati passano per `src/core/reporter.js`. Adapter di default = `console` JSON. Netlify cattura `stdout/stderr` delle Functions per ~24h, consultabili in **Site Logs → Functions**.

Formato di una riga:

```json
{ "ts": 1718000000000, "level": "info", "message": "request",
  "ctx": { "method": "POST", "path": "/.netlify/functions/state-sync", "status": 200, "durationMs": 43 } }
```

Livelli usati:
- `info` → response 2xx (request log)
- `warn` → response 4xx (request log), cache miss/write fail, snapshot prune fail
- `error` → response 5xx (request log) + traceback completo (eccezioni non gestite)

Per filtrare i log degli errori in Netlify: ricerca testuale `"level":"error"`.

## Swappare il reporter

Quando si volesse Sentry/Datadog/CloudWatch:

1. Creare un adapter (es. `src/core/reporter-sentry.js`) che esporta `makeSentryReporter()` con la stessa interfaccia (`error/warn/info/debug`).
2. All'avvio delle Functions chiamare `setReporter(makeSentryReporter({ dsn: ... }))`.
3. Niente call-site da modificare: il reporter è centralizzato.

## Variabili d'ambiente

Da configurare in Netlify → Site configuration → Environment variables:

| Variabile | Obbligatoria | Default | Note |
|-----------|--------------|---------|------|
| `ORS_API_KEY` | sì per `distance-matrix` | — | OpenRouteService free tier basta (2000 req/giorno) |
| `COMMIT_REF` | no | auto da Netlify | Esposto da `/health` come `version` |
| `VAPID_PUBLIC_KEY` | sì per push notifications | — | Generata una volta sola (vedi sotto) |
| `VAPID_PRIVATE_KEY` | sì per push notifications | — | Segreta, mai esporre. In Netlify env vars |
| `VAPID_SUBJECT` | no | `mailto:noreply@example.com` | mailto:… o URL del sito, richiesto dallo standard Web Push |

### Setup Web Push (VAPID)

Generare la coppia di chiavi una volta sola:

```bash
npx web-push generate-vapid-keys
```

L'output dà `Public Key` e `Private Key`. Settarle in **Netlify → Site
configuration → Environment variables** come `VAPID_PUBLIC_KEY` e
`VAPID_PRIVATE_KEY`. Settare anche `VAPID_SUBJECT` con una mailto valida
(es. `mailto:admin@maritsrl.com`).

Senza le chiavi configurate: `GET /push-subscribe` ritorna
`{configured: false}` e l'app nasconde il toggle "Notifiche push" — non
crasha, la feature è semplicemente off.

## Rate limit dashboard

I bucket sono salvati nello store `rate-limit` di Netlify Blobs. Non c'è ancora
una UI di amministrazione; per resettare un bucket bloccato manualmente:

```bash
# In console Netlify → Site → Blobs → store "rate-limit"
# Cancellare la chiave `<scope>/<hash>` corrispondente all'IP da sbloccare.
```

Tabella dei limiti correnti in `docs/api.md`.

## Versioning

`COMMIT_REF` viene popolato automaticamente dal build Netlify con lo SHA del
commit. L'app client espone in `⋮ → Info` la versione `APP_VERSION` interna
(`2026-MM-DD.N`), bumpata manualmente. Le due servono cose diverse:
- `APP_VERSION` → usata dal cache-bust del browser (utenti) e dal version pin
  del backup userState
- `COMMIT_REF` → identificazione build server-side per il monitoring
