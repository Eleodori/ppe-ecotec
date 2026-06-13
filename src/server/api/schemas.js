// @ts-check
/**
 * Schemi Zod per la validazione I/O delle Netlify Functions.
 * Un solo posto dove sono dichiarate le forme dei payload accettati.
 */
import { z } from 'zod';

export const codeSchema = z.string().regex(
  /^[A-Za-z0-9-]{6,40}$/,
  'Codice sync non valido (6-40 caratteri alfanumerici)'
);

export const dateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  'Data non valida (YYYY-MM-DD)'
);

// photoId = hash hex del contenuto compresso (sha-256 = 64 hex chars)
export const photoIdSchema = z.string().regex(
  /^[a-f0-9]{16,128}$/i,
  'photo id non valido'
);

// userState: oggetto con chiavi numeriche (pv) o riservate (__drawings, __dayPlan)
// Limite 2MB enforced a livello di route (controllo dopo JSON.stringify).
export const userStateSchema = z.record(z.string(), z.any());

// === Route-specific schemas ===

export const stateSyncGetQuery = z.object({
  code: codeSchema,
  snapshots: z.string().optional(),       // presenza = lista snapshot
  restore:   z.string().optional(),       // YYYY-MM-DD = restore
});

export const stateSyncPostBody = z.object({
  code: codeSchema,
  userState: userStateSchema,
  replace: z.boolean().optional(),         // true = sovrascrive senza merge
});

export const photoSyncGetQuery = z.object({
  code: codeSchema,
  id: photoIdSchema,
});

export const photoSyncPostBody = z.object({
  code: codeSchema,
  id: photoIdSchema,
  mime: z.string().optional(),
  b64: z.string().min(1, 'b64 mancante'),
});

export const photoSyncDeleteQuery = z.object({
  code: codeSchema,
  id: photoIdSchema,
});

const latLngSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

export const distanceMatrixBody = z.object({
  sources: z.array(latLngSchema).min(1).max(60),
  destinations: z.array(latLngSchema).min(1).max(60),
}).refine(
  d => d.sources.length * d.destinations.length <= 3500,
  { message: 'Troppi elementi (sources × destinations > 3500)' }
);
