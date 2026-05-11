# PEE Field

App per il tracciamento on-the-road dei PV Iplanet (Progetto PEE - Marit).

## Deploy rapido su Netlify

1. Vai su https://app.netlify.com/drop
2. Trascina la cartella `deploy/` (intera) nell'area di drop
3. Ottieni un URL pubblico tipo `https://random-name-12345.netlify.app`
4. Su Netlify puoi cambiare il sottodominio in qualcosa di memorabile (es. `peefield.netlify.app`)

## Aggiungere all'home del telefono (PWA)

1. Apri l'URL su Safari (iOS) o Chrome (Android)
2. **iOS**: Condividi → "Aggiungi a Home" → diventa un'icona come un'app
3. **Android**: menu (⋮) → "Aggiungi a schermata Home"

Una volta installata funziona anche offline (i tile della mappa restano in cache).

## Aggiornamenti

Per aggiornare l'app (es. nuovi PV o fix), basta ri-trascinare la cartella su Netlify dallo stesso URL "site overview" → "Deploys" → drag-and-drop nuovi file.

## Struttura

- `index.html` — app completa, dati PV embedded
- `manifest.json` — metadata PWA
- `sw.js` — service worker per offline
- `favicon.svg`, `icon-*.png` — icone

## Backup dei dati di campo

L'app salva fatto/note nel browser locale. Esporta JSON dal menu (⋮) regolarmente!
