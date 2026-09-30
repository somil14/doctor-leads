/**
 * @module enrich
 * Contact enrichment: reads each practice's own website for published
 * phones and emails, cross-checks them against the Google listing and
 * scores how far each contact can be trusted.
 */

import pLimit from "p-limit";
import { extractEmails, extractPhones } from "./contactExtractor.js";
import { hostOf, siteKind } from "./siteFetcher.js";
import { emailDomain, emailType } from "./emailVerify.js";
import { phoneType } from "./phoneVerify.js";
import { phoneConfidence, emailConfidence } from "./confidence.js";

const EMAIL_TYPE_RANK = { named: 0, other: 1, role: 2 };

/**
 * @typedef {object} SiteContacts
 * @property {string[]} phones E.164 numbers found on the site.
 * @property {Array<{email: string, source: string}>} emails With the page each was first seen on.
 */

/**
 * Collect the contacts published across a site's pages.
 * @param {import("./siteFetcher.js").SitePage[]} pages
 * @returns {SiteContacts}
 */
export function contactsFromPages(pages) {
  const phones = [];
  const emails = [];
  for (const page of pages) {
    for (const phone of extractPhones(page.html)) {
      if (!phones.includes(phone)) phones.push(phone);
    }
    for (const email of extractEmails(page.html)) {
      if (!emails.some((e) => e.email === email)) emails.push({ email, source: page.url });
    }
  }
  return { phones, emails };
}

/**
 * Enrich one lead with the contacts found on its website.
 * @param {object} lead Lead with phone, phoneType and phoneSharedWith set.
 * @param {SiteContacts | null} site Null when the lead has no fetchable site.
 * @param {object} context
 * @param {boolean} context.siteShared The website is linked from several listings.
 * @param {(email: string) => Promise<"ok" | "no_mail_server" | "unknown">} context.checkMx
 * @param {string[]} [context.placeWords] Town and state names, which do not make an address "named".
 * @returns {Promise<object>} The lead plus contact, source and confidence fields.
 */
export async function enrichLead(lead, site, { siteShared, checkMx, placeWords = [] }) {
  const sitePhones = site?.phones ?? [];
  const out = { ...lead };

  if (out.phone) {
    out.phoneSource = sitePhones.includes(out.phone) ? "google+website" : "google";
  } else if (sitePhones.length > 0) {
    // Google has no number; take one from the practice's own site.
    out.phone = sitePhones.find((p) => phoneType(p) === "mobile") ?? sitePhones[0];
    out.phoneType = phoneType(out.phone);
    out.isMobile = out.phoneType === "mobile";
    out.phoneSource = "website";
  } else {
    out.phoneSource = "";
  }
  out.altPhones = sitePhones.filter((p) => p !== out.phone);
  out.phoneConfidence = phoneConfidence({
    ...out,
    siteShared,
    sitePhoneCount: sitePhones.length,
  });

  const siteHost = hostOf(out.website ?? "");
  const candidates = [];
  for (const { email, source } of site?.emails ?? []) {
    const mx = await checkMx(email);
    // A domain with no mail server cannot be a working address.
    if (mx === "no_mail_server") continue;
    candidates.push({ email, source, mx, type: emailType(email, out.name, placeWords) });
  }
  candidates.sort((a, b) => EMAIL_TYPE_RANK[a.type] - EMAIL_TYPE_RANK[b.type]);

  const best = candidates[0];
  out.email = best?.email ?? "";
  out.emailType = best?.type ?? "";
  out.emailSource = best?.source ?? "";
  out.emailConfidence = best
    ? emailConfidence({
        email: best.email,
        emailSource: best.source,
        mx: best.mx,
        emailType: best.type,
        domainMatchesSite: emailDomain(best.email) === siteHost,
        siteShared,
      })
    : "";
  out.altEmails = candidates.slice(1).map((c) => c.email);
  out.verifiedAt = "";
  out.consent = "";
  return out;
}

/**
 * Enrich every lead. Each distinct website is fetched once; sites are
 * fetched in parallel, pages within a site one at a time.
 * @param {object[]} leads
 * @param {object} deps
 * @param {((url: string) => Promise<import("./siteFetcher.js").SitePage[]>) | null} deps.fetchSite
 *   Null skips website fetching (cross-checks then use Google data only).
 * @param {(email: string) => Promise<"ok" | "no_mail_server" | "unknown">} deps.checkMx
 * @param {import("../config.js").SitesConfig} deps.sites
 * @param {string[]} [deps.placeWords] Town and state names.
 * @returns {Promise<object[]>}
 */
export async function enrichLeads(leads, { fetchSite, checkMx, sites, placeWords = [] }) {
  const hostCounts = new Map();
  for (const lead of leads) {
    if (siteKind(lead.website, sites.skipHosts) !== "own") continue;
    const host = hostOf(lead.website);
    hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
  }

  /** @type {Map<string, Promise<SiteContacts>>} */
  const byUrl = new Map();
  if (fetchSite) {
    const limit = pLimit(Math.max(1, sites.concurrency));
    // One chain per host keeps requests to the same site sequential.
    const hostChains = new Map();
    for (const lead of leads) {
      if (siteKind(lead.website, sites.skipHosts) !== "own" || byUrl.has(lead.website)) continue;
      const host = hostOf(lead.website);
      const previous = hostChains.get(host) ?? Promise.resolve();
      const job = previous.then(() =>
        limit(async () => contactsFromPages(await fetchSite(lead.website)))
      );
      hostChains.set(host, job.catch(() => {}));
      byUrl.set(lead.website, job);
    }
  }

  return Promise.all(
    leads.map(async (lead) => {
      const site = byUrl.has(lead.website) ? await byUrl.get(lead.website) : null;
      const siteShared = (hostCounts.get(hostOf(lead.website ?? "")) ?? 0) > 1;
      return enrichLead(lead, site, { siteShared, checkMx, placeWords });
    })
  );
}
