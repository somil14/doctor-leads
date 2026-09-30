/**
 * @module dedupe
 * Merges duplicate lead records: first by place id, then by normalised
 * phone when the two listings are the same entity.
 */

/** @typedef {import("./normalize.js").LeadRecord} LeadRecord */

/** Words that say nothing about which practice a name refers to. */
const NAME_STOPWORDS = new Set([
  "dr", "doctor", "clinic", "clinics", "hospital", "hospitals", "nursing", "home",
  "centre", "center", "care", "health", "healthcare", "and", "the", "of", "pvt", "ltd",
]);

/**
 * Union of two string lists, preserving first-seen order.
 * @param {string[]} [a]
 * @param {string[]} [b]
 * @returns {string[]}
 */
function union(a = [], b = []) {
  return [...new Set([...a, ...b])];
}

/**
 * Distinguishing words of a name, lower-cased.
 * @param {string} name
 * @returns {Set<string>}
 */
export function nameTokens(name) {
  const words = String(name ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return new Set(words.filter((w) => !NAME_STOPWORDS.has(w)));
}

/**
 * Whether two listings look like the same practice, judged by name: at
 * least half of their distinguishing words are shared. "Kumar Clinic" and
 * "Dr. A Kumar" match; "Sunshine Hospital" and "Dr. Rahul Verma" do not.
 * @param {{name: string}} a
 * @param {{name: string}} b
 * @returns {boolean}
 */
export function sameEntity(a, b) {
  const ta = nameTokens(a.name);
  const tb = nameTokens(b.name);
  if (ta.size === 0 || tb.size === 0) {
    return String(a.name).trim().toLowerCase() === String(b.name).trim().toLowerCase();
  }
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / (ta.size + tb.size - shared) >= 0.5;
}

/**
 * Merge two records for the same entity. The one with the higher
 * reviewCount wins (the earlier one on a tie); fields it lacks are filled
 * from the other and matchedQueries/matchedTerms are unioned.
 * @param {LeadRecord} a
 * @param {LeadRecord} b
 * @returns {LeadRecord}
 */
export function mergeRecords(a, b) {
  const [winner, loser] = (b.reviewCount ?? 0) > (a.reviewCount ?? 0) ? [b, a] : [a, b];
  const merged = { ...winner };
  for (const [key, value] of Object.entries(loser)) {
    if (merged[key] === null || merged[key] === undefined || merged[key] === "") {
      merged[key] = value;
    }
  }
  if (!winner.phone && loser.phone) merged.isMobile = loser.isMobile;
  merged.matchedQueries = union(a.matchedQueries, b.matchedQueries);
  merged.matchedTerms = union(a.matchedTerms, b.matchedTerms);
  return merged;
}

/**
 * Dedupe by place id only.
 * @param {LeadRecord[]} records
 * @returns {LeadRecord[]}
 */
export function dedupeById(records) {
  /** @type {Map<string, LeadRecord>} */
  const byId = new Map();
  for (const record of records) {
    const existing = byId.get(record.id);
    byId.set(record.id, existing ? mergeRecords(existing, record) : record);
  }
  return [...byId.values()];
}

/**
 * Dedupe by place id (primary key), then by normalised phone (secondary).
 *
 * A shared phone alone does not prove a duplicate: a hospital and the
 * doctors who sit there often list the same reception number. Listings
 * with the same phone are merged only when `isSameEntity` says so; the
 * rest stay separate leads. Records without a phone are merged by id only.
 * @param {LeadRecord[]} records
 * @param {(a: LeadRecord, b: LeadRecord) => boolean} [isSameEntity]
 * @returns {LeadRecord[]}
 */
export function dedupe(records, isSameEntity = sameEntity) {
  /** @type {LeadRecord[]} */
  const out = [];
  /** @type {Map<string, number[]>} Indexes into `out` per phone. */
  const byPhone = new Map();

  for (const record of dedupeById(records)) {
    if (!record.phone) {
      out.push(record);
      continue;
    }
    const indexes = byPhone.get(record.phone) ?? [];
    const match = indexes.find((i) => isSameEntity(out[i], record));
    if (match === undefined) {
      byPhone.set(record.phone, [...indexes, out.length]);
      out.push(record);
    } else {
      out[match] = mergeRecords(out[match], record);
    }
  }
  return out;
}
