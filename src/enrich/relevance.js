/**
 * @module enrich/relevance
 * Relevance gate: drops listings that are not medical practices at all.
 * Text Search returns the odd interior decorator or laptop shop for a
 * query like "doctor in Koramangala".
 */

import { matchSpecialty } from "../classify.js";

/**
 * Places types that mark a medical practice. The generic "health" type is
 * left out on purpose: Google also puts it on houses and service centres.
 */
const MEDICAL_TYPES = new Set([
  "doctor",
  "hospital",
  "general_hospital",
  "medical_clinic",
  "medical_center",
  "dentist",
  "dental_clinic",
  "skin_care_clinic",
  "physiotherapist",
  "chiropractor",
  "wellness_center",
]);

const MEDICAL_NAME_RE =
  /^\s*dr\b|\bdr\.|doctor|clinic|hospital|nursing home|physician|surg|medical|health|physio|homeo|ayur|\beye\b|arogya|seva sadan|chikitsa|\bmbbs\b|डॉ/i;

/**
 * Why a record is not a medical lead, or null when it looks like one.
 * A record passes on either signal: a medical word in the name, or a
 * specific medical Places type.
 * @param {{name: string, primaryType?: string, types?: string[]}} record
 * @returns {"not_medical" | null}
 */
export function relevanceReason(record) {
  const name = record.name ?? "";
  if (MEDICAL_NAME_RE.test(name) || matchSpecialty(name)) return null;
  const types = [record.primaryType, ...(record.types ?? [])];
  if (types.some((type) => MEDICAL_TYPES.has(type))) return null;
  return "not_medical";
}
