/**
 * @module segment
 * Picks a subset of leads to work on (few reviews, no real website) and
 * lays it out as a call list for whoever is phoning the practices.
 */

import { verificationSheet } from "./enrich/verified.js";

/** Website statuses that count as "no good website". */
const WEAK_WEBSITE = new Set(["none", "platform_link", "free_site_builder", "not_loading"]);

/**
 * @typedef {object} SegmentFilter
 * @property {number} [reviewsUnder] Keep leads with fewer reviews than this.
 * @property {boolean} [weakWebsite] Keep leads with no website of their own
 *   that loads: none, a social or platform link, a free page builder, or a dead site.
 */

/**
 * Whether any segment filter is set.
 * @param {SegmentFilter} filter
 * @returns {boolean}
 */
export function hasSegment(filter) {
  return Number.isFinite(filter.reviewsUnder) || Boolean(filter.weakWebsite);
}

/**
 * Leads matching every filter that is set.
 * @param {object[]} leads Enriched leads.
 * @param {SegmentFilter} filter
 * @returns {object[]}
 */
export function selectSegment(leads, filter) {
  return leads.filter((lead) => {
    if (Number.isFinite(filter.reviewsUnder) && !(lead.reviewCount < filter.reviewsUnder)) {
      return false;
    }
    if (filter.weakWebsite && !WEAK_WEBSITE.has(lead.websiteStatus)) return false;
    return true;
  });
}

/**
 * WhatsApp click-to-chat link for a mobile number.
 * @param {{phone: string | null, isMobile: boolean}} lead
 * @returns {string} Empty for landlines and missing numbers.
 */
export function whatsappLink(lead) {
  return lead.phone && lead.isMobile ? `https://wa.me/${lead.phone.replace(/\D/g, "")}` : "";
}

/**
 * Rows of the call list: the segment with reachable leads first (mobile,
 * then landline, then no phone), most-reviewed first within each group.
 * Rows carry the same fill-in columns as the verification sheet, and
 * earlier verified rows are appended, so the filled list can be saved as
 * data/verified.csv without losing anything.
 * @param {object[]} segment Leads from {@link selectSegment}.
 * @param {Map<string, import("./enrich/verified.js").VerifiedRow>} verified
 * @returns {object[]}
 */
export function callListRows(segment, verified) {
  const reach = (lead) => (lead.phone ? (lead.isMobile ? 0 : 1) : 2);
  const ordered = [...segment].sort(
    (a, b) => reach(a) - reach(b) || b.reviewCount - a.reviewCount || a.name.localeCompare(b.name)
  );
  const byId = new Map(ordered.map((lead) => [lead.id, lead]));
  return verificationSheet(ordered, verified).map((row) => {
    const lead = byId.get(row.id);
    return lead
      ? {
          ...row,
          entityType: lead.entityType,
          address: lead.address,
          reviewCount: lead.reviewCount,
          phoneType: lead.phoneType,
          phoneSharedWith: lead.phoneSharedWith,
          whatsappLink: whatsappLink(lead),
          websiteStatus: lead.websiteStatus,
        }
      : row;
  });
}
