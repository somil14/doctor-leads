/**
 * @module classify
 * Keyword-based classification of lead records: specialty, exclusion of
 * non-doctor businesses, entity type and outreach priority.
 */

/** Specialty labels, in the order they are reported. */
export const SPECIALTIES = [
  "GP/Physician",
  "Pediatrics",
  "Gynecology",
  "Orthopedics",
  "ENT",
  "Dermatology",
  "Diabetology",
  "Cardiology",
  "Chest",
  "Dental",
  "Hospital/Nursing Home",
  "Alternative/Allied",
  "Unknown",
];

/**
 * Keyword rules, most specific first: "Dr. X Child Hospital" is Pediatrics,
 * "chest physician" is Chest, and only otherwise GP or Hospital.
 * @type {Array<[string, RegExp]>}
 */
const SPECIALTY_RULES = [
  // Homeopathy, ayurveda, physiotherapy and the like say what kind of
  // practice this is before any specialty does, so they are matched first.
  ["Alternative/Allied", /homo?eo|ayurved|\bunani\b|naturopath|acupressure|acupuncture|neurotherap|physiotherap|\bphysio\b|chandsi|da[wv]a ?khana|\byoga\b/i],
  ["Pediatrics", /pa?ediatric|\bchild|\bbaby|\bkids?\b|neonat|shishu|\bbal rog/i],
  ["Gynecology", /gyna?ec|\bgyne\b|obstetric|maternity|\bwom[ae]n|mahila|prasuti|stri rog|\bivf\b|fertility/i],
  ["Dental", /dental|dentist|orthodont|\bteeth\b|\btooth\b/i],
  ["Orthopedics", /ortho(?!dont)|\bbones?\b|\bjoints?\b|fracture|haddi|\bspine\b/i],
  ["ENT", /\bent\b|ear,? nose|otolaryng/i],
  ["Dermatology", /dermat|\bskin\b|cosmetolog|charm rog/i],
  ["Diabetology", /diabet|\bsugar\b|endocrin/i],
  ["Cardiology", /cardi(o|ac)|\bheart\b|hriday/i],
  ["Chest", /\bchest\b|pulmon|\blungs?\b|respirat|asthma|\btb\b/i],
  ["GP/Physician", /physician|general medicine|\bmbbs\b|general practi|family (doctor|clinic)/i],
  ["Hospital/Nursing Home", /hospital|nursing home|health cent(er|re)|medical college|\bphc\b|\bchc\b/i],
];

/** Places API types that reliably imply a specialty on their own. */
const STRONG_TYPE_SPECIALTY = {
  dentist: "Dental",
  dental_clinic: "Dental",
};

/**
 * Types used only as a last resort: Google tags many single-doctor clinics
 * in this region as "hospital", so the search terms are better evidence.
 */
const WEAK_TYPE_SPECIALTY = {
  hospital: "Hospital/Nursing Home",
  general_hospital: "Hospital/Nursing Home",
};

// "Dr" only counts at the start: "X Diagnostics (Dr. Y)" is still a lab.
const PROVIDER_RE = /^\s*dr\b|doctor|clinic|hospital|nursing home|physician/i;
const VET_RE = /veterinar|\bvet\b|\bpets?\b|animal|pashu/i;
const PHARMACY_RE = /pharmac|chemist|medical (store|hall|shop|agency)|medicos|drug ?(store|house)|\bdrugs\b|dawa/i;
// Collection-centre chains; "Dr Lal PathLabs" is a lab despite the "Dr".
const LAB_BRAND_RE = /lal path|thyrocare|metropolis|redcliffe|healthians|\bsrl\b/i;
const LAB_RE = /path ?labs?|janch|जाँच|जांच|collection cent(er|re)|blood test|patholog|diagnos|\blabs?\b|laborator|x-? ?ray|ultrasound|sonograph|scan cent(er|re)|imaging|\bct scan\b|\bmri\b/i;

/**
 * First specialty whose keywords match the text.
 * @param {string} text
 * @returns {string | null}
 */
export function matchSpecialty(text) {
  for (const [specialty, pattern] of SPECIALTY_RULES) {
    if (pattern.test(text)) return specialty;
  }
  return null;
}

/**
 * Why a record is not a doctor/clinic/hospital lead, or null if it is one.
 * Vets are always excluded. Pharmacies and labs are excluded only when
 * "pure": a name that starts with Dr. or says clinic/hospital is kept.
 * @param {{name: string, primaryType?: string, types?: string[]}} record
 * @returns {"veterinary" | "pharmacy" | "diagnostic_lab" | null}
 */
export function exclusionReason(record) {
  const name = record.name ?? "";
  const primaryType = record.primaryType ?? "";
  const types = record.types ?? [];

  if (
    primaryType === "veterinary_care" ||
    types.includes("veterinary_care") ||
    VET_RE.test(name)
  ) {
    return "veterinary";
  }
  if (LAB_BRAND_RE.test(name)) return "diagnostic_lab";
  if (PROVIDER_RE.test(name)) return null;
  if (primaryType === "pharmacy" || primaryType === "drugstore" || PHARMACY_RE.test(name)) {
    return "pharmacy";
  }
  if (primaryType === "medical_lab" || LAB_RE.test(name)) return "diagnostic_lab";
  return null;
}

/**
 * First specialty implied by the record's primaryType or types.
 * @param {{primaryType?: string, types?: string[]}} record
 * @param {Record<string, string>} mapping
 * @returns {string | null}
 */
function matchType(record, mapping) {
  for (const type of [record.primaryType, ...(record.types ?? [])]) {
    if (type && mapping[type]) return mapping[type];
  }
  return null;
}

/**
 * Classify a record's specialty. Evidence is used in decreasing order of
 * reliability: the display name, then unambiguous Places types (dentist),
 * then the search terms that returned the place (majority vote, since a
 * general hospital shows up for most specialist queries), then the
 * "hospital" type.
 * @param {{name: string, primaryType?: string, types?: string[], matchedTerms?: string[]}} record
 * @returns {string} One of {@link SPECIALTIES}.
 */
export function classifySpecialty(record) {
  const fromName = matchSpecialty(record.name ?? "");
  if (fromName) return fromName;

  const fromStrongType = matchType(record, STRONG_TYPE_SPECIALTY);
  if (fromStrongType) return fromStrongType;

  const votes = new Map();
  for (const term of record.matchedTerms ?? []) {
    const specialty = matchSpecialty(term);
    if (specialty) votes.set(specialty, (votes.get(specialty) ?? 0) + 1);
  }
  let winner = null;
  // Rule order breaks ties, so a specific specialty beats GP and Hospital.
  for (const [specialty] of SPECIALTY_RULES) {
    const count = votes.get(specialty) ?? 0;
    if (count > 0 && (winner === null || count > votes.get(winner))) winner = specialty;
  }
  return winner ?? matchType(record, WEAK_TYPE_SPECIALTY) ?? "Unknown";
}

/**
 * "individual_doctor" when the name starts with Dr./Dr, else "clinic_or_hospital".
 * @param {string} name
 * @returns {"individual_doctor" | "clinic_or_hospital"}
 */
export function detectEntityType(name) {
  return /^\s*dr\b/i.test(name ?? "") ? "individual_doctor" : "clinic_or_hospital";
}

const PRIORITY_A_SPECIALTIES = new Set(["GP/Physician", "Pediatrics", "Gynecology"]);

/**
 * Outreach priority: A for GP/Pediatrics/Gynecology with 20+ reviews,
 * B for anything with 5+ reviews, otherwise C.
 * @param {string} specialty
 * @param {number} reviewCount
 * @returns {"A" | "B" | "C"}
 */
export function computePriority(specialty, reviewCount) {
  if (PRIORITY_A_SPECIALTIES.has(specialty) && reviewCount >= 20) return "A";
  if (reviewCount >= 5) return "B";
  return "C";
}
