/**
 * @module normalize
 * Turns raw Places API objects into flat lead records: status/district
 * filtering, phone normalisation and town extraction.
 */

/**
 * @typedef {object} LeadRecord
 * @property {string} id Google place id.
 * @property {string} name
 * @property {string} address
 * @property {string | null} phone E.164 (+91XXXXXXXXXX) or null.
 * @property {boolean} isMobile
 * @property {string} website
 * @property {number | null} rating
 * @property {number} reviewCount
 * @property {number | null} lat
 * @property {number | null} lng
 * @property {string} mapsUrl
 * @property {string[]} types
 * @property {string} primaryType
 * @property {string[]} matchedQueries Full query texts that returned this place.
 * @property {string[]} matchedTerms Search terms that returned this place.
 * @property {string} searchTown Town whose search first returned this place.
 * @property {string} fetchedAt ISO timestamp.
 */

const MOBILE_RE = /^\+91[6-9]\d{9}$/;

/**
 * Normalise an Indian phone number to E.164.
 * @param {string | null | undefined} raw e.g. "098765 43210", "+91 98765 43210".
 * @returns {string | null} "+91XXXXXXXXXX", or null when it is not a
 *   10-digit Indian national number (toll-free, short codes, foreign numbers).
 */
export function normalizePhone(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  let digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) {
    if (!digits.startsWith("91")) return null;
    digits = digits.slice(2);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  }
  digits = digits.replace(/^0+/, "");
  return /^[1-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/**
 * Whether a normalised number is a mobile.
 *
 * Mobiles start with +91[6-9], but so do landlines in many areas: Bengaluru
 * numbers begin 080, and several STD codes begin with 6 or 7. Google
 * formats mobiles as two 5-digit groups ("98765 43210") and landlines as
 * STD code + subscriber number ("80 2345 6789"), so when the
 * raw formatting is available it is used to rule landlines out.
 * @param {string | null} e164 Output of {@link normalizePhone}.
 * @param {string | null} [raw] The number as formatted by the API.
 * @returns {boolean}
 */
export function isMobileNumber(e164, raw = null) {
  if (!e164 || !MOBILE_RE.test(e164)) return false;
  if (!raw) return true;
  const groups = String(raw)
    .trim()
    .replace(/^\+91/, "")
    .trim()
    .replace(/^0/, "")
    .split(/[\s-]+/)
    .filter(Boolean);
  if (groups.length > 1 && groups[0].length !== 5) return false;
  return true;
}

/**
 * Names a town can appear under in an address: the town itself plus aliases.
 * @param {string} town
 * @param {Record<string, string[]>} aliases
 * @returns {string[]} Lower-cased spellings.
 */
function spellings(town, aliases) {
  return [town, ...(aliases[town] ?? [])].map((s) => s.toLowerCase());
}

/**
 * @typedef {object} AreaRules
 * @property {string[]} allowedDistricts
 * @property {string[]} [towns]
 * @property {Record<string, string[]>} [townAliases]
 * @property {string[]} [allowedPinPrefixes] Accepted together with a listed town.
 * @property {string[]} [areaPinPrefixes] Accepted on their own.
 */

/**
 * Whether an address is inside the target area. It is when it names an
 * allowed district, when its PIN code starts with an area prefix, or when
 * it names a listed town (any spelling) and its PIN code starts with an
 * allowed prefix. Google leaves the district out
 * of some addresses ("4th Block, Koramangala 560034"); the PIN check keeps
 * same-named towns in other districts out.
 * @param {string} address
 * @param {AreaRules} rules
 * @returns {boolean}
 */
export function inTargetArea(address, rules) {
  const lower = String(address ?? "").toLowerCase();
  if (rules.allowedDistricts.some((d) => lower.includes(d.toLowerCase()))) return true;

  const pin = lower.match(/\b\d{6}\b/)?.[0];
  if (!pin) return false;
  if ((rules.areaPinPrefixes ?? []).some((p) => pin.startsWith(p))) return true;
  if (!(rules.allowedPinPrefixes ?? []).some((p) => pin.startsWith(p))) return false;
  return (rules.towns ?? []).some((town) =>
    spellings(town, rules.townAliases ?? {}).some((name) => lower.includes(name))
  );
}

/**
 * Reason a place fails the status/area filter, or null if it passes.
 * @param {object} place Raw API place.
 * @param {AreaRules} rules
 * @returns {"not_operational" | "outside_allowed_districts" | null}
 */
export function filterReason(place, rules) {
  if (place.businessStatus !== "OPERATIONAL") return "not_operational";
  return inTargetArea(place.formattedAddress, rules) ? null : "outside_allowed_districts";
}

/**
 * Flatten a raw API place into a lead record.
 * @param {object} place Raw API place.
 * @param {{textQuery: string, term: string, town?: string, fetchedAt: string}} meta
 * @returns {LeadRecord}
 */
export function toRecord(place, { textQuery, term, town = "", fetchedAt }) {
  const international = place.internationalPhoneNumber ?? null;
  const national = place.nationalPhoneNumber ?? null;
  const phone = normalizePhone(international) ?? normalizePhone(national);
  return {
    id: place.id,
    name: place.displayName?.text ?? "",
    address: place.formattedAddress ?? "",
    phone,
    isMobile: isMobileNumber(phone, international ?? national),
    website: place.websiteUri ?? "",
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? 0,
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    mapsUrl: place.googleMapsUri ?? "",
    types: place.types ?? [],
    primaryType: place.primaryType ?? "",
    matchedQueries: [textQuery],
    matchedTerms: term ? [term] : [],
    searchTown: town,
    fetchedAt,
  };
}

/**
 * Extract the town from an address by matching against the towns list.
 *
 * A district name can double as a town name and then appears in most
 * addresses ("..., Anekal, Bengaluru, Karnataka 562106"), and town names
 * also appear inside road names ("Whitefield Main Rd, Mahadevapura"). So a
 * town that is a whole comma-separated segment beats one that is merely
 * mentioned, and a non-district town beats a district name. Ties go to the
 * rightmost match.
 * @param {string} address
 * @param {string[]} towns
 * @param {string[]} [districts] Town names that are also district names.
 * @param {Record<string, string[]>} [aliases] Alternate spellings per town.
 * @returns {string} A town from the list, or "Unknown".
 */
export function extractTown(address, towns, districts = [], aliases = {}) {
  const lower = String(address ?? "").toLowerCase();
  // Drop PIN codes so "Bengaluru 560034" still counts as a whole segment.
  const segments = lower.split(",").map((s) => s.replace(/\d+/g, "").trim());
  const districtSet = new Set(districts.map((d) => d.toLowerCase()));

  let best = null;
  for (const town of towns) {
    const names = spellings(town, aliases);
    const position = Math.max(...names.map((name) => lower.lastIndexOf(name)));
    if (position === -1) continue;
    const candidate = {
      town,
      exact: names.some((name) => segments.includes(name)) ? 1 : 0,
      specific: districtSet.has(town.toLowerCase()) ? 0 : 1,
      position,
    };
    if (
      best === null ||
      candidate.exact > best.exact ||
      (candidate.exact === best.exact && candidate.specific > best.specific) ||
      (candidate.exact === best.exact &&
        candidate.specific === best.specific &&
        candidate.position > best.position)
    ) {
      best = candidate;
    }
  }
  return best ? best.town : "Unknown";
}
