/**
 * @module enrich/phoneVerify
 * Phone checks that need no network: number validity and line type via
 * libphonenumber, and detection of numbers shared by several listings.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/** @typedef {"mobile" | "landline" | "toll_free" | "other" | "invalid" | ""} PhoneType */

const TYPE_LABELS = {
  MOBILE: "mobile",
  FIXED_LINE: "landline",
  FIXED_LINE_OR_MOBILE: "other",
  TOLL_FREE: "toll_free",
};

/**
 * Line type of an E.164 number according to the Indian numbering plan.
 * @param {string | null} e164
 * @returns {PhoneType} "" when there is no number, "invalid" when the
 *   number is not assigned to any range.
 */
export function phoneType(e164) {
  if (!e164) return "";
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed || !parsed.isValid()) return "invalid";
  return TYPE_LABELS[parsed.getType()] ?? "other";
}

/**
 * Add `phoneType` and `phoneSharedWith` to each record, and bring
 * `isMobile` in line with the numbering plan.
 *
 * `phoneSharedWith` is the number of other listings carrying the same
 * phone. Above zero it is most likely a reception or group number rather
 * than the doctor's own.
 * @template {{phone: string | null, isMobile: boolean}} T
 * @param {T[]} records Deduped records, before any exclusions.
 * @returns {Array<T & {phoneType: PhoneType, phoneSharedWith: number}>}
 */
export function annotatePhones(records) {
  const counts = new Map();
  for (const { phone } of records) {
    if (phone) counts.set(phone, (counts.get(phone) ?? 0) + 1);
  }
  return records.map((record) => {
    const type = phoneType(record.phone);
    return {
      ...record,
      phoneType: type,
      isMobile: type === "mobile",
      phoneSharedWith: record.phone ? counts.get(record.phone) - 1 : 0,
    };
  });
}
