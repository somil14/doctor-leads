/**
 * @module enrich/confidence
 * Turns the evidence gathered for a phone or email into a confidence
 * level, so a rep knows which contacts to trust and which to check first.
 *
 * Levels: "verified" (confirmed by a person), "high", "medium", "low",
 * and "" when there is no value.
 */

/** @typedef {"verified" | "high" | "medium" | "low" | ""} Confidence */

/**
 * Confidence in a lead's phone number.
 * @param {object} evidence
 * @param {string | null} evidence.phone
 * @param {string} evidence.phoneType Output of phoneType().
 * @param {string} evidence.phoneSource "google", "google+website", "website" or "verified".
 * @param {number} evidence.phoneSharedWith Other listings with the same number.
 * @param {number} evidence.reviewCount
 * @param {boolean} [evidence.siteShared] The website is linked from several listings.
 * @param {number} [evidence.sitePhoneCount] Phone numbers found on the website.
 * @returns {Confidence}
 */
export function phoneConfidence({
  phone,
  phoneType,
  phoneSource,
  phoneSharedWith,
  reviewCount,
  siteShared = false,
  sitePhoneCount = 0,
}) {
  if (!phone) return "";
  if (phoneSource === "verified") return "verified";
  if (phoneType === "invalid") return "low";
  // Several listings on one number: a reception or group line.
  if (phoneSharedWith > 0) return "low";

  if (phoneSource === "google+website") return siteShared ? "medium" : "high";
  if (phoneSource === "website") {
    return !siteShared && sitePhoneCount <= 2 ? "medium" : "low";
  }
  // Google only. The practice's own site listing different numbers is a
  // conflict; a listing with almost no reviews is thin evidence.
  if (sitePhoneCount > 0 && !siteShared) return "low";
  return reviewCount >= 5 ? "medium" : "low";
}

/**
 * Confidence in a lead's email address.
 * @param {object} evidence
 * @param {string} evidence.email
 * @param {string} evidence.emailSource URL it was found on, or "verified".
 * @param {"ok" | "no_mail_server" | "unknown"} evidence.mx
 * @param {"role" | "named" | "other"} evidence.emailType
 * @param {boolean} evidence.domainMatchesSite The address is on the website's own domain.
 * @param {boolean} [evidence.siteShared] The website is linked from several listings.
 * @returns {Confidence}
 */
export function emailConfidence({
  email,
  emailSource,
  mx,
  emailType,
  domainMatchesSite,
  siteShared = false,
}) {
  if (!email) return "";
  if (emailSource === "verified") return "verified";
  if (mx !== "ok") return "low";
  if (siteShared && emailType !== "named") return "low";
  return domainMatchesSite || emailType === "named" ? "high" : "medium";
}
