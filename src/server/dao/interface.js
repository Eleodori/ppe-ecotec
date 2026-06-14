// @ts-check
/**
 * Data Access Layer — interfaccia pubblica del DAO.
 *
 * Le route delle Netlify Functions DEVONO usare solo i metodi dichiarati qui,
 * mai chiamare direttamente `getStore` di @netlify/blobs. Quando IP/Ecotec
 * decideranno di migrare ad AWS (DynamoDB, RDS, S3) basterà sostituire
 * l'implementazione (`dao/blobs.js` → `dao/dynamo.js`) senza toccare le route.
 *
 * Vedi docs/architecture.md ADR-003.
 *
 * I metodi sono progettati a livello di "operazione di business" (sync state,
 * leggi/scrivi snapshot, leggi/scrivi blob foto) — NON a livello di "leggi/
 * scrivi blob generici". Questo isola il dominio dal vendor.
 *
 * @typedef {Object} StateDoc
 * @property {Record<string, any>} userState  oggetto chiave=pv → entry
 * @property {number} syncedAt                timestamp ms ultimo sync server
 *
 * @typedef {Object} SnapshotInfo
 * @property {string} date  formato YYYY-MM-DD
 *
 * @typedef {Object} PhotoBlobMeta
 * @property {string} mime
 * @property {number} uploadedAt
 *
 * @typedef {Object} PushSubRecord
 * @property {string} deviceId
 * @property {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @property {string} [deviceLabel]
 * @property {number} createdAt
 *
 * @typedef {Object} PortalTokenEntry
 * @property {string} code          syncCode plaintext (è già il segreto del tenant)
 * @property {number} pvId
 * @property {object} snapshot      campi master del PV congelati (comune, prov, regione, indirizzo, name, ragSoc, lat, lng)
 * @property {number} createdAt
 *
 * @typedef {Object} Dao
 *
 * @property {(code: string) => Promise<StateDoc|null>} stateGet
 *           Carica lo state corrente per un codice sync. null se mai pushato.
 *
 * @property {(code: string, doc: StateDoc) => Promise<void>} stateSet
 *           Sovrascrive lo state corrente (idempotente, last-write-wins
 *           gestito a livello applicativo, non qui).
 *
 * @property {(code: string, date: string, doc: StateDoc) => Promise<void>} snapshotSet
 *           Salva lo snapshot di quella data (sovrascrive se esiste già).
 *
 * @property {(code: string, date: string) => Promise<StateDoc|null>} snapshotGet
 *           Recupera lo snapshot di una data, null se non esiste.
 *
 * @property {(code: string) => Promise<SnapshotInfo[]>} snapshotList
 *           Elenco snapshot disponibili per quel codice (ordinati per data desc).
 *
 * @property {(code: string, beforeDate: string) => Promise<number>} snapshotPrune
 *           Cancella snapshot più vecchi della data data. Ritorna # cancellati.
 *
 * @property {(code: string, photoId: string) => Promise<ArrayBuffer|null>} photoGet
 *           Recupera il blob della foto. null se non trovata.
 *
 * @property {(code: string, photoId: string, data: Buffer, meta: PhotoBlobMeta) => Promise<void>} photoSet
 *           Salva il blob della foto. Idempotente sul photoId (è già un hash del contenuto).
 *
 * @property {(code: string, photoId: string) => Promise<void>} photoDelete
 *           Cancella il blob della foto.
 *
 * @property {(payload: object) => Promise<object|null>} distanceCacheGet
 *           Cache dei risultati di OpenRouteService Matrix. Chiave = hash del payload.
 *
 * @property {(payload: object, result: object) => Promise<void>} distanceCacheSet
 *           Memorizza il risultato di una chiamata ORS.
 *
 * @property {(code: string, deviceId: string, record: PushSubRecord) => Promise<void>} pushSubAdd
 *           Registra/aggiorna la subscription Web Push per un device.
 *
 * @property {(code: string) => Promise<PushSubRecord[]>} pushSubList
 *           Elenco subscription registrate sul codice sync.
 *
 * @property {(code: string, deviceId: string) => Promise<void>} pushSubRemove
 *           Rimuove la subscription di un device.
 *
 * @property {(token: string, entry: PortalTokenEntry) => Promise<void>} portalTokenSet
 *           Indicizza un token portale → {code, pvId, snapshot}. Idempotente.
 *
 * @property {(token: string) => Promise<PortalTokenEntry|null>} portalTokenGet
 *           Lookup di un token (anonimo, opaco). null se non esiste.
 *
 * @property {(token: string) => Promise<void>} portalTokenDelete
 *           Revoca il token. Silent se non esiste.
 */

// Nessun export: questo file è puro JSDoc per il typecheck. Le implementazioni
// importano i tipi via @typedef referenziando il path.
export {};
