/**
 * @module enrich/emailVerify
 * Email checks: whether the domain can receive mail (MX lookup) and what
 * kind of address it is. No mail server is ever contacted.
 */

import { resolveMx, resolve4 } from "node:dns/promises";
import { nameTokens } from "../dedupe.js";

const ROLE_LOCALS = new Set([
  "info", "contact", "contactus", "admin", "support", "enquiry", "enquiries",
  "inquiry", "office", "reception", "hello", "mail", "care", "help", "sales",
  "appointment", "appointments", "hr", "career", "careers", "accounts", "billing",
  "webmaster", "feedback", "marketing", "principal", "director", "hospital", "clinic",
]);

const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "yahoo.in", "yahoo.co.in", "rediffmail.com",
  "outlook.com", "hotmail.com", "live.com", "icloud.com", "ymail.com", "protonmail.com",
]);

/** Words in a practice name that do not identify anyone in an address. */
const GENERIC_NAME_WORDS = new Set([
  "medical", "institute", "college", "dental", "child", "children", "multi",
  "speciality", "specialty", "memorial", "general", "physician", "surgeon",
  "orthopaedic", "orthopedic", "skin", "heart", "mbbs", "india", "bihar",
]);

/**
 * Domain part of an email, lower-cased.
 * @param {string} email
 * @returns {string}
 */
export function emailDomain(email) {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Whether an address is on a free webmail service.
 * @param {string} email
 * @returns {boolean}
 */
export function isFreemail(email) {
  return FREEMAIL_DOMAINS.has(emailDomain(email));
}

/**
 * Kind of address:
 * - "role": a shared inbox such as info@ or reception@
 * - "named": the local part contains a word from the lead's name
 * - "other": anything else
 * @param {string} email
 * @param {string} leadName
 * @param {string[]} [ignoreWords] Extra words that identify no one, e.g. town names.
 * @returns {"role" | "named" | "other"}
 */
export function emailType(email, leadName, ignoreWords = []) {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  if (ROLE_LOCALS.has(local.replace(/[^a-z]/g, ""))) return "role";
  const ignored = new Set(ignoreWords.flatMap((w) => w.toLowerCase().split(/\s+/)));
  const words = [...nameTokens(leadName)].filter(
    (w) => w.length >= 4 && /^[a-z]+$/.test(w) && !GENERIC_NAME_WORDS.has(w) && !ignored.has(w)
  );
  return words.some((w) => local.includes(w)) ? "named" : "other";
}

/**
 * Create a checker for whether a domain can receive mail. Results are
 * remembered per domain for the life of the process.
 * @param {object} [deps] Injectable DNS functions for tests.
 * @param {(domain: string) => Promise<Array<{exchange: string}>>} [deps.resolveMxImpl]
 * @param {(domain: string) => Promise<string[]>} [deps.resolve4Impl]
 * @returns {(email: string) => Promise<"ok" | "no_mail_server" | "unknown">}
 *   "unknown" means the lookup itself failed (no network, timeout).
 */
export function createMxChecker({ resolveMxImpl = resolveMx, resolve4Impl = resolve4 } = {}) {
  /** @type {Map<string, Promise<"ok" | "no_mail_server" | "unknown">>} */
  const cache = new Map();
  const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

  async function lookup(domain) {
    try {
      const records = await resolveMxImpl(domain);
      // A single "." exchange is a null MX: the domain accepts no mail.
      if (records.some((r) => r.exchange && r.exchange !== ".")) return "ok";
      return "no_mail_server";
    } catch (err) {
      if (!NOT_FOUND.has(err.code)) return "unknown";
    }
    // No MX record: mail falls back to the domain's address record.
    try {
      return (await resolve4Impl(domain)).length > 0 ? "ok" : "no_mail_server";
    } catch (err) {
      return NOT_FOUND.has(err.code) ? "no_mail_server" : "unknown";
    }
  }

  return (email) => {
    const domain = emailDomain(email);
    if (!cache.has(domain)) cache.set(domain, lookup(domain));
    return cache.get(domain);
  };
}
